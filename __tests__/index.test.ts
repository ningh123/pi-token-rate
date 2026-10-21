/**
 * Integration tests for pi-token-rate: the extension is loaded with a stub
 * ExtensionAPI and driven with synthetic streaming events.
 *
 * Run with:
 *   npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import tokenRate from "../index.ts";
import { visibleWidth } from "../rate-view.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[] };
type RegisteredCommand = {
	handler: (args: string, ctx: unknown) => unknown;
	getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null;
};

interface Harness {
	handlers: Map<string, Handler[]>;
	commands: Map<string, RegisteredCommand>;
	widgets: (WidgetFactory | undefined)[];
	/** Placement passed to the most recent setWidget call. */
	placement: string | undefined;
	notifications: string[];
	appended: { type: string; data: unknown }[];
	/** Session entries returned by getBranch(), seeded by the test. */
	branch: unknown[];
	/** Prefs entries appended by the extension. */
	prefs: { type: string; data: unknown }[];
	/** Requests captured on the pi-subagents RPC channel, oldest first. */
	rpcRequests: { requestId: string; method: string }[];
	ctx: unknown;
	/**
	 * What `ctx.isIdle()` answers: whether pi has an agent run, a compaction, a
	 * branch summary, a retry or queued work in flight. Tests drive it the way pi
	 * would, setting it false for the duration of a summarization call.
	 */
	setIdle(idle: boolean): void;
	emit(event: string, payload?: unknown): Promise<void>;
	/** Deliver an event-bus message the way another extension would. */
	busEmit(channel: string, data?: unknown): void;
	/** Answer the newest cost request the way pi-subagents would. */
	answerCost(report: unknown): void;
	/** Answer the newest request of one method the way pi-subagents would. */
	answerMethod(method: string, data: unknown): void;
	/** Answer the newest status request the way pi-subagents would. */
	answerStatus(data: unknown): void;
	command(args?: string): Promise<void>;
	completions(prefix: string): { value: string; label: string; description?: string }[] | null;
	/** Visible text of the installed widget. */
	widgetLines(width?: number): string[];
	/** The first visible widget line. */
	line(width?: number): string;
	/** The styled widget line, escapes included. */
	rawWidgetLines(width?: number): string[];
}

const theme = {
	fg: (color: string, text: string) => `[${color === "accent" ? "1" : "2"}m${text}[0m`,
	style: (text: string) => text,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness(options: { mode?: "tui" | "print"; events?: boolean } = {}): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const widgets: (WidgetFactory | undefined)[] = [];
	const notifications: string[] = [];
	const appended: { type: string; data: unknown }[] = [];
	const branch: unknown[] = [];
	const prefs: { type: string; data: unknown }[] = [];
	const rpcRequests: { requestId: string; method: string }[] = [];
	const busHandlers = new Map<string, ((data: unknown) => void)[]>();
	const harness = { placement: undefined as string | undefined };
	const bus =
		options.events === false
			? undefined
			: {
					emit(channel: string, data: unknown) {
						if (channel === "subagents:rpc:v1:request") {
							const request = data as { requestId?: string; method?: string };
							if (request?.requestId) rpcRequests.push({ requestId: request.requestId, method: request.method ?? "" });
						}
						for (const handler of busHandlers.get(channel) ?? []) handler(data);
					},
					on(channel: string, handler: (data: unknown) => void) {
						const list = busHandlers.get(channel) ?? [];
						list.push(handler);
						busHandlers.set(channel, list);
						return () => {
							const remaining = busHandlers.get(channel) ?? [];
							const index = remaining.indexOf(handler);
							if (index >= 0) remaining.splice(index, 1);
						};
					},
				};

	const pi = {
		events: bus,
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(_name: string, cmd: { handler: (args: string, ctx: unknown) => unknown }) {
			commands.set("token-rate", cmd);
		},
		appendEntry(type: string, data: unknown) {
			appended.push({ type, data });
			if (type === "token-rate-prefs") prefs.push({ type, data });
		},
		getSettings: () => ({ compaction: { enabled: true } }),
	};

	const ctx = {
		mode: options.mode ?? "tui",
		thinkingLevel: "high",
		// pi raises its own compaction flag before it emits `session_before_compact`
		// or `session_before_tree`, and lowers it once the call is over, whether it
		// ended in an entry or was cancelled.
		busy: false,
		isIdle: () => !ctx.busy,
		sessionManager: {
			getCwd: () => "/tmp/project",
			getSessionName: () => undefined,
			getEntryCount: () => branch.length,
			getSessionId: () => "session-1",
			getLeafId: () => "leaf-1",
			getEntries: () => branch,
			getBranch: () => branch,
		},
		model: { id: "test-model", provider: "test", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { getProvider: () => undefined },
		getContextUsage: () => ({ tokens: 90_000, contextWindow: 200_000, percent: 45 }),
		ui: {
			theme,
			setWidget(_key: string, factory: WidgetFactory | undefined, options?: { placement?: string }) {
				widgets.push(factory);
				harness.placement = factory === undefined ? undefined : options?.placement;
			},
			notify(message: string) {
				notifications.push(message);
			},
			// The extension owns no other surface: touching the footer or the
			// status row would be a regression, so fail loudly instead.
			setFooter(): never {
				throw new Error("the extension must not replace the built-in footer");
			},
			setStatus(): never {
				throw new Error("the extension must not use the extension status row");
			},
		},
	};

	tokenRate(pi as never);

	const tui = { requestRender: () => {} };

	return {
		handlers,
		commands,
		widgets,
		notifications,
		appended,
		branch,
		prefs,
		rpcRequests,
		get placement() {
			return harness.placement;
		},
		setIdle(idle: boolean) {
			ctx.busy = !idle;
		},
		ctx,
		async emit(event: string, payload: unknown = {}) {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		},
		busEmit(channel: string, data: unknown = {}) {
			bus?.emit(channel, data);
		},
		answerCost(report: unknown) {
			this.answerMethod("cost", report);
		},
		answerMethod(method: string, data: unknown) {
			const request = [...rpcRequests].reverse().find((candidate) => candidate.method === method);
			assert.ok(request, `a ${method} request was sent`);
			bus?.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
				version: 1,
				requestId: request.requestId,
				method,
				success: true,
				data,
			});
		},
		answerStatus(data: unknown) {
			this.answerMethod("status", data);
		},
		async command(args = "") {
			const command = commands.get("token-rate");
			assert.ok(command, "the /token-rate command is registered");
			await command.handler(args, ctx);
		},
		completions(prefix) {
			const command = commands.get("token-rate");
			return command?.getArgumentCompletions?.(prefix) ?? null;
		},
		line(width = 120) {
			return this.widgetLines(width)[0] ?? "";
		},
		rawWidgetLines(width = 120) {
			const factory = widgets[widgets.length - 1];
			if (!factory) return [];
			return factory(tui, theme).render(width);
		},
		widgetLines(width = 120) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
			return this.rawWidgetLines(width).map((line) => line.replace(/\[[0-9;]*m/g, ""));
		},
	};
}

/** Stream `deltas` chunks of 40 characters, `stepMs` apart. */
async function stream(harness: Harness, deltas: number, stepMs: number): Promise<void> {
	for (let i = 0; i < deltas; i++) {
		await harness.emit("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
		});
		if (i < deltas - 1) await sleep(stepMs);
	}
}

/** One measured assistant message with 400 reported output tokens. */
function completedMessage(output = 400) {
	return { message: { role: "assistant", usage: { output }, stopReason: "stop" } };
}

describe("the widget line", () => {
	it("is installed by default and shows the live rate", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		assert.equal(typeof harness.widgets.at(-1), "function", "the widget is installed");
		assert.match(harness.widgetLines()[0] ?? "", /0 tok\/s/, "shows a placeholder rate before any output");

		await harness.emit("message_start", { message: { role: "assistant" } });
		// Long enough for at least one bar to close: the default bar is two seconds.
		await stream(harness, 40, 60);
		const line = harness.widgetLines()[0] ?? "";
		assert.match(line, /⚡/, line);
		assert.match(line, /tok\/s/, line);
		assert.match(line, /[▁▂▃▄▅▆▇█]/, "a trace is drawn");
	});

	it("carries the session peak, mean time to first token, and totals", async () => {
		const harness = createHarness();
		harness.branch.push({
			type: "custom",
			customType: "token-rate",
			data: { tokens: 9000, elapsedMs: 1000, ttftMs: 640, exact: true },
		});
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("turn_start", {});
		await sleep(20);
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);
		await harness.emit("message_end", completedMessage());

		const line = harness.widgetLines(120)[0] ?? "";
		assert.match(line, /peak 9\.0k tok\/s/, line);
		assert.match(line, /ttft \d/, line);
		assert.match(line, /avg \d/, line);
		assert.match(line, /tok\b/, line);
	});

	it("survives messages and tool calls", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 40, 30);
		await harness.emit("message_end", completedMessage());
		const afterMessage = harness.widgetLines()[0] ?? "";
		assert.match(afterMessage, /tok\/s/, afterMessage);

		// A tool call produces no output tokens: the trace holds, the number
		// decays smoothly, and the widget stays.
		await harness.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: {} });
		await sleep(200);
		await harness.emit("tool_execution_end", { toolCallId: "1", toolName: "bash", result: {}, isError: false });
		const duringTool = harness.widgetLines()[0] ?? "";
		assert.ok(duringTool.length > 0, "the widget is still installed");
		assert.match(duringTool, /tok\/s/, duringTool);
		assert.match(duringTool, /[▁▂▃▄▅▆▇█]/, "the trace is still drawn");
	});

	it("adapts to the terminal width", async () => {
		const harness = createHarness();
		harness.branch.push({
			type: "custom",
			customType: "token-rate",
			data: { tokens: 9000, elapsedMs: 1000, ttftMs: 640, ttftFrom: "turn", exact: true },
		});
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 40, 10);

		// Nothing runs over the width at any size, counting the icon's extra column.
		for (const width of [120, 100, 80, 60, 46, 30, 20, 12]) {
			for (const line of harness.rawWidgetLines(width)) {
				assert.ok(visibleWidth(line) + 1 <= width, `${JSON.stringify(line)} at ${width}`);
			}
		}
		assert.match(harness.widgetLines(120)[0] ?? "", /ttft/, "a wide terminal shows the details");
		// Details are given up before the trace is squeezed, and the headline is
		// never given up at all.
		const narrow = harness.widgetLines(30)[0] ?? "";
		assert.doesNotMatch(narrow, /ttft/, narrow);
		assert.match(narrow, /tok\/s/, narrow);
		assert.deepEqual(harness.widgetLines(11), [], "a tiny terminal gets no line at all");
	});

	it("shortens the trace before the numbers", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 60, 20);

		const wide = harness.widgetLines(120)[0] ?? "";
		const tight = harness.widgetLines(40)[0] ?? "";
		assert.ok(visibleWidth(wide) <= 120);
		assert.ok(visibleWidth(tight) <= 40);
		assert.match(tight, /tok\/s/, "the headline number is never truncated away");
	});
});

describe("session-wide statistics", () => {
	it("includes records stored earlier in the session", async () => {
		const harness = createHarness();
		harness.branch.push(
			{
				type: "custom",
				customType: "token-rate",
				data: { tokens: 1000, elapsedMs: 10_000, ttftMs: 600, ttftFrom: "turn", exact: true },
			},
			{
				type: "custom",
				customType: "token-rate",
				data: { tokens: 500, elapsedMs: 5_000, ttftMs: 400, ttftFrom: "turn", exact: true },
			},
		);
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("stats");

		const summary = harness.notifications.at(-1) ?? "";
		assert.match(summary, /2 messages/, summary);
		assert.match(summary, /output {2}1\.5k tok\s+2 messages/, summary);
		assert.match(summary, /throughput {2}100 tok\/s\s+session average/, summary);
		assert.match(summary, /first token {2}0\.5s\s+2 of 2 messages timed/, summary);
	});

	it("survives legacy records with an unusable window", async () => {
		const harness = createHarness();
		harness.branch.push(
			// Written by an older version of the extension: a wall-clock span.
			{ type: "custom", customType: "token-rate", data: { tokens: 53, elapsedMs: 1, ttftMs: 0, exact: true } },
			{ type: "custom", customType: "token-rate", data: { tokens: 600, elapsedMs: 3000, ttftMs: 40, exact: true } },
			{ type: "custom", customType: "token-rate", data: { tokens: 1200, elapsedMs: 3000, ttftMs: 40, exact: true } },
		);
		await harness.emit("session_start", { reason: "startup" });
		const line = harness.widgetLines(120)[0] ?? "";
		assert.doesNotMatch(line, /53\.0k/, `legacy record leaked into the peak: ${line}`);
		assert.match(line, /peak 400 tok\/s/, line);
		// The session average equals the headline while idle, so it is not repeated.
		assert.doesNotMatch(line, /avg/, line);

		await harness.command("stats");
		const summary = harness.notifications.at(-1) ?? "";
		assert.match(summary, /1 message arrived faster than a frame/, summary);
	});

	it("stores each measured message in the session", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("turn_start", {});
		// The wait has to be more than a millisecond for it to be a measurement.
		await sleep(20);
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);
		await harness.emit("message_end", completedMessage(512));

		assert.equal(harness.appended.length, 1);
		assert.equal(harness.appended[0].type, "token-rate");
		const data = harness.appended[0].data as { tokens: number; exact: boolean; ttftMs?: number };
		assert.equal(data.tokens, 512, "the provider-reported total is stored");
		assert.equal(data.exact, true);
		assert.ok(typeof data.ttftMs === "number" && data.ttftMs < 60_000, `a wait from the turn start: ${data.ttftMs}`);
	});

	it("reports no time to first token when the turn start was never seen", async () => {
		// The extension can be loaded in the middle of a turn, in which case there
		// is no reference to measure the wait from. Measuring from the epoch would
		// store the clock, not a wait.
		const harness = createHarness();
		await harness.emit("session_start", { reason: "resume" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);
		await harness.emit("message_end", completedMessage(512));

		const data = harness.appended.at(-1)?.data as { ttftMs?: number } | undefined;
		assert.equal(data?.ttftMs, undefined, "an unknown wait, not a wrong one");
		await harness.command("stats");
		assert.doesNotMatch(harness.notifications.at(-1) ?? "", /first token/);
	});

	it("keeps the message in flight when the resolution changes mid-stream", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);
		await harness.command("tick 2s");
		await stream(harness, 20, 10);
		await harness.emit("message_end", completedMessage(700));

		const data = harness.appended.find((entry) => entry.type === "token-rate")?.data as { tokens?: number } | undefined;
		assert.equal(data?.tokens, 700, "the tokens the model already produced are not dropped");
	});

	it("ignores malformed and foreign stored records", async () => {
		const harness = createHarness();
		harness.branch.push(
			{ type: "custom", customType: "token-rate", data: { tokens: "many", elapsedMs: 10 } },
			{ type: "custom", customType: "other-extension", data: { tokens: 1, elapsedMs: 1 } },
			{ type: "custom", customType: "token-rate", data: { tokens: 100, elapsedMs: 1000, exact: true } },
		);
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /output {2}100 tok\s+1 message/);
	});

	it("resets the live statistics on request", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);
		await harness.emit("message_end", completedMessage());
		await harness.command("reset");
		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /no output measured/);
	});

	it("keeps the configured trace resolution across a reset", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("tick 250ms");
		await harness.command("window 8s");
		await harness.command("reset");
		await harness.command("help");
		assert.match(harness.notifications.at(-1) ?? "", /trace {4}32 bars of 250ms \(8s\)/);
	});
});

describe("lifecycle and commands", () => {
	it("ignores non-assistant messages", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "user" } });
		await harness.emit("message_update", {
			message: { role: "user" },
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		await harness.emit("message_end", { message: { role: "user" } });
		assert.equal(harness.appended.length, 0);
		assert.match(harness.widgetLines()[0] ?? "", /·/, "the widget shows a placeholder trace");
	});

	it("touches nothing outside TUI mode", async () => {
		const harness = createHarness({ mode: "print" });
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await harness.emit("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "hello" },
		});
		await harness.emit("message_end", completedMessage());
		assert.equal(harness.widgets.length, 0);
	});

	it("measures a summarization with no line to show it on", async () => {
		// The claim that a call is running is a display concern, so it must not be
		// what decides whether the call is recorded: headless, nothing reconciles it
		// against pi, and the usage that arrives with the terminal event still counts.
		const harness = createHarness({ mode: "print" });
		await harness.emit("session_start", { reason: "startup" });
		harness.setIdle(false);
		await harness.emit("session_before_compact", { reason: "manual", signal: new AbortController().signal });
		harness.setIdle(true);
		await harness.emit("session_compact", {
			reason: "manual",
			compactionEntry: { type: "compaction", usage: { output: 2400 } },
		});
		assert.deepEqual(
			harness.appended.map((entry) => entry.type),
			["token-rate"],
			"the record is written even with no widget to reconcile against",
		);
		assert.equal(harness.widgets.length, 0);
	});

	// pi replaces the whole argument text with the chosen value, so the value has
	// to be the complete text, not just the last word.
	const applyTab = (harness: Harness, line: string): string | null => {
		const spaceIndex = line.indexOf(" ");
		if (spaceIndex === -1) throw new Error("the command name must be followed by an argument");
		const argumentText = line.slice(spaceIndex + 1);
		const items = harness.completions(argumentText);
		if (!items || items.length === 0) return null;
		return line.slice(0, line.length - argumentText.length) + (items[0].value ?? "");
	};

	it("completes a subcommand into a runnable command line", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		assert.equal(applyTab(harness, "/token-rate "), "/token-rate on");
		assert.equal(applyTab(harness, "/token-rate po"), "/token-rate position ");
		assert.equal(applyTab(harness, "/token-rate stats"), "/token-rate stats");
	});

	it("keeps the subcommand when completing its argument", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		// "position b" must not collapse to "below".
		assert.equal(applyTab(harness, "/token-rate position "), "/token-rate position above");
		assert.equal(applyTab(harness, "/token-rate position b"), "/token-rate position below");
		assert.equal(applyTab(harness, "/token-rate detail c"), "/token-rate detail compact");
		assert.equal(applyTab(harness, "/token-rate tick 2"), "/token-rate tick 2s");
		assert.equal(applyTab(harness, "/token-rate window 6"), "/token-rate window 60s");
	});

	it("offers nothing for an argument that matches nothing", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		assert.equal(applyTab(harness, "/token-rate zzz"), null);
		assert.equal(applyTab(harness, "/token-rate position sideways"), null);
	});

	it("offers completions for subcommands and their arguments", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });

		// Subcommands that take an argument carry a trailing space, so the next Tab
		// completes that argument instead of repeating the subcommand.
		const actions = harness.completions("")?.map((item) => item.value) ?? [];
		assert.deepEqual(actions, ["on", "off", "position ", "detail ", "tick ", "window ", "stats", "reset", "help"]);
		assert.match(harness.completions("")?.[0]?.description ?? "", /show the line/);

		// A partial word filters the subcommands.
		assert.deepEqual(
			harness.completions("de")?.map((item) => item.value),
			["detail "],
		);
		// The second word completes the arguments of the subcommand before it. The
		// values carry the subcommand, because pi replaces the whole argument text.
		assert.deepEqual(
			harness.completions("position ")?.map((item) => item.value),
			["position above", "position below"],
		);
		assert.deepEqual(
			harness.completions("detail c")?.map((item) => item.value),
			["detail compact"],
		);
		// Nothing to offer yields null, so pi shows no suggestion list.
		assert.equal(harness.completions("zzz"), null);
		assert.equal(harness.completions("position middle"), null);
	});

	it("times a compaction from the provider's reported usage", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await stream(harness, 20, 10);

		harness.setIdle(false);
		await harness.emit("session_before_compact", {
			reason: "manual",
			preparation: {},
			branchEntries: [],
			willRetry: false,
			signal: new AbortController().signal,
		});
		assert.match(harness.line(), /^⚡ ░ summarizing /, "the wait is shown, not a rate that cannot be measured");

		harness.setIdle(true);
		await harness.emit("session_compact", {
			reason: "manual",
			fromExtension: false,
			willRetry: false,
			compactionEntry: {
				type: "compaction",
				usage: {
					input: 10,
					output: 900,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 910,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		});
		const persisted = harness.appended.filter((entry) => entry.type === "token-rate").at(-1)?.data as
			| { kind?: string; tokens: number }
			| undefined;
		assert.equal(persisted?.kind, "compaction");
		assert.equal(persisted?.tokens, 900, "provider-reported, so exact");

		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /summaries\s+900 tok\s+1 call/);
	});

	it("records nothing when a compaction fails", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		harness.setIdle(false);
		await harness.emit("session_before_compact", {
			reason: "manual",
			preparation: {},
			branchEntries: [],
			willRetry: false,
			signal: new AbortController().signal,
		});
		harness.setIdle(true);
		await harness.emit("session_compact_failed", { reason: "manual", aborted: true, willRetry: false, fromExtension: false });
		assert.equal(harness.appended.filter((entry) => entry.type === "token-rate").length, 0);
		assert.match(harness.line(), /^⚡ /, "back to idle, with no leftover compaction state");
		assert.doesNotMatch(harness.line(), /summarizing/);
	});

	it("keeps repeated compactions out of the session rates", async () => {
		// Two replies at 200 and 180 tok/s around two summaries measured end to
		// end: 3k tokens in 40s (75 tok/s) and 3k in 9s (333 tok/s). Read back from
		// the session, so this is what a resumed or reloaded session is looking at.
		const harness = createHarness();
		harness.branch.push(
			{
				type: "custom",
				customType: "token-rate",
				data: { tokens: 400, elapsedMs: 2000, ttftMs: 600, ttftFrom: "turn", exact: true },
			},
			{ type: "custom", customType: "token-rate", data: { tokens: 3000, elapsedMs: 40_000, kind: "compaction", exact: true } },
			{ type: "custom", customType: "token-rate", data: { tokens: 3000, elapsedMs: 9000, kind: "compaction", exact: true } },
			{
				type: "custom",
				customType: "token-rate",
				data: { tokens: 900, elapsedMs: 5000, ttftMs: 800, ttftFrom: "turn", exact: true },
			},
		);
		await harness.emit("session_start", { reason: "resume" });

		const line = harness.line();
		assert.match(line, /peak 200 tok\/s/, `a summary held the peak: ${line}`);
		assert.doesNotMatch(line, /75 tok\/s|333 tok\/s/, `a summary reached the line: ${line}`);

		await harness.command("stats");
		const summary = harness.notifications.at(-1) ?? "";
		assert.match(summary, /output {2}7\.3k tok\s+2 messages/, summary);
		assert.match(summary, /throughput {2}186 tok\/s\s+session average · now \S+ tok\/s · peak 200 tok\/s/, summary);
		assert.match(summary, /spread\s+180 … 200 tok\/s\s+median 190 tok\/s/, summary);
		assert.match(summary, /first token\s+0\.7s\s+2 of 2 messages timed/, summary);
		assert.match(summary, /summaries\s+6\.0k tok\s+2 calls · 49\.0s end to end/, summary);
		assert.match(summary, /summarization is timed end to end/, summary);
	});

	it("records every compaction of a session separately", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		for (const tokens of [900, 1500]) {
			harness.setIdle(false);
			await harness.emit("session_before_compact", {
				reason: "threshold",
				preparation: {},
				branchEntries: [],
				willRetry: false,
				signal: new AbortController().signal,
			});
			await sleep(20);
			harness.setIdle(true);
			await harness.emit("session_compact", {
				reason: "threshold",
				fromExtension: false,
				willRetry: false,
				compactionEntry: { type: "compaction", usage: { output: tokens } },
			});
		}
		const records = harness.appended
			.filter((entry) => entry.type === "token-rate")
			.map((entry) => entry.data as { kind?: string; tokens: number });
		assert.deepEqual(
			records.map((record) => [record.kind, record.tokens]),
			[
				["compaction", 900],
				["compaction", 1500],
			],
			"one record per call, and the second call is not folded into the first",
		);
		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /summaries\s+2\.4k tok\s+2 calls/);
	});

	it("times a branch summary the way it times a compaction", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });

		// A navigation that asks for no summary never calls the model, so it must
		// not open a call: the line would claim to be waiting on an instant.
		await harness.emit("session_before_tree", { preparation: { userWantsSummary: false } });
		await harness.emit("session_tree", { newLeafId: "leaf-2", oldLeafId: "leaf-1" });
		assert.doesNotMatch(harness.line(), /summarizing/);
		assert.equal(harness.appended.filter((entry) => entry.type === "token-rate").length, 0);

		harness.setIdle(false);
		await harness.emit("session_before_tree", { preparation: { userWantsSummary: true, entriesToSummarize: [{}] } });
		assert.match(harness.line(), /^⚡ ░ summarizing /);
		harness.setIdle(true);
		await harness.emit("session_tree", {
			newLeafId: "leaf-2",
			oldLeafId: "leaf-1",
			summaryEntry: { type: "branch_summary", usage: { output: 1800 } },
		});

		const persisted = harness.appended.filter((entry) => entry.type === "token-rate").at(-1)?.data as
			| { kind?: string; tokens: number }
			| undefined;
		assert.equal(persisted?.kind, "branch-summary");
		assert.equal(persisted?.tokens, 1800);
		assert.doesNotMatch(harness.line(), /summarizing/, "the call is over");

		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /summaries\s+1\.8k tok\s+1 call/);
	});

	it("stops waiting on a branch summary that pi aborted", async () => {
		// pi emits no terminal event for an aborted summary: `navigateTree` returns
		// without `session_tree`. The line has to notice on its own, or it waits on
		// a call that ended until the next turn arrives.
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		harness.setIdle(false);
		await harness.emit("session_before_tree", { preparation: { userWantsSummary: true, entriesToSummarize: [{}] } });
		assert.match(harness.line(), /^⚡ ░ summarizing /);

		harness.setIdle(true);
		assert.match(harness.line(), /^⚡ /, "pi has nothing running, so neither does the line");
		assert.doesNotMatch(harness.line(), /summarizing/);
		assert.equal(harness.appended.filter((entry) => entry.type === "token-rate").length, 0, "an abort produces nothing");
	});

	it("keeps a buffered reply buffered across a reload", async () => {
		// The record is held out of the peak and the average for being a transport
		// window rather than a generation one, and that has to survive a reload: a
		// record that reappears as an ordinary one brings back the peak it was
		// withheld from, with no caveat attached to it.
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("turn_start", {});
		await harness.emit("message_start", { message: { role: "assistant" } });
		// The first delta already carries more than a frame's worth of tokens.
		await harness.emit("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(800) },
		});
		for (let i = 0; i < 40; i++) {
			await harness.emit("message_update", {
				message: { role: "assistant" },
				assistantMessageEvent: { type: "text_delta", delta: "x".repeat(32) },
			});
			await sleep(10);
		}
		await harness.emit("message_end", completedMessage(450));
		const stored = harness.appended.at(-1)?.data as { frontLoadedFirstChunk?: boolean };
		assert.equal(stored.frontLoadedFirstChunk, true, "the flag has to be written to be read back");

		harness.branch.push(
			{
				type: "custom",
				customType: "token-rate",
				data: { tokens: 100, elapsedMs: 500, ttftFrom: "turn", ttftMs: 40, exact: true },
			},
			{ type: "custom", customType: "token-rate", data: harness.appended.at(-1)?.data },
		);
		await harness.emit("session_start", { reason: "reload" });
		await harness.command("stats");
		const summary = harness.notifications.at(-1) ?? "";
		assert.match(summary, /1 message front-loaded the first chunk/, summary);
		assert.match(summary, /throughput {2}200 tok\/s\s+session average · now \S+ tok\/s · peak 200 tok\/s/, summary);
		assert.doesNotMatch(summary, /measure the delivery of a buffer/, `a normal reply was measurable: ${summary}`);
	});

	it("defaults to a two-second tick over a thirty-two-second window", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);
		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /16 bars · 2\.0s each · 32\.0s span/);
	});

	it("changes the tick and the window", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("tick 250ms");
		await harness.command("window 8s");
		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /32 bars · 0\.3s each · 8\.0s span/);

		await harness.command("tick 2s");
		await harness.command("window 60s");
		await harness.command("stats");
		assert.match(harness.notifications.at(-1) ?? "", /30 bars · 2\.0s each · 1m00s span/);

		await harness.command("tick 3s");
		assert.match(harness.notifications.at(-1) ?? "", /Usage: \/token-rate tick/);
	});

	it("moves the line above or below the editor", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		assert.equal(harness.placement, "aboveEditor", "above the editor by default");

		await harness.command("position below");
		assert.equal(harness.placement, "belowEditor");
		assert.match(harness.notifications.at(-1) ?? "", /below the editor/);

		await harness.command("position above");
		assert.equal(harness.placement, "aboveEditor");

		await harness.command("position sideways");
		assert.match(harness.notifications.at(-1) ?? "", /Usage: \/token-rate position \[above\]\|below/);
		assert.equal(harness.placement, "aboveEditor", "an invalid value changes nothing");
	});

	it("changes how much detail the line shows", async () => {
		const harness = createHarness();
		harness.branch.push({
			type: "custom",
			customType: "token-rate",
			data: { tokens: 900, elapsedMs: 1000, ttftMs: 640, ttftFrom: "turn", exact: true },
		});
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("turn_start", {});
		await sleep(20);
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);

		// While a message is in flight the session aggregates are off the line
		// whatever the level, so the progress and the wait are all there is.
		const full = harness.widgetLines(140)[0] ?? "";
		assert.match(full, / · 0\.2s 200 tok · ttft /, full);
		assert.doesNotMatch(full, /avg |peak /, full);
		await harness.emit("message_end", completedMessage(900));
		assert.match(harness.widgetLines(140)[0] ?? "", /avg 900 tok\/s/, "full detail adds the session peak");

		await harness.command("detail compact");
		const compact = harness.widgetLines(140)[0] ?? "";
		assert.match(compact, /ttft .* · avg 900 tok\/s/, compact);
		assert.doesNotMatch(compact, /peak /, "the peak is the last detail to be given up");

		await harness.command("detail minimal");
		const minimal = harness.widgetLines(140)[0] ?? "";
		assert.match(minimal, /ttft /, "the most important detail is the one that stays");
		assert.doesNotMatch(minimal, /avg |peak /, minimal);
		assert.match(harness.notifications.at(-1) ?? "", /detail minimal/);

		await harness.command("detail full");
		assert.match(harness.widgetLines(140)[0] ?? "", /peak /);
		await harness.command("detail loud");
		assert.match(harness.notifications.at(-1) ?? "", /Usage: \/token-rate detail/);
	});

	it("remembers the preferences across a reload in the same session", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("position below");
		await harness.command("detail minimal");
		await harness.command("tick 500ms");
		assert.equal(harness.prefs.length, 3, "one stored entry per change");

		// A reload replays the session, so the stored entries are visible again.
		harness.branch.push(...harness.prefs.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })));
		await harness.emit("session_start", { reason: "reload" });
		assert.equal(harness.placement, "belowEditor", "the position survived");
		assert.equal(typeof harness.widgets.at(-1), "function", "still enabled");
		await harness.command("help");
		// The stored resolution has to reach the model, not just the preferences.
		assert.match(harness.notifications.at(-1) ?? "", /trace {4}64 bars of 500ms \(32s\)/);
	});

	it("confirms a setting change while the display is off, and says how to get it back", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("off");
		await harness.command("position below");

		const reply = harness.notifications.at(-1) ?? "";
		assert.match(reply, /^Position: below the editor/, reply);
		assert.match(reply, /display is off, \/token-rate on to show it/, reply);
		assert.match(reply, /below the editor · detail full · 16 bars of 2s \(32s\)/, reply);
		assert.equal(harness.widgets.at(-1), undefined, "the line stays hidden until it is asked for");

		await harness.command("on");
		assert.match(harness.notifications.at(-1) ?? "", /^Token rate on\n/);
		assert.notEqual(harness.widgets.at(-1), undefined, "and it comes back with one command");
	});

	it("keeps measuring while the display is off", async () => {
		// Otherwise switching the line off punches a silent hole in the session
		// statistics, and nothing in the report would say so.
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("off");
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 20, 10);
		await harness.emit("message_end", completedMessage(512));

		const record = harness.appended.find((entry) => entry.type === "token-rate");
		assert.ok(record, "the message is still measured");
		assert.equal((record.data as { tokens: number }).tokens, 512);

		await harness.command("stats");
		const summary = harness.notifications.at(-1) ?? "";
		assert.match(summary, /output {2}512 tok\s+1 message/, summary);
		assert.match(summary, /throughput {2}\d+ tok\/s/, summary);
	});

	it("remembers being switched off", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("off");
		harness.branch.push(...harness.prefs.map((entry) => ({ type: "custom", customType: entry.type, data: entry.data })));
		await harness.emit("session_start", { reason: "reload" });
		assert.equal(harness.widgets.at(-1), undefined, "still off after the reload");
	});

	it("explains an unknown option instead of dumping a usage string", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("bogus");
		assert.equal(harness.notifications.at(-1), 'Unknown option "bogus". Run /token-rate help for the list.');
	});

	it("lists every option on request", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("help");
		const help = harness.notifications.at(-1) ?? "";
		for (const action of ["on", "off", "position", "detail", "stats", "reset", "help"]) {
			assert.match(help, new RegExp(action), help);
		}
		assert.match(help, /detail full/, "the current state is on the first line");
	});

	it("toggles the widget", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("off");
		assert.equal(harness.widgets.at(-1), undefined, "the widget is removed");
		await harness.command("on");
		assert.equal(typeof harness.widgets.at(-1), "function", "the widget is back");
		await harness.command();
		assert.equal(harness.widgets.at(-1), undefined, "a bare argument toggles");
	});

	it("rebuilds the widget when the session is replaced", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		const before = harness.widgets.length;
		await harness.emit("session_start", { reason: "switch" });
		assert.equal(harness.widgets.length, before + 1);
		assert.equal(typeof harness.widgets.at(-1), "function");
	});

	it("marks the default in the help, the usage line, and the completions", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });

		// The default is read from the defaults themselves, so the help cannot claim
		// one thing while the code uses another.
		await harness.command("help");
		const help = harness.notifications.at(-1) ?? "";
		for (const [option, marked] of [
			["position", "\\[above\\]|below"],
			["detail", "minimal|compact|\\[full\\]"],
			["tick", "250ms|500ms|1s|\\[2s\\]"],
			["window", "8s|16s|\\[32s\\]|60s"],
		]) {
			assert.match(help, new RegExp(`^ {2}${option} {2}${marked} —`, "m"), `${option} does not name its default:\n${help}`);
		}

		await harness.command("position sideways");
		assert.match(harness.notifications.at(-1) ?? "", /Usage: \/token-rate position \[above\]\|below/);

		// The completion list says which value needs no argument.
		const completions = harness.completions("position ") ?? [];
		assert.equal(completions.find((item) => item.label === "above")?.description, "default");
		assert.equal(completions.find((item) => item.label === "below")?.description, undefined);
		const ticks = harness.completions("tick ") ?? [];
		assert.equal(ticks.find((item) => item.label === "2s")?.description, "default");
		assert.equal(ticks.find((item) => item.label === "1s")?.description, undefined);
	});

	it("lists every option with the current state", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("position below");
		await harness.command("help");
		const help = harness.notifications.at(-1) ?? "";
		for (const action of ["on", "off", "position", "detail", "tick", "window", "stats", "reset", "help"]) {
			assert.match(help, new RegExp(`^  ${action}\\s`, "m"), `${action} is missing from the help:\n${help}`);
		}
		assert.match(help, /state {4}on · below the editor · detail full/, help);
		assert.match(help, /trace {4}16 bars of 2s \(32s\)/, help);
		assert.match(help, /usage {4}\/token-rate \[option\] \[value\]/, help);
		// The name column must clear the longest option name.
		assert.match(help, /^ {2}position {2}\[above\]\|below/m, help);
	});

	it("hides the readings from the help while the line is off", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.command("off");
		await harness.command("help");
		const help = harness.notifications.at(-1) ?? "";
		assert.match(help, /state {4}off/, help);
		assert.doesNotMatch(help, /live ·/, help);
	});
});

describe("subagent children", () => {
	/** A cost report shaped like pi-subagents', with `output` tokens per child. */
	function costReport(output: number, count = 2, unresolved = 0) {
		return {
			version: 1,
			parent: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			children: Array.from({ length: count }, () => ({
				label: "Child",
				usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			})),
			childTotal: { input: 10 * count, output: output * count, cacheRead: 0, cacheWrite: 0, cost: 0, turns: count },
			total: { input: 1010, output: 400 + output * count, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 + count },
			unresolvedAsyncChildren: unresolved,
		};
	}

	/** A session with one measured reply, ready for a cost report. */
	async function startedHarness(): Promise<Harness> {
		const harness = createHarness();
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("turn_start", {});
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 10, 5);
		await harness.emit("message_end", completedMessage(400));
		return harness;
	}

	it("asks pi-subagents for the accounting at startup and every turn boundary", async () => {
		const harness = await startedHarness();
		// session_start asked once already, ready re-asks even though that first
		// request is still out — it was asked of a bridge that was not there to
		// answer — and a settled turn asks again: the contract says turn
		// boundaries, never a timer.
		assert.equal(harness.rpcRequests.length, 1);
		assert.equal(harness.rpcRequests[0].method, "cost");
		harness.busEmit("subagents:rpc:v1:ready", { capabilities: { cost: { version: 1 } } });
		assert.equal(harness.rpcRequests.length, 2);
		// A request already out is not stacked by the next boundary: the walk is
		// in flight, and its reply or its timeout closes it.
		await harness.emit("agent_settled", {});
		assert.equal(harness.rpcRequests.length, 2);
		harness.answerCost({
			version: 1,
			parent: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			children: [],
			childTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			total: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			unresolvedAsyncChildren: 0,
		});
		await harness.emit("agent_settled", {});
		assert.equal(harness.rpcRequests.length, 3);
	});

	it("shows cumulative child output on its own segment and row", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagents:rpc:v1:ready", {});
		harness.answerCost(costReport(17_000, 2));

		const line = harness.line(120);
		assert.match(line, /sub 34k tok/, line);
		// The headline and the session rates still describe the parent alone.
		assert.match(line, /400 tok/, line);

		await harness.command("stats");
		const summary = harness.notifications.at(-1) ?? "";
		assert.match(summary, /children {2}34k tok\s+2 subagents · parallel output, never in the rates above/, summary);
		assert.match(summary, /accounted apart from any rate/, summary);
		// The parent's own rows are untouched by the child tokens.
		assert.match(summary, /output {2}400 tok\s+1 message/, summary);
	});

	it("marks the child output as a lower bound when a run could not be read", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagents:rpc:v1:ready", {});
		harness.answerCost(costReport(17_000, 2, 1));

		assert.match(harness.line(120), /sub 34k\+ tok/, harness.line(120));
		await harness.command("stats");
		const summary = harness.notifications.at(-1) ?? "";
		assert.match(summary, /lower bound/, summary);
	});

	it("shows nothing when no child ran, and ignores failed replies", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagents:rpc:v1:ready", {});
		harness.answerCost({
			version: 1,
			parent: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			children: [],
			childTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			total: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			unresolvedAsyncChildren: 0,
		});
		assert.doesNotMatch(harness.line(120), /sub /, harness.line(120));

		// A reply that failed, or data that cannot be identified, changes nothing.
		const request = harness.rpcRequests[harness.rpcRequests.length - 1];
		harness.busEmit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			method: "cost",
			success: false,
			error: { code: "execution_failed", message: "no artifacts" },
		});
		await harness.emit("agent_settled", {});
		harness.busEmit("subagents:rpc:v1:ready", {});
		harness.answerCost({ childTotal: { output: "many" } });
		assert.doesNotMatch(harness.line(120), /sub /, harness.line(120));
	});

	it("keeps the segment while the parent streams, because children run in parallel", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagents:rpc:v1:ready", {});
		harness.answerCost(costReport(17_000, 2));
		await harness.emit("turn_start", {});
		await harness.emit("message_start", { message: { role: "assistant" } });
		await stream(harness, 4, 5);

		const line = harness.line(120);
		assert.match(line, /tok\/s/, line);
		assert.match(line, /sub 34k tok/, line);
	});

	it("works without an event bus, as an older pi host would present itself", async () => {
		const harness = createHarness({ events: false });
		await harness.emit("session_start", { reason: "startup" });
		await harness.emit("agent_settled", {});
		assert.equal(harness.rpcRequests.length, 0);
		await harness.emit("session_shutdown", {});
	});

	/** A fleet view with one running child, the shape a status reply carries. */
	function fleetView(output: number, active = 1, omitted = 0): unknown {
		return {
			version: 1,
			entries: [{ key: "fleet-1", agent: "worker", startedAt: 1, tokens: { input: 100, output, total: 100 + output } }],
			totalActive: active,
			omitted,
		};
	}

	it("shows live child output while a run is in progress", async () => {
		const harness = await startedHarness();
		// An async launch announces itself; the live read that follows draws the
		// child's tokens before any turn boundary has reported them.
		harness.busEmit("subagent:async-started", {});
		harness.answerStatus({ fleet: fleetView(5000) });
		await sleep(0);

		const line = harness.line(120);
		assert.match(line, /sub 5\.0k tok/, line);
		// The headline and the session rates still describe the parent alone.
		assert.match(line, /400 tok/, line);
		assert.doesNotMatch(line, /sub [\d.]+k tok\/s/, line);
	});

	it("adopts a finished child at its completion notice, without double counting", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagent:async-started", {});
		harness.answerStatus({ fleet: fleetView(5000) });
		await sleep(0);
		assert.match(harness.line(120), /sub 5\.0k tok/);

		// The completion notice forces the report that counts the child, and the
		// live read that follows drops it: neither a dip nor a double count.
		harness.busEmit("subagent:async-complete", {});
		harness.answerCost(costReport(6000, 1));
		harness.answerStatus({ fleet: { version: 1, entries: [], totalActive: 0, omitted: 0 } });
		await sleep(0);

		const line = harness.line(120);
		assert.match(line, /sub 6\.0k tok/, line);
		assert.doesNotMatch(line, /sub 11k/, line);
	});

	it("holds a child that left the live view with no completion notice", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagent:async-started", {});
		harness.answerStatus({ fleet: fleetView(5000) });
		await sleep(0);
		assert.match(harness.line(120), /sub 5\.0k tok/);

		// A sibling launch — no completion — triggers the next read, in which the
		// first child has quietly finished mid-workflow: its total is held until
		// a report adopts it, so the segment keeps both children.
		harness.busEmit("subagent:async-started", {});
		harness.answerStatus({
			fleet: {
				version: 1,
				entries: [{ key: "fleet-2", agent: "worker", startedAt: 2, tokens: { input: 50, output: 3000, total: 3050 } }],
				totalActive: 1,
				omitted: 0,
			},
		});
		await sleep(0);
		assert.match(harness.line(120), /sub 8\.0k tok/, harness.line(120));

		// The report that finally counts the held child replaces it, so the two
		// views never add up to a double count.
		await harness.emit("agent_settled", {});
		harness.answerCost({
			version: 1,
			parent: { input: 1000, output: 400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
			children: [
				{
					label: "Child 1 (worker)",
					agent: "worker",
					runId: "r1",
					usage: { input: 100, output: 5000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 4 },
				},
			],
			childTotal: { input: 100, output: 5000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 4 },
			total: { input: 1100, output: 5400, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 5 },
			unresolvedAsyncChildren: 0,
		});
		const line = harness.line(120);
		assert.match(line, /sub 8\.0k tok/, line);
		assert.doesNotMatch(line, /sub 13k/, line);
	});

	it("counts only the running steps of a workflow, never its aggregate row", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagent:async-started", {});
		// The fleet row for a workflow aggregates every child it has finished —
		// 9k here — while the snapshot still reports the run as going, so the
		// steps are asked for instead.
		harness.answerStatus({
			fleet: {
				version: 1,
				entries: [{ key: "fleet-9", agent: "workflow", startedAt: 1, tokens: { input: 0, output: 9000, total: 9000 } }],
				totalActive: 1,
				omitted: 0,
			},
			asyncSnapshot: { version: 1, runs: [{ id: "wf-1", kind: "workflow", state: "running" }] },
		});
		await sleep(0);
		harness.answerStatus({
			details: {
				steps: [
					{ agent: "a", status: "running", tokens: { input: 10, output: 1200, total: 1210 }, workflowKey: "k1" },
					{ agent: "b", status: "running", tokens: { input: 5, output: 800, total: 805 }, workflowKey: "k2" },
					{ agent: "c", status: "complete", tokens: { input: 7, output: 5000, total: 5007 }, workflowKey: "k3" },
				],
			},
		});
		await sleep(0);

		// 1200 + 800 from the running steps; neither the 9k aggregate nor the
		// finished child's 5k may appear.
		const line = harness.line(120);
		assert.match(line, /sub 2\.0k tok/, line);
		assert.doesNotMatch(line, /sub 9\.0k|sub 7\.0k/, line);
	});

	it("marks the live view a lower bound when the fleet view was bounded", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagent:async-started", {});
		harness.answerStatus({ fleet: fleetView(5000, 2, 1) });
		await sleep(0);
		assert.match(harness.line(120), /sub 5\.0k\+ tok/, harness.line(120));
	});

	it("reads a foreground child from the subagent tool call that hosts it", async () => {
		const harness = await startedHarness();
		await harness.emit("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "subagent",
			args: {},
		});
		harness.answerStatus({ fleet: fleetView(3000) });
		await sleep(0);
		assert.match(harness.line(120), /sub 3\.0k tok/);

		// The call ends: the child lands in the session, the report counts it,
		// and the reads stop once the live view is empty.
		await harness.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "t1", toolName: "subagent" });
		harness.answerCost(costReport(3200, 1));
		harness.answerStatus({ fleet: { version: 1, entries: [], totalActive: 0, omitted: 0 } });
		await sleep(0);
		assert.match(harness.line(120), /sub 3\.2k tok/);
	});

	it("falls back to cost alone when the bridge has no fleet view", async () => {
		const harness = await startedHarness();
		harness.busEmit("subagent:async-started", {});
		harness.answerStatus({});
		await sleep(0);
		assert.doesNotMatch(harness.line(120), /sub /, harness.line(120));

		// The installed pi-subagents predates the fleet view: further triggers
		// are ignored rather than retried on a schedule.
		harness.busEmit("subagent:async-started", {});
		await sleep(0);
		const statusRequests = harness.rpcRequests.filter((request) => request.method === "status");
		assert.equal(statusRequests.length, 1);

		// The readiness notice gives a reloaded bridge a second chance.
		harness.busEmit("subagents:rpc:v1:ready", {});
		harness.busEmit("subagent:async-started", {});
		harness.answerStatus({ fleet: fleetView(5000) });
		await sleep(0);
		assert.match(harness.line(120), /sub 5\.0k tok/);
	});
});
