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

import type { ExtensionAPI, ExtensionContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";

import { type MessageRecord, SessionRateModel, type SummaryKind } from "./metrics.ts";
import { DETAIL_LEVELS, type DetailLevel, RateView, type StyleFn, visibleWidth } from "./rate-view.ts";

/** Entry type for the rate records appended to the session. */
const RECORD_ENTRY_TYPE = "token-rate";

/** Entry type for the display preferences, so they survive a reload. */
const PREFS_ENTRY_TYPE = "token-rate-prefs";

const WIDGET_KEY = "token-rate-spark";

/** Minimum interval between renders while streaming. */
const RENDER_INTERVAL_MS = 80;

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
	pi.on("tool_execution_start", async (_event, ctx) => {
		state.ctx = ctx;
		state.model.observe(Date.now());
		render(true);
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		state.ctx = ctx;
		// The next message's wait is measured from here, not from the turn start.
		state.lastStepEndedAt = Date.now();
		state.model.observe(state.lastStepEndedAt);
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
		render(true);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		state.ctx = ctx;
		render(true);
	});

	pi.on("session_shutdown", async () => {
		state.ctx = undefined;
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
