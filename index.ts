/**
 * pi-token-rate
 *
 * Shows output-token throughput for the whole session on one adaptive line:
 *
 *   ⚡ ▂▄▆█▆▄▂ ~190 tok/s · 6.4s 1.2k tok · ttft 0.7s · avg 134 tok/s · peak 249 tok/s
 *
 * The line sits above or below the editor, whichever the user picks, and drops
 * detail from the right as the terminal narrows. One session-continuous model
 * feeds it, so nothing restarts at a message or tool boundary: a tool call pauses
 * generation instead of clearing the trace or resetting the number.
 *
 * Live numbers are estimated from streamed deltas (pi's 4-characters-per-token
 * heuristic) because providers only report `usage.output` after the stream ends.
 * The estimate is calibrated against every provider-reported message, and
 * estimated values are shown with a `~` prefix.
 *
 * Every measured message is appended to the session, so statistics cover the
 * whole session across `/reload`, `/resume`, forks, and branch switches.
 *
 * pi summarizes in two places — `/compact` and the summary offered when `/tree`
 * leaves a branch — and both call the model outside the agent loop, so nothing
 * streams and no rate can be watched. Their wait is timed and their output
 * counted, but the window measures prefill and queueing rather than generation,
 * so they are reported on their own row and kept out of every rate.
 *
 * Subagent children (pi-subagents) stream to their own sessions, so their
 * output never reaches this session's events either. What is shown instead is
 * what pi-subagents exposes on the process event bus: the accounting of every
 * finished child, read at turn boundaries, combined with a live read of the
 * tokens each running child has produced — the same status its own widgets
 * draw, taken while children run. Both land on a segment of their own, never
 * inside a rate, for the same reason as a summary.
 *
 * Commands, with the default bracketed:
 *   /token-rate                        toggle the display
 *   /token-rate on|off                 enable or disable it
 *   /token-rate position [above]|below where the line sits
 *   /token-rate detail minimal|compact|[full]  how much to show
 *   /token-rate tick 250ms|500ms|1s|[2s]       width of one trace bar
 *   /token-rate window 8s|16s|[32s]|60s       time the trace covers
 *   /token-rate stats                  show detailed session statistics
 *   /token-rate reset                  clear statistics for this run
 *   /token-rate help                   list every option with the current state
 */

import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";

import {
	type ChildUsageEntry,
	type CostChildUsage,
	type MessageRecord,
	mergeChildUsage,
	SessionRateModel,
	type SummaryKind,
} from "./metrics.ts";
import { DETAIL_LEVELS, type DetailLevel, RateView, type StyleFn, visibleWidth } from "./rate-view.ts";

/** Entry type for the rate records appended to the session. */
const RECORD_ENTRY_TYPE = "token-rate";

/** Entry type for the display preferences, so they survive a reload. */
const PREFS_ENTRY_TYPE = "token-rate-prefs";

const WIDGET_KEY = "token-rate-spark";

/** Minimum interval between renders while streaming. */
const RENDER_INTERVAL_MS = 80;

/** pi-subagents' in-process RPC channels, used to read child-subagent usage. */
const SUBAGENT_RPC_READY = "subagents:rpc:v1:ready";
const SUBAGENT_RPC_REQUEST = "subagents:rpc:v1:request";
const subagentRpcReply = (requestId: string) => `subagents:rpc:v1:reply:${requestId}`;

/**
 * Longest wait for a cost reply before the request is given up as unanswered.
 *
 * The report walks session entries and run artifacts on disk, so the wait is
 * generous rather than fast; an unanswered request costs nothing but a timer,
 * because the next turn boundary asks again.
 */
const COST_TIMEOUT_MS = 3000;

/** pi-subagents' in-process notifications about async runs, used as poll triggers. */
const SUBAGENT_ASYNC_STARTED = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE = "subagent:async-complete";

/**
 * Interval between live child-usage reads while children are running.
 *
 * A child's tokens move once per assistant turn, seconds apart at the fastest,
 * so a two-second read is as live as the data can be, and it costs one
 * in-process status request against the projection pi-subagents keeps for its
 * own widgets — never the session-walking cost report, whose contract says
 * turn boundaries only.
 */
const LIVE_POLL_MS = 2000;

/** Longest wait for a status reply before the read is given up as unanswered. */
const STATUS_TIMEOUT_MS = 3000;

/**
 * Fleet rows pi-subagents names after the run mode rather than an agent. Such
 * a row's tokens aggregate the whole run — finished children included — which
 * the cost report already counts, so adding it live would count those children
 * twice. Per-child rows and single runs carry a real agent name instead.
 */
const AGGREGATE_FLEET_AGENTS = new Set(["workflow", "chain", "parallel"]);

/** Run and step states that mean the child is still producing, or about to. */
const ACTIVE_RUN_STATES = new Set(["running", "queued", "pending"]);

/** One measured message as stored in the session. */
interface RateRecordEntry {
	tokens: number;
	elapsedMs: number;
	ttftMs?: number;
	exact: boolean;
	/** Present when the time to first token was measured from the turn start. */
	ttftFrom?: "turn";
	/**
	 * Present when the provider buffered the response before any of it was
	 * written. Only the truthy case is stored, so the flag costs a byte.
	 */
	frontLoadedFirstChunk?: boolean;
	/** Present when the record is a summarization call rather than a reply. */
	kind?: SummaryKind;
}

/** Where the line sits relative to the editor. */
type Position = "above" | "below";

interface DisplayPrefs {
	enabled: boolean;
	position: Position;
	detail: DetailLevel;
	/** Width of one trace bar. */
	tick: string;
	/** Total time the trace covers. */
	window: string;
}

const DEFAULT_PREFS: DisplayPrefs = {
	enabled: true,
	position: "above",
	detail: "full",
	// Two seconds per bar, so the default window is sixteen columns rather than
	// thirty-two. The window stays at half a minute — nothing is lost but
	// resolution, and a two-second bar averages about forty samples, so it is even
	// calmer than the one-second bar it replaces. Those columns are worth more as
	// numbers than as bars.
	tick: "2s",
	window: "32s",
};

/** Trace resolutions offered by the command, as milliseconds. */
const TICK_CHOICES: Record<string, number> = { "250ms": 250, "500ms": 500, "1s": 1000, "2s": 2000 };
const WINDOW_CHOICES: Record<string, number> = { "8s": 8000, "16s": 16_000, "32s": 32_000, "60s": 60_000 };

/** Parse a tick or window choice into milliseconds. */
function resolutionMs(choice: string, choices: Record<string, number>): number | undefined {
	return choices[choice];
}

/** Values each option that takes an argument accepts. */
const CHOICES = {
	position: ["above", "below"],
	detail: DETAIL_LEVELS,
	tick: Object.keys(TICK_CHOICES),
	window: Object.keys(WINDOW_CHOICES),
} as const;

type ChoiceAction = keyof typeof CHOICES;

/**
 * The default of each option, read from the defaults themselves so the two cannot
 * drift apart.
 */
const DEFAULT_CHOICE: Record<ChoiceAction, string> = {
	position: DEFAULT_PREFS.position,
	detail: DEFAULT_PREFS.detail,
	tick: DEFAULT_PREFS.tick,
	window: DEFAULT_PREFS.window,
};

/**
 * The values an option accepts, with the default bracketed: `[above]|below`.
 *
 * A reader who has never opened the help then knows both what can be typed and
 * which of them needs no argument, in one place.
 */
function choiceList(action: ChoiceAction): string {
	const preferred = DEFAULT_CHOICE[action];
	return CHOICES[action].map((value) => (value === preferred ? `[${value}]` : value)).join("|");
}

/** Subcommands and their argument completions, used by the command and `/help`. */
const ACTIONS = {
	on: "show the line",
	off: "hide the line",
	position: `${choiceList("position")} — where the line sits relative to the editor`,
	detail: `${choiceList("detail")} — cap on how much to show`,
	tick: `${choiceList("tick")} — width of one trace bar`,
	window: `${choiceList("window")} — time the trace covers, and so the bar count`,
	stats: "the session report: output, throughput, spread, first token, this configuration",
	reset: "clear the statistics for this run",
	help: "list every option with the current state",
} as const;

type Action = keyof typeof ACTIONS;

const isChoiceAction = (value: string): value is ChoiceAction => value in CHOICES;

interface SessionState {
	prefs: DisplayPrefs;
	/** The single session-continuous rate model. */
	model: SessionRateModel;
	/** The single definition of how that model is displayed. */
	view: RateView;
	/** Context that owns the widget; replaced on session switch. */
	ctx: ExtensionContext | undefined;
	/** When the current turn began, before its request was sent. */
	turnStartedAt: number;
	/** When the previous message or tool call finished. */
	lastStepEndedAt: number;
	lastRenderAt: number;
	/** Subscriptions on the extension event bus, released when the session ends. */
	busSubscriptions: (() => void)[];
}

export default function tokenRate(pi: ExtensionAPI) {
	// The view and the model are the same objects for the whole session: the
	// widget reads the view on every frame, so replacing the model replaces both.
	const model = new SessionRateModel();
	const state: SessionState = {
		prefs: { ...DEFAULT_PREFS },
		model,
		view: new RateView(model),
		ctx: undefined,
		turnStartedAt: 0,
		lastStepEndedAt: 0,
		lastRenderAt: 0,
		busSubscriptions: [],
	};

	/** Replace the model, e.g. after seeding it from session history. */
	function setModel(model: SessionRateModel): void {
		state.model = model;
		state.view = new RateView(model, state.prefs.detail);
		// A replacement starts from the constructor's defaults, so the resolution
		// has to be applied to it: otherwise the trace would quietly fall back to
		// 500ms bars while the preferences still claim something else.
		applyResolution();
	}

	/**
	 * Stop claiming a summarization that pi says has ended.
	 *
	 * Compaction always ends in `session_compact` or `session_compact_failed`, but
	 * an aborted branch summary ends in neither: `navigateTree` returns without
	 * `session_tree`, so nothing is left to close the claim but this extension's own
	 * bookkeeping. `ctx.isIdle()` is pi's own answer to "is anything running", and
	 * it covers an agent run, a compaction, a branch summary, a retry and queued
	 * work alike — so a call is claimed only while pi agrees that it is. The model
	 * keeps the timing either way, so an errant frame costs a line, never a record.
	 */
	function syncSilentCall(ctx: ExtensionContext): void {
		if (state.model.isSummarizing && ctx.isIdle()) state.model.noteSilentCallEnded();
	}

	/**
	 * Publish the widget. The component reads the view on every frame, so a
	 * session replacement only needs the widget rebuilt, not a new closure over
	 * stale state.
	 */
	function renderWidget(ctx: ExtensionContext): void {
		// Never touch the UI outside the interactive TUI.
		if (ctx.mode !== "tui") return;
		if (!state.prefs.enabled) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const options: ExtensionWidgetOptions = { placement: state.prefs.position === "below" ? "belowEditor" : "aboveEditor" };
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => {
				// The frame is the only place that runs without an event to react to,
				// which is where a summary that ended without one has to be noticed.
				syncSilentCall(ctx);
				const style: StyleFn = (color, text) => theme.fg(color, text);
				return {
					render: (width: number) => state.view.widgetLines(width, { style, now: Date.now(), measure: visibleWidth }),
					// The line is rebuilt from the model on every frame, so there is
					// no cached state to drop.
					invalidate: () => {},
				};
			},
			options,
		);
	}

	function render(force: boolean): void {
		const ctx = state.ctx;
		if (ctx?.mode !== "tui") return;
		syncSilentCall(ctx);
		const now = Date.now();
		if (!force && now - state.lastRenderAt < RENDER_INTERVAL_MS) return;
		state.lastRenderAt = now;
		renderWidget(ctx);
	}

	/**
	 * One request on pi-subagents' in-process RPC bridge.
	 *
	 * The bridge is another extension: a reply can be malformed, late, or never
	 * come, so every request carries its own timeout, runs its callback exactly
	 * once — synchronously when the reply arrives, with undefined when it does
	 * not — and releases its subscription either way. The timer is unref'd so a
	 * request that outlives the process's other work cannot keep it alive.
	 */
	function requestSubagentRpc(
		method: string,
		params: Record<string, unknown> | undefined,
		timeoutMs: number,
		onData: (data: unknown) => void,
	): void {
		const bus = pi.events;
		if (!bus) return;
		const requestId = randomUUID();
		let settled = false;
		const unsubscribe = bus.on(subagentRpcReply(requestId), (raw) => {
			finish(isRecord(raw) && raw.success === true ? raw.data : undefined);
		});
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		timer.unref?.();
		function finish(data: unknown): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			onData(data);
		}
		bus.emit(
			SUBAGENT_RPC_REQUEST,
			params === undefined ? { version: 1, requestId, method } : { version: 1, requestId, method, params },
		);
	}

	/** The promise shape of {@link requestSubagentRpc}, for chained reads. */
	function requestSubagentRpcData(
		method: string,
		params: Record<string, unknown> | undefined,
		timeoutMs: number,
	): Promise<unknown> {
		return new Promise((resolve) => requestSubagentRpc(method, params, timeoutMs, resolve));
	}

	/** Whether a cost request is out, and which one its replies must be for. */
	let costOut = false;
	let costGeneration = 0;

	/** Finalized child accounting from the latest cost report a reply carried. */
	let costChildren: CostChildUsage | undefined;

	/** Running children as the latest live read reported them, by source key. */
	const liveChildren = new Map<string, ChildUsageEntry>();

	/**
	 * Children that left the live view with no completion notice behind them,
	 * by the same key — a child that finishes mid-workflow, picked up by the
	 * next report rather than any event. Their last live total is held so the
	 * segment cannot dip while the accounting catches up.
	 */
	const heldChildren = new Map<string, ChildUsageEntry>();

	/**
	 * True from a completion notice until the next poll: the notice forced a
	 * cost report, so children dropping out of that poll's view are already
	 * counted, and holding them would count them twice.
	 */
	let completionNoticeSincePoll = false;

	/** True when the latest live read was bounded and may have omitted a child. */
	let liveTruncated = false;

	/** The scheduled live read, when one is. */
	let livePollTimer: ReturnType<typeof setTimeout> | undefined;

	/** Guards against a second read starting while one is out. */
	let livePollInFlight = false;

	/**
	 * Bumped whenever the session whose children are being read is replaced:
	 * a read that comes back for a session that has ended must not touch the
	 * model the replacement installed.
	 */
	let liveGeneration = 0;

	/** Open `subagent` tool calls: each one hosts a foreground child. */
	let foregroundSubagentCalls = 0;

	/**
	 * True until a status reply proves the installed pi-subagents carries a
	 * fleet view. Reset by the readiness notice and a fresh session, because
	 * both can load a version that has one; while it holds, the segment falls
	 * back to cost accounting alone.
	 */
	let liveUnsupported = false;

	/** Fold the three sources into the segment the line draws. */
	function refreshChildSnapshot(): void {
		const held = [...heldChildren.values()].filter((entry) => !liveChildren.has(entry.key));
		state.model.setChildren(
			mergeChildUsage(costChildren, { entries: [...liveChildren.values()], truncated: liveTruncated }, held),
		);
		render(true);
	}

	/**
	 * Ask pi-subagents for this session's parent-plus-child token accounting.
	 *
	 * A child is its own pi session, so nothing about it streams to this
	 * extension: the cost report is the supported accounting view, and it is
	 * read on turn boundaries and completions rather than on a timer, exactly
	 * as its contract asks. A report supersedes everything the live view held:
	 * the children it counts are finished and authoritative now, and whatever
	 * was held from the live view belonged to children it would have counted.
	 * An unanswered request — pi-subagents not installed, or not ready yet —
	 * simply tries again at the next boundary.
	 */
	function requestChildUsage(force = false): void {
		if (!pi.events) return;
		if (costOut && !force) return;
		const generation = ++costGeneration;
		costOut = true;
		requestSubagentRpc("cost", undefined, COST_TIMEOUT_MS, (data) => {
			// A superseded request keeps quiet: its replacement owns the
			// outstanding slot and the accounting that will land in it.
			if (generation !== costGeneration) return;
			costOut = false;
			const report = parseChildUsageReport(data);
			if (report === undefined) return;
			costChildren = report;
			heldChildren.clear();
			refreshChildSnapshot();
		});
	}

	/**
	 * Start reading live child usage, if a read is not already out.
	 *
	 * The reads are triggered, never free-running: an async launch announces
	 * itself on the bus, a foreground child runs inside a `subagent` tool call
	 * this session can see, and a completion asks again for whatever siblings
	 * are still going. Each read decides whether another one is worth
	 * scheduling, so the reads last exactly as long as children are running.
	 * A reload that leaves async runs behind is the one announcement this
	 * extension cannot hear — the bridge reloaded too — and those children are
	 * picked up again by their completion notice and the next cost report.
	 */
	function ensureLivePolling(): void {
		if (!pi.events || liveUnsupported || livePollInFlight) return;
		// A pending timer sets the cadence, not a lock: a trigger that arrives
		// while the next read is still scheduled gets an immediate read, and the
		// single-timer guard keeps the cadence from doubling.
		const generation = liveGeneration;
		livePollInFlight = true;
		void pollLiveChildren(generation).finally(() => {
			livePollInFlight = false;
		});
	}

	/** Schedule the next live read; unref'd so it never holds the process open. */
	function scheduleLivePoll(generation: number): void {
		if (livePollTimer !== undefined) return;
		livePollTimer = setTimeout(() => {
			livePollTimer = undefined;
			if (liveUnsupported || generation !== liveGeneration) return;
			// A triggered read is out: keep the cadence by trying again later,
			// rather than running a second read beside it.
			if (livePollInFlight) {
				scheduleLivePoll(generation);
				return;
			}
			livePollInFlight = true;
			void pollLiveChildren(generation).finally(() => {
				livePollInFlight = false;
			});
		}, LIVE_POLL_MS);
		livePollTimer.unref?.();
	}

	/**
	 * Read the tokens of every child that is still running, from the status
	 * pi-subagents keeps for its own widgets.
	 *
	 * The untargeted reply's fleet view lists exactly the active children — a
	 * finished child drops out — with per-child tokens that move as each of its
	 * turns ends. Workflow runs appear there as one aggregate row, so each of
	 * them is asked separately for its steps, and only the steps still running
	 * are counted: the finished ones are already in the cost report. A child
	 * that left the view with no completion notice behind it finished quietly,
	 * mid-workflow, and is held at its last total until a report adopts it.
	 */
	async function pollLiveChildren(generation: number): Promise<void> {
		const data = await requestSubagentRpcData("status", {}, STATUS_TIMEOUT_MS);
		if (generation !== liveGeneration) return;
		const fleet = parseFleetView(isRecord(data) ? data.fleet : undefined, isRecord(data) ? data.asyncSnapshot : undefined);
		if (fleet === undefined) {
			// The bridge answered, but not with a fleet view: the installed
			// pi-subagents predates it. Further triggers are ignored until the
			// readiness notice or a fresh session loads a version that has one.
			liveUnsupported = true;
			return;
		}
		const entries = fleet.entries;
		for (const workflowRunId of fleet.workflowRuns) {
			const steps = await requestSubagentRpcData("status", { id: workflowRunId }, STATUS_TIMEOUT_MS);
			if (generation !== liveGeneration) return;
			entries.push(...workflowStepEntries(workflowRunId, steps));
		}
		// A child that left the view with no completion notice behind it finished
		// quietly, mid-workflow: hold its last total until a report adopts it. A
		// completion notice already forced that report, so its children are
		// counted — holding them would count them twice.
		for (const [key, entry] of liveChildren) {
			if (!entries.some((candidate) => candidate.key === key) && !completionNoticeSincePoll) heldChildren.set(key, entry);
		}
		completionNoticeSincePoll = false;
		liveChildren.clear();
		for (const entry of entries) liveChildren.set(entry.key, entry);
		liveTruncated = fleet.truncated;
		refreshChildSnapshot();
		if (fleet.totalActive > 0 || foregroundSubagentCalls > 0) scheduleLivePoll(generation);
	}

	/** Drop the scheduled live read and everything the live view held. */
	function resetLiveUsage(): void {
		liveGeneration++;
		if (livePollTimer !== undefined) {
			clearTimeout(livePollTimer);
			livePollTimer = undefined;
		}
		liveChildren.clear();
		heldChildren.clear();
		liveTruncated = false;
		completionNoticeSincePoll = false;
		foregroundSubagentCalls = 0;
	}

	/**
	 * Listen for pi-subagents' readiness notice, which also arrives after a
	 * `/reload` of either extension. The subscription outlives session switches,
	 * so it is re-armed rather than stacked: `session_start` fires for every
	 * session the process opens. Async lifecycle notices are subscribed here
	 * too: they are the announcements that start and stop the live reads.
	 */
	function subscribeSubagentRpc(): void {
		const bus = pi.events;
		if (!bus) return;
		for (const unsubscribe of state.busSubscriptions.splice(0)) unsubscribe();
		state.busSubscriptions.push(
			bus.on(SUBAGENT_RPC_READY, () => {
				// A reloaded bridge may be a newer pi-subagents than the one that
				// answered before, so the fleet view deserves a second chance.
				liveUnsupported = false;
				requestChildUsage(true);
			}),
		);
		state.busSubscriptions.push(bus.on(SUBAGENT_ASYNC_STARTED, () => ensureLivePolling()));
		state.busSubscriptions.push(
			bus.on(SUBAGENT_ASYNC_COMPLETE, () => {
				// The finished child's accounting is final now, and siblings may
				// still be going: force the report so the child changes hands
				// without a dip or a double count, and keep reading the rest.
				completionNoticeSincePoll = true;
				requestChildUsage(true);
				ensureLivePolling();
			}),
		);
	}

	/**
	 * Point the trace at the configured resolution. The bar count follows from
	 * the tick and the window, so the pair always describes a real time span.
	 */
	function applyResolution(): void {
		const tick = resolutionMs(state.prefs.tick, TICK_CHOICES) ?? 1000;
		const span = resolutionMs(state.prefs.window, WINDOW_CHOICES) ?? 32_000;
		state.model.configure({ bucketMs: tick, buckets: Math.max(4, Math.round(span / tick)) });
	}

	/** Persist the preferences so they survive a reload in this session. */
	function savePrefs(): void {
		pi.appendEntry(PREFS_ENTRY_TYPE, { ...state.prefs });
	}

	pi.on("session_start", async (_event, ctx) => {
		state.ctx = ctx;
		state.prefs = { ...DEFAULT_PREFS, ...readPersistedPrefs(ctx) };
		// The fresh session owns nothing yet: whatever the previous session was
		// reading belongs to its model, and its outstanding replies must not land
		// in this one.
		resetLiveUsage();
		liveUnsupported = false;
		costChildren = undefined;
		costGeneration++;
		// Seed from this session's own history, so statistics cover the whole
		// session instead of only the part observed since the last load.
		const model = new SessionRateModel();
		for (const record of readPersistedRecords(ctx)) model.mergeRecord(record);
		// Applying the resolution points the fresh model at the configured trace and
		// restarts it. The live series needs no starting: a new model has no history,
		// and it takes its clock from the first observation that reaches it.
		setModel(model);
		state.lastRenderAt = 0;
		render(true);
		// The bus subscription is process-wide but the model is per session, so it
		// is re-armed here and a fresh report is asked for: pi-subagents may have
		// loaded before or after this extension, and its report walks whatever
		// branch is current, which also restores the numbers after a `/reload`.
		subscribeSubagentRpc();
		requestChildUsage();
	});

	pi.on("turn_start", async () => {
		// The wait the user perceives starts here, before the request is sent.
		state.turnStartedAt = Date.now();
		state.lastStepEndedAt = state.turnStartedAt;
	});

	pi.on("message_start", async (event, ctx) => {
		// Measurement continues while the line is hidden: turning the display off
		// should not punch a silent hole in the session statistics.
		if (event.message.role !== "assistant") return;
		state.ctx = ctx;
		const now = Date.now();
		// A reference that was never set means this message started before the
		// extension saw the turn begin, and the model falls back to the message
		// start rather than measuring from the epoch.
		const from = Math.max(state.turnStartedAt, state.lastStepEndedAt);
		state.model.beginMessage(now, from > 0 ? from : undefined);
	});

	pi.on("message_update", async (event, ctx) => {
		state.ctx = ctx;
		if (!state.model.isMessageActive) return;
		const delta = deltaText(event.assistantMessageEvent);
		if (delta) state.model.addDelta(delta, Date.now());
		render(false);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		state.ctx = ctx;
		const record = state.model.endMessage(Date.now(), outputTokens(event.message));
		if (!record) return;
		// Persist the measurement so a later run, reload, or resume includes it.
		// Entries without a renderer stay out of the transcript and the context.
		pi.appendEntry(RECORD_ENTRY_TYPE, toEntry(record));
		state.lastStepEndedAt = Date.now();
		render(true);
	});

	// Tool calls produce no output tokens. Observing the clock lets the smoothed
	// rate decay, while the trace keeps its last shape instead of disappearing.
	pi.on("tool_execution_start", async (event, ctx) => {
		state.ctx = ctx;
		state.model.observe(Date.now());
		// A foreground child runs inside a `subagent` tool call, so the call
		// itself is the announcement that live reading should cover it.
		if (event.toolName === "subagent") {
			foregroundSubagentCalls++;
			ensureLivePolling();
		}
		render(true);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		state.ctx = ctx;
		// The next message's wait is measured from here, not from the turn start.
		state.lastStepEndedAt = Date.now();
		state.model.observe(state.lastStepEndedAt);
		// A finished foreground child lands in the session's tool result, so the
		// cost report can count it now; one more live read lets the fleet view
		// drop it, and the reads stop once nothing is left.
		if (event.toolName === "subagent") {
			foregroundSubagentCalls = Math.max(0, foregroundSubagentCalls - 1);
			completionNoticeSincePoll = true;
			requestChildUsage(true);
			ensureLivePolling();
		}
		render(true);
	});

	// Compaction calls the model directly instead of running the agent loop: it
	// emits no message events, so no token can be watched as it streams. The wait
	// is still worth showing, and the provider's own usage arrives at the end.
	pi.on("session_before_compact", async () => {
		state.model.beginSilentCall("compaction", Date.now());
		render(true);
	});

	pi.on("session_compact", async (event) => {
		const record = state.model.endSilentCall(Date.now(), event.compactionEntry.usage?.output);
		if (record) pi.appendEntry(RECORD_ENTRY_TYPE, toEntry(record));
		render(true);
	});

	// A cancelled or failed compaction has no usage, and the time it took was a
	// wait rather than generation, so it contributes no record.
	pi.on("session_compact_failed", async () => {
		state.model.endSilentCall(Date.now());
		render(true);
	});

	// Branch summarization is the same shape as compaction: pi calls the model
	// directly, so nothing streams to extensions and the only measurement is the
	// end-to-end time around the provider's reported usage. A navigation that asks
	// for no summary is instant and never calls the model, so it opens no call.
	pi.on("session_before_tree", async (event) => {
		// The handler must return nothing: pi reads any value back as a summary to
		// inject, or as instructions to override.
		if (!event.preparation.userWantsSummary) return;
		state.model.beginSilentCall("branch-summary", Date.now());
		render(true);
	});

	pi.on("session_tree", async (event) => {
		// Fires for every navigation, with the summary entry only when one was
		// generated. Without a summary the call closes here and records nothing.
		const record = state.model.endSilentCall(Date.now(), event.summaryEntry?.usage?.output);
		if (record) pi.appendEntry(RECORD_ENTRY_TYPE, toEntry(record));
		render(true);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		state.ctx = ctx;
		state.model.observe(Date.now());
		// A settled agent is the turn boundary the cost report asks to be read on:
		// children that finished during the turn are counted without a timer.
		requestChildUsage();
		render(true);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		state.ctx = ctx;
		render(true);
	});

	pi.on("session_shutdown", async () => {
		state.ctx = undefined;
		// A reply in flight belongs to a session that is over; the bump makes it
		// a no-op wherever it lands.
		costGeneration++;
		resetLiveUsage();
		for (const unsubscribe of state.busSubscriptions.splice(0)) unsubscribe();
	});

	pi.registerCommand("token-rate", {
		description: "Live output-token meter: on/off, position, detail, tick, window, stats",
		// pi replaces the whole argument text with the chosen `value`, not just
		// the last word, so a two-word completion has to carry the subcommand
		// with it: `position b` must complete to `position below`, not `below`.
		getArgumentCompletions: (prefix) => {
			// Matching is case-insensitive, but the value is sliced out of the
			// original text so what the user typed is preserved.
			const lowered = prefix.toLowerCase();
			// A trailing space means a new word has started, which is what tells
			// "position" (still typing the subcommand) from "position " (typing its
			// argument).
			const startingWord = /\s$/.test(prefix);
			const words = lowered.trim().split(/\s+/).filter(Boolean);
			const [action = ""] = words;
			const typingArgument = isChoiceAction(action) && (startingWord || words.length > 1);
			// The word being completed: the last one typed, or nothing yet when a
			// space has just been entered.
			const completing = startingWord ? "" : (words[words.length - 1] ?? "");
			// Everything before that word, which the value has to repeat.
			const head = prefix.slice(0, prefix.length - completing.length);
			const candidates = typingArgument ? CHOICES[action] : Object.keys(ACTIONS);
			const items = candidates
				.filter((candidate) => candidate.startsWith(completing))
				// While a prefix is being typed, an exact match comes first and then
				// the shortest, so "2" offers "2s" before "250ms". With no prefix the
				// declared order is kept, which is the readable one.
				.sort(completing === "" ? () => 0 : (a, b) => Number(b === completing) - Number(a === completing) || a.length - b.length)
				.map((candidate) => ({
					// A subcommand that takes an argument gets a trailing space, so
					// the next Tab completes that argument instead of repeating the
					// subcommand.
					value: typingArgument ? `${head}${candidate}` : `${head}${candidate}${candidate in CHOICES ? " " : ""}`,
					label: candidate,
					// The default is marked in the completion list too, so the value that
					// needs no argument is visible before it is typed.
					description: typingArgument
						? candidate === DEFAULT_CHOICE[action]
							? "default"
							: undefined
						: ACTIONS[candidate as Action],
				}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [action = "", argument = ""] = args.trim().toLowerCase().split(/\s+/);
			state.ctx = ctx;
			// Set when the command changed a setting, so the reply can name it.
			let change: string | undefined;

			if (action === "help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}
			if (action === "stats") {
				// The report names the configuration it was collected under, so the readings
				// can be read without a second command.
				ctx.ui.notify(state.view.summary(Date.now(), { enabled: state.prefs.enabled, position: state.prefs.position }), "info");
				return;
			}
			if (action === "reset") {
				// Emptied in place rather than replaced, so the trace resolution and the
				// learned calibration survive the reset.
				state.model.reset();
				render(true);
				ctx.ui.notify("Token rate statistics cleared for this run (records already stored in the session are kept)", "info");
				return;
			}
			if (action === "") {
				state.prefs.enabled = !state.prefs.enabled;
			} else if (action === "on" || action === "off") {
				state.prefs.enabled = action === "on";
			} else if (isChoiceAction(action)) {
				const allowed = CHOICES[action];
				if (!(allowed as readonly string[]).includes(argument)) {
					// The usage line names the default too, so a mistyped value can be
					// corrected without a second command.
					ctx.ui.notify(`Usage: /token-rate ${action} ${choiceList(action)}`, "warning");
					return;
				}
				if (action === "position") {
					state.prefs.position = argument as Position;
					change = `Position: ${argument} the editor`;
				} else if (action === "detail") {
					state.prefs.detail = argument as DetailLevel;
					state.view.detailLevel = state.prefs.detail;
					change = `Detail: ${argument}`;
				} else if (action === "tick") {
					state.prefs.tick = argument;
					applyResolution();
					change = `Tick: ${argument} per bar`;
				} else {
					state.prefs.window = argument;
					applyResolution();
					change = `Window: ${argument} of history`;
				}
			} else {
				ctx.ui.notify(`Unknown option "${action}". Run /token-rate help for the list.`, "warning");
				return;
			}

			savePrefs();
			render(true);
			ctx.ui.notify(describePrefs(change), "info");
		},
	});

	/**
	 * What changed, echoed after every command.
	 *
	 * The line leads with the change rather than the whole state, so a setting
	 * command confirms itself even while the display is off, and the readings
	 * follow so the effect can be judged without waiting for the next message.
	 */
	function describePrefs(change?: string): string {
		const { enabled, position, detail, tick, window: span } = state.prefs;
		const reading = state.view.reading(Date.now());
		const headline = change === undefined ? `Token rate ${enabled ? "on" : "off"}` : change;
		// A hidden line is stated plainly, with the one command that brings it
		// back, rather than leaving the reader to work it out.
		const hidden = enabled ? "" : " · display is off, /token-rate on to show it";
		return [
			`${headline}${hidden}`,
			`${position} the editor · detail ${detail} · ${reading.bars} bars of ${tick} (${span})`,
			`now ${reading.rate} · session ${reading.session}`,
		].join("\n");
	}

	/**
	 * The full option list with the current state on top, so one screen answers
	 * both "what can this do" and "what is it doing now".
	 */
	function helpText(): string {
		const { enabled, position, detail, tick, window: span } = state.prefs;
		const reading = state.view.reading(Date.now());
		const lines = [
			"/token-rate — live output-token meter",
			"",
			`  state    ${enabled ? `on · ${position} the editor · detail ${detail}` : "off"}`,
			`  trace    ${reading.bars} bars of ${tick} (${span})`,
			// Readings mean nothing while the line is hidden.
			...(enabled ? [`  now      ${reading.rate} live · ${reading.session} session average`] : []),
			"",
			"  usage    /token-rate [option] [value]",
			"",
		];
		// The column is derived from the longest name so a new option cannot end
		// up with its arguments glued to it.
		const column = Math.max(...Object.keys(ACTIONS).map((action) => action.length)) + 2;
		for (const [action, description] of Object.entries(ACTIONS)) {
			lines.push(`  ${action.padEnd(column)}${description}`);
		}
		lines.push(
			`  ${"(none)".padEnd(column)}toggle the line`,
			"",
			"  Options accept Tab completion. Changing tick or window restarts the",
			"  trace and keeps the statistics. Rates marked ~ are estimated from",
			"  stream deltas; the rest are what the provider reported.",
		);
		return lines.join("\n");
	}
}

/**
 * Read the rate records this session already holds, so statistics cover the
 * whole session rather than starting at the last load.
 */
function readPersistedRecords(ctx: ExtensionContext): MessageRecord[] {
	const records: MessageRecord[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== RECORD_ENTRY_TYPE) continue;
		const data = entry.data as Partial<RateRecordEntry> | undefined;
		if (!data || typeof data.tokens !== "number" || typeof data.elapsedMs !== "number") continue;
		records.push({
			tokens: data.tokens,
			elapsedMs: data.elapsedMs,
			// Times measured from the old reference are dropped rather than mixed
			// in with the current definition.
			ttftMs: data.ttftFrom === "turn" && typeof data.ttftMs === "number" ? data.ttftMs : undefined,
			ttftFrom: data.ttftFrom,
			// A buffered response has to stay out of the peak and the spread across a
			// reload too: the record that is read back has to be the record that was
			// written, or the rate it was held back from reappears with no caveat.
			frontLoadedFirstChunk: data.frontLoadedFirstChunk === true ? true : undefined,
			peakRate: 0,
			exact: data.exact === true,
			// An unknown kind is dropped rather than trusted: the session file is
			// writable data, and a record that cannot be identified is not one this
			// version knows how to keep out of the rates.
			kind: data.kind === "compaction" || data.kind === "branch-summary" ? data.kind : undefined,
		});
	}
	return records;
}

/** Read the display preferences stored earlier in this session. */
function readPersistedPrefs(ctx: ExtensionContext): Partial<DisplayPrefs> {
	const prefs: Partial<DisplayPrefs> = {};
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== PREFS_ENTRY_TYPE) continue;
		const data = entry.data as Partial<DisplayPrefs> | undefined;
		if (!data) continue;
		if (typeof data.enabled === "boolean") prefs.enabled = data.enabled;
		if (data.position === "above" || data.position === "below") prefs.position = data.position;
		if (data.detail && (DETAIL_LEVELS as readonly string[]).includes(data.detail)) prefs.detail = data.detail;
		if (data.tick && data.tick in TICK_CHOICES) prefs.tick = data.tick;
		if (data.window && data.window in WINDOW_CHOICES) prefs.window = data.window;
	}
	return prefs;
}

/** Strip undefined fields so the stored entry stays small. */
function toEntry(record: MessageRecord): RateRecordEntry {
	return {
		tokens: record.tokens,
		elapsedMs: record.elapsedMs,
		...(record.ttftMs === undefined ? {} : { ttftMs: record.ttftMs }),
		exact: record.exact,
		...(record.ttftFrom === undefined ? {} : { ttftFrom: record.ttftFrom }),
		...(record.frontLoadedFirstChunk ? { frontLoadedFirstChunk: true } : {}),
		...(record.kind === undefined ? {} : { kind: record.kind }),
	};
}

/** Token text carried by one assistant stream event, or undefined. */
function deltaText(event: { type: string; delta?: string }): string | undefined {
	if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
		return event.delta;
	}
	return undefined;
}

/** Provider-reported output tokens, when the message carries usage. */
function outputTokens(message: unknown): number | undefined {
	const usage = (message as { usage?: { output?: number } } | null)?.usage;
	return typeof usage?.output === "number" ? usage.output : undefined;
}

/** True when the value is a record and not an array or `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite non-negative number, or undefined: the bus carries writable data. */
function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * One field of a usage block, defaulting to zero rather than rejecting the
 * report: a field pi-subagents did not write is an absence, not a corruption.
 */
function usageField(block: Record<string, unknown> | undefined, field: string): number {
	return nonNegativeNumber(block?.[field]) ?? 0;
}

/**
 * Finalized child accounting read out of a `cost` reply's data.
 *
 * The reply is data from another extension on the process event bus, so it is
 * validated the way session entries are: a report that cannot be identified is
 * not one this version knows how to count, and undefined means exactly that —
 * an account with nothing in it is a valid, empty report, so the segment can
 * drop what a branch switch made stale. Each child is keyed by what identifies
 * it best, so the entries stay one child each however the report labeled them.
 * A report that predates per-child entries is read as one aggregate entry.
 */
function parseChildUsageReport(data: unknown): CostChildUsage | undefined {
	if (!isRecord(data)) return undefined;
	const unresolved = nonNegativeNumber(data.unresolvedAsyncChildren) ?? 0;
	if (Array.isArray(data.children)) {
		const entries: ChildUsageEntry[] = [];
		for (const [index, child] of data.children.entries()) {
			if (!isRecord(child)) continue;
			const usage = isRecord(child.usage) ? child.usage : undefined;
			const key =
				typeof child.runId === "string" && child.runId
					? `cost:run:${child.runId}`
					: typeof child.sessionFile === "string" && child.sessionFile
						? `cost:session:${child.sessionFile}`
						: `cost:child:${index}`;
			entries.push({
				key,
				output: usageField(usage, "output"),
				input: usageField(usage, "input"),
				cacheRead: usageField(usage, "cacheRead"),
			});
		}
		return { entries, unresolved };
	}
	// The aggregate-only shape: without a number to read there is no report.
	const childTotal = isRecord(data.childTotal) ? data.childTotal : undefined;
	const output = nonNegativeNumber(childTotal?.output);
	if (output === undefined) return undefined;
	return {
		entries: [
			{ key: "cost:total", output, input: usageField(childTotal, "input"), cacheRead: usageField(childTotal, "cacheRead") },
		],
		unresolved,
	};
}

/** The fleet view of a status reply: the children that are still running. */
interface FleetView {
	/** Running children with their cumulative tokens, keyed per source. */
	entries: ChildUsageEntry[];
	/** Whether the view was bounded and omitted children. */
	truncated: boolean;
	/** Active children the view knows about, skipped aggregate rows included. */
	totalActive: number;
	/** Async workflow runs that are still going, by run id. */
	workflowRuns: string[];
}

/**
 * Read the live fleet view out of a `status` reply.
 *
 * The fleet lists exactly the children pi-subagents still counts as active — a
 * finished child drops out — with the cumulative tokens its own widgets draw.
 * Rows named after a run mode rather than an agent are skipped: their tokens
 * aggregate the whole run, finished children included. The run ids the
 * snapshot still reports as going are what the aggregate workflow rows are
 * replaced with. Undefined means the reply carried no fleet view at all.
 */
function parseFleetView(fleet: unknown, snapshot: unknown): FleetView | undefined {
	if (!isRecord(fleet)) return undefined;
	const entries: ChildUsageEntry[] = [];
	for (const entry of Array.isArray(fleet.entries) ? fleet.entries : []) {
		if (!isRecord(entry)) continue;
		const agent = typeof entry.agent === "string" ? entry.agent : "";
		if (AGGREGATE_FLEET_AGENTS.has(agent)) continue;
		if (typeof entry.key !== "string" || !entry.key) continue;
		const tokens = isRecord(entry.tokens) ? entry.tokens : undefined;
		entries.push({
			key: `fleet:${entry.key}`,
			output: usageField(tokens, "output"),
			input: usageField(tokens, "input"),
			// The fleet view carries no cache split; its input is the raw input.
			cacheRead: 0,
		});
	}
	const workflowRuns: string[] = [];
	if (isRecord(snapshot) && Array.isArray(snapshot.runs)) {
		for (const run of snapshot.runs) {
			if (!isRecord(run) || run.kind !== "workflow") continue;
			if (!ACTIVE_RUN_STATES.has(String(run.state))) continue;
			if (typeof run.id === "string" && run.id) workflowRuns.push(run.id);
		}
	}
	return {
		entries,
		truncated: (nonNegativeNumber(fleet.omitted) ?? 0) > 0,
		totalActive: nonNegativeNumber(fleet.totalActive) ?? entries.length,
		workflowRuns,
	};
}

/**
 * Read a workflow's running steps out of a targeted `status` reply.
 *
 * A workflow run is one fleet row whose tokens cover every child it has
 * finished, so the per-child totals come from the run's own steps instead:
 * exactly the steps still running are counted, because the finished ones are
 * already in the cost report. Step tokens are cumulative per step and move as
 * each of the step's turns ends.
 */
function workflowStepEntries(runId: string, data: unknown): ChildUsageEntry[] {
	const details = isRecord(data) ? data.details : undefined;
	const steps = isRecord(details) && Array.isArray(details.steps) ? details.steps : [];
	const entries: ChildUsageEntry[] = [];
	for (const [index, step] of steps.entries()) {
		if (!isRecord(step) || !ACTIVE_RUN_STATES.has(String(step.status))) continue;
		const tokens = isRecord(step.tokens) ? step.tokens : undefined;
		const stepKey =
			typeof step.workflowKey === "string" && step.workflowKey
				? step.workflowKey
				: typeof step.runId === "string" && step.runId
					? step.runId
					: `step:${index}`;
		entries.push({
			key: `workflow:${runId}:${stepKey}`,
			output: usageField(tokens, "output"),
			input: usageField(tokens, "input"),
			cacheRead: usageField(tokens, "cacheRead"),
		});
	}
	return entries;
}
