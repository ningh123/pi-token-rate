/**
 * How the token rate is displayed: one adaptive line with the recent rate trace
 * and the session details, trimmed to the available width.
 *
 * Details are ordered by how much they matter, and the line drops them from the
 * right as the terminal narrows, so the live rate and the trace survive longest.
 *
 * The module has no pi imports: styling and the clock are passed in, which keeps
 * it unit testable without a terminal.
 */

import {
	type ChildUsageSnapshot,
	formatDuration,
	formatRate,
	formatRateSegment,
	formatTokens,
	type SessionRateModel,
	SPARK_PLACEHOLDER,
	sparkline,
} from "./metrics.ts";

/** Label column of the `/token-rate stats` report. */
const LABEL_WIDTH = 12;
/** Value column of the same report, so the notes line up. */
const VALUE_WIDTH = 16;
/** Bars drawn in the report's trace row. */
const REPORT_TRACE_WIDTH = 32;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
/** Pads to a column width; token and rate strings are never truncated. */
function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** "1 message", "148 messages". */
function countLabel(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** Styling that returns the text unchanged, for measurements and reports. */
const plainStyle: StyleFn = (_color, text) => text;

/** Theme slots the view uses. */
export type RateColor = "accent" | "dim" | "muted";

/** Applies theme styling to a fragment. */
export type StyleFn = (color: RateColor, text: string) => string;

/** How much of the line to try to show. */
export type DetailLevel = "minimal" | "compact" | "full";

export const DETAIL_LEVELS: readonly DetailLevel[] = ["minimal", "compact", "full"];

/**
 * Shortest trace worth drawing. Four bars is a shape, not a history: below this
 * the line drops details instead, because a trace squeezed to a few columns
 * stops saying anything about the last half-minute.
 */
const MIN_TRACE = 8;

/**
 * Columns the leading glyph occupies.
 *
 * `visibleWidth` counts code units, but `⚡` (U+26A1) is East Asian Wide, so a
 * terminal that follows Unicode's width property draws it two columns wide. The
 * icon is the only glyph on the line outside narrow blocks, so measuring it
 * explicitly is enough to keep the line inside the terminal.
 */
const ICON_WIDTH = 2;

/** Drawn where the trace sits while a call that does not stream is running. */
const SUMMARIZING_BAR = "░";

/**
 * Columns budgeted for the headline rate.
 *
 * The headline is the only part of the line that changes with the token flow, so
 * it is budgeted at its widest rather than its current width: measured, a number
 * that gains or loses a digit would resize the trace on the same frame. Eleven
 * columns is the widest `formatRateSegment` produces for any real rate — "~999k
 * tok/s" — and a test in the formatting suite sweeps the range to keep it so.
 * A rate far enough out to exceed it is measured instead, which costs one bar
 * rather than overflowing the line.
 */
const HEADLINE_RESERVE = 11;

/**
 * Columns reserved for the progress of the message in flight.
 *
 * Its output count grows on every frame, and both of its parts change width: the
 * count crosses from "999 tok" to "1.0k tok", the elapsed time crosses from "9.9s"
 * to "10.2s" and on into minutes. Sixteen columns is the widest the pair can get —
 * an hour and a half of elapsed time, and a four-digit compact count — so budgeting
 * it there keeps both out of the chart's width arithmetic. The price is a few unused
 * columns on a narrow terminal while a message is streaming, which is much cheaper
 * than a chart that resizes itself.
 */
const PROGRESS_RESERVE = 16;

/**
 * Longest message age worth printing. A larger value means the clock and the
 * message start disagree, and a nonsense duration is worse than none.
 */
const MAX_MESSAGE_AGE_MS = 6 * 60 * 60 * 1000;

export interface RateViewSnapshot {
	/** Smoothed session rate shown as the headline number. */
	rate: number;
	/** True when the headline comes from provider-reported usage only. */
	exact: boolean;
	trace: readonly number[];
	/** Vertical scale of the trace, held steady while idle. */
	traceMax: number;
	/** Fastest message average this session. */
	peakRate: number;
	/** Mean time to first token over the messages that reported one. */
	meanTtftMs: number | undefined;
	/** Output tokens for the session, including the message in flight. */
	tokens: number;
	/** Session throughput over measured messages. */
	averageRate: number;
	/** Output tokens of the message in flight. */
	messageTokens: number;
	/** Wall-clock age of the message in flight, first-token wait included. */
	messageElapsedMs: number;
	/** True once the session has produced or recorded any output. */
	hasData: boolean;
	/** What the session is doing right now. */
	activity: "idle" | "streaming" | "summarizing";
	/** Elapsed time of a call that does not stream, 0 otherwise. */
	silentElapsedMs: number;
	/** Bars the trace holds at the configured resolution. */
	traceSlots: number;
	/** Cumulative subagent output, when pi-subagents has reported any. */
	children: ChildReading | undefined;
}

/** The parts of a {@link ChildUsageSnapshot} the line and the report draw. */
export interface ChildReading {
	/** Cumulative output tokens across every counted child. */
	output: number;
	/** Children whose usage was counted. */
	children: number;
	/** True when some async child could not be read, so the output is a lower bound. */
	lowerBound: boolean;
}

/** Inputs for one render. */
export interface RenderOptions {
	style: StyleFn;
	now: number;
	/** Defaults to counting visible columns. */
	measure?: (text: string) => number;
}

/**
 * How the line is displayed, which only the extension knows: the view holds the
 * detail level and the trace resolution, but the side of the editor and whether
 * the line is showing at all belong to the preferences.
 */
export interface RateLayout {
	enabled: boolean;
	position: "above" | "below";
}

/** Presentation of a `SessionRateModel`. */
export class RateView {
	private readonly model: SessionRateModel;
	private detail: DetailLevel;

	constructor(model: SessionRateModel, detail: DetailLevel = "full") {
		this.model = model;
		this.detail = detail;
	}

	get detailLevel(): DetailLevel {
		return this.detail;
	}

	set detailLevel(level: DetailLevel) {
		this.detail = level;
	}

	/**
	 * True when the headline number is measured rather than estimated.
	 *
	 * A message in flight is always an estimate, so the `~` marker stays until
	 * the provider reports its usage.
	 */
	get exact(): boolean {
		return this.model.stats.allExact && !this.model.isMessageActive;
	}

	/** Current values, for tests and for the widget. */
	snapshot(now: number): RateViewSnapshot {
		const live = this.model.live(now);
		const stats = this.model.stats;
		const children = readChildren(this.model.children);
		return {
			// Before anything is generated, show the session rate rather than 0.
			rate: live.smoothed > 0 ? live.smoothed : stats.averageRate,
			exact: this.exact,
			trace: this.model.sparkline,
			traceMax: this.model.traceMax,
			peakRate: stats.peakRate,
			meanTtftMs: stats.meanTtftMs,
			// Recorded messages plus the one in flight, which is not recorded yet.
			tokens: stats.totalTokens + live.messageTokens,
			averageRate: stats.averageRate,
			messageTokens: live.messageTokens,
			messageElapsedMs: this.model.messageElapsedMs(now),
			hasData: stats.hasData || live.tokens > 0,
			activity: live.activity,
			silentElapsedMs: live.silentElapsedMs,
			traceSlots: this.model.tickCount,
			children,
		};
	}

	/**
	 * The widget line for a terminal width:
	 *
	 *   ⚡ ▂▄▆█▆▄▂ ~190 tok/s · 6.4s 1.2k tok · ttft 0.7s · avg 134 tok/s · peak 249 tok/s · 12k tok
	 *
	 * Details follow the rate in order of importance: progress of the message in
	 * flight, then time to first token, then the session average, the session peak,
	 * and the session total. The last three describe messages that have already
	 * ended, so they are left off entirely while a message is streaming.
	 */
	widgetLines(width: number, options: RenderOptions): string[] {
		return buildWidgetLines(this.snapshot(options.now), width, this.detail, options.style, options.measure);
	}

	/**
	 * The numbers as short strings, for command feedback: the current reading,
	 * the session average, and the trace resolution.
	 */
	reading(now: number): { rate: string; session: string; bars: number; tick: string; span: string } {
		const snapshot = this.snapshot(now);
		return {
			rate: formatRateSegment(snapshot.rate, snapshot.exact),
			session: formatRate(snapshot.averageRate),
			bars: this.model.tickCount,
			tick: formatDuration(this.model.tickMs),
			span: formatDuration(this.model.traceSpanMs),
		};
	}

	/**
	 * Multi-line report for `/token-rate stats`, laid out as a right-aligned
	 * label column with a value and a dim note:
	 *
	 *     Token rate · this session
	 *           output  102k tok          148 messages
	 *        generated  14m27s            6.8k tok per minute
	 *       throughput  114 tok/s         session average · now 126 tok/s · peak 312 tok/s
	 *           spread  77 … 312 tok/s    median 110 tok/s
	 *      first token  0.6s              126 of 148 messages timed
	 *           layout  above the editor   detail full
	 *            trace  ▁▆██████████████████████████████  16 bars · 2.0s each · 32.0s span
	 *       every rate comes from provider-reported usage
	 *       a message is in flight, so the totals exclude it
	 */
	summary(now: number, layout?: RateLayout): string {
		const snapshot = this.snapshot(now);
		const rows: string[] = [];
		// A label, a value, and a note that explains coverage or provenance.
		const row = (label: string, value: string, note = "") =>
			// Trailing padding is dropped so an empty note leaves no whitespace.
			rows.push(`${label.padStart(LABEL_WIDTH)}  ${pad(value, VALUE_WIDTH)}${note ? `  ${note}` : ""}`.trimEnd());

		// The report draws a bounded slice of the trace so a long window cannot
		// make the note column run off the side. It is worth reporting even with
		// nothing measured, because it is the current configuration.
		const traceRoom = Math.min(this.model.tickCount, REPORT_TRACE_WIDTH);
		const traceRow = () =>
			row(
				"trace",
				this.model.sparkline.length > 0
					? fitTrace(this.model.sparkline, this.model.traceMax, traceRoom, plainStyle)
					: "·".repeat(traceRoom),
				`${this.model.tickCount} bars · ${formatDuration(this.model.tickMs)} each · ${formatDuration(this.model.traceSpanMs)} span`,
			);

		// What the numbers above were collected and are drawn under. A report that
		// cannot answer "is this the line I configured" sends the reader to /help.
		const layoutRow = () => {
			if (!layout) return;
			row(
				"layout",
				`${layout.position} the editor`,
				`detail ${this.detail}${layout.enabled ? "" : " · display is off, /token-rate on to show it"}`,
			);
		};

		if (!snapshot.hasData) {
			layoutRow();
			traceRow();
			return `Token rate · no output measured in this session yet\n${rows.join("\n")}`;
		}

		const stats = this.model.stats;
		const perMinute = stats.generationMs > 0 ? (stats.measuredTokens / stats.generationMs) * 60_000 : 0;
		row("output", `${formatTokens(snapshot.tokens)} tok`, countLabel(stats.messages, "message"));
		row("generated", formatDuration(stats.generationMs), perMinute > 0 ? `${formatTokens(perMinute)} tok per minute` : "");
		row(
			"throughput",
			formatRate(stats.averageRate),
			`session average · now ${formatRate(this.model.live(now).smoothed)} · peak ${formatRate(stats.peakRate)}`,
		);
		const spread = stats.rateSpread;
		if (spread.fastest > 0) {
			row(
				"spread",
				`${formatTokens(spread.slowest)} … ${formatTokens(spread.fastest)} tok/s`,
				`median ${formatRate(spread.median)}`,
			);
		}
		if (stats.meanTtftMs !== undefined) {
			row(
				"first token",
				formatDuration(stats.meanTtftMs),
				`${stats.ttftMessages} of ${countLabel(stats.messages, "message")} timed`,
			);
		}
		// Summarization calls get their own row rather than a footnote: they are the
		// one recorded output whose window measures something else, and a reader
		// comparing the average against the total has to be able to account for them.
		if (stats.summaryMessages > 0) {
			row(
				"summaries",
				`${formatTokens(stats.summaryTokens)} tok`,
				`${countLabel(stats.summaryMessages, "call", "calls")} · ${formatDuration(stats.summaryElapsedMs)} end to end`,
			);
		}
		// Subagent children are output this session is responsible for but never
		// sees: their sessions stream to nobody here. The row is the whole account,
		// because a number that cannot be timed cannot enter a rate either.
		const children = readChildren(this.model.children);
		if (children) {
			row(
				"children",
				`${formatTokens(children.output)}${children.lowerBound ? "+" : ""} tok`,
				`${countLabel(children.children, "subagent")} · parallel output, never in the rates above`,
			);
		}

		layoutRow();
		traceRow();

		// Only what a reader could otherwise get wrong.
		const notes: string[] = [];
		if (stats.unmeasuredMessages > 0) {
			notes.push(
				`${countLabel(stats.unmeasuredMessages, "message")} arrived faster than a frame: tokens counted, but no rate can be derived from them`,
			);
		}
		if (stats.frontLoadedMessages > 0) {
			notes.push(
				`${countLabel(stats.frontLoadedMessages, "message")} front-loaded the first chunk: the wait before it is unknown rather than small`,
			);
			// With nothing else measurable, the rates on this report come from those
			// windows, and a reader has to be told what they measure. The model
			// decides that, so the condition cannot drift from the one that filled
			// the rates in.
			if (stats.ratesFromBufferedWindows) {
				notes.push(
					"no response could be timed from its own output, so these rates measure the delivery of a buffer rather than the model that wrote it",
				);
			}
		}
		if (stats.summaryMessages > 0) {
			notes.push(
				"summarization is timed end to end, so it counts towards the output but not towards the average, the peak or the spread",
			);
		}
		if (children) {
			notes.push(
				"subagent output is accounted apart from any rate: live per child turn while children run, reconciled from finished runs at turn boundaries",
			);
			if (children.lowerBound) {
				notes.push("some async subagent usage could not be read, so the child output is a lower bound");
			}
		}
		notes.push(
			stats.allExact
				? "every rate comes from provider-reported usage"
				: "rates marked ~ are estimated from stream deltas; the rest are provider-reported",
		);
		if (this.model.isMessageActive) notes.push("a message is in flight, so the totals exclude it");

		return `Token rate · this session\n${rows.join("\n")}\n${notes.map((note) => `  ${note}`).join("\n")}`;
	}
}

/** One detachable piece of the line, in descending order of importance. */
interface Detail {
	text: string;
	/**
	 * Columns this item may need at its widest, used as a floor when the trace field
	 * is budgeted. An item that changes every frame — the progress of the message in
	 * flight — sets one, so its number can be shown without resizing the chart.
	 */
	reserve?: number;
	/** True when the piece would only repeat the headline. */
	repeatsHeadline: boolean;
	/**
	 * True for the session aggregates. They describe messages that already ended,
	 * so while a message is in flight the live rate is the number that matters and
	 * they yield their columns to the trace.
	 */
	hideWhenStreaming?: boolean;
}

/**
 * How many details each level shows, counted from the most important.
 *
 * The details are one ordered sequence, so a level is a cut in that sequence
 * rather than a tag on each item: nothing can be dropped in favour of something
 * that matters less. A detail with nothing to say is left out before the cut, so
 * a missing measurement promotes the next one instead of wasting a slot, and a
 * level never shows an empty gap where a number could have been.
 */
const DETAIL_LIMIT: Record<DetailLevel, number> = { minimal: 1, compact: 2, full: 6 };

/**
 * Assemble the widget line for a width. Exported for tests: the width
 * arithmetic is what can break the layout.
 */
export function buildWidgetLines(
	snapshot: RateViewSnapshot,
	width: number,
	detail: DetailLevel,
	style: StyleFn,
	measure: (text: string) => number = visibleWidth,
): string[] {
	if (width < 12) return [];

	const icon = style("accent", "⚡");
	const separator = style("dim", " · ");
	// One space between the trace and the rate, and the number glued to its own
	// unit. Reserving a fixed field for the rate was tried and reverted twice: a
	// hole before the number is visible on every frame, and padding on the right
	// detaches "tok/s" from its number. Letting the tail shift by a column or two
	// when the rate crosses a digit boundary is the smaller cost.
	const rate = style("accent", formatRateSegment(snapshot.rate, snapshot.exact));

	if (snapshot.activity === "summarizing") {
		// The summary is produced by a call that does not stream to extensions,
		// so no rate exists while it runs. The elapsed wait is the honest
		// substitute, and the session figures still hold.
		const wait = `summarizing ${formatDuration(snapshot.silentElapsedMs)}`;
		const line = `${icon} ${SUMMARIZING_BAR} ${wait}`;
		if (detail === "full" && lineWidth(line, measure) + 12 <= width) {
			return [`${line}${separator}${formatTokens(snapshot.tokens)} tok`];
		}
		return lineWidth(line, measure) <= width ? [line] : [];
	}

	const inFlight = snapshot.messageTokens > 0;
	// The elapsed time of the message in flight, or nothing when there is no message
	// or the clock disagrees with itself. The elapsed time leads because that is the
	// order it is narrated in: "17.8s in, 2.1k tokens".
	const age =
		snapshot.messageElapsedMs > 0 && snapshot.messageElapsedMs < MAX_MESSAGE_AGE_MS
			? formatDuration(snapshot.messageElapsedMs)
			: "";
	// A detail that would render exactly what the headline already shows is noise,
	// so it is dropped. The comparison is on the rendered text rather than on the
	// values: a tolerance would hide a peak of 143 tok/s next to a headline of
	// 145 tok/s, and those are two different numbers.
	const headline = formatRate(snapshot.rate);
	const peakText = `peak ${formatRate(snapshot.peakRate)}`;
	const averageText = `avg ${formatRate(snapshot.averageRate)}`;
	// Importance order, most important first. The line shows a prefix of it, and
	// both the detail level and the terminal width cut it from the right, so the
	// order below is the order things are given up in.
	const all: Detail[] = [];
	// The message in flight: how long it has been running, and what it has produced.
	// Only its reserve, not its measured width, enters the budget, so a count that
	// grows every frame cannot move the columns beside it.
	if (inFlight && age) {
		all.push({
			text: `${age} ${formatTokens(snapshot.messageTokens)} tok`,
			reserve: PROGRESS_RESERVE,
			repeatsHeadline: false,
		});
	}
	// How long the first token took: the closest thing on the line to a latency.
	if (snapshot.meanTtftMs !== undefined) {
		all.push({ text: `ttft ${formatDuration(snapshot.meanTtftMs)}`, repeatsHeadline: false });
	}
	// Output the session is responsible for but never sees: subagent children
	// stream to their own sessions, so their tokens come from what pi-subagents
	// accounts — live per child turn while they run, reconciled at boundaries.
	// It stays on the line while a message streams, because parallel children keep
	// producing through the parent's own reply.
	if (snapshot.children) {
		all.push({
			text: `sub ${formatTokens(snapshot.children.output)}${snapshot.children.lowerBound ? "+" : ""} tok`,
			repeatsHeadline: false,
		});
	}
	// The session average: the benchmark the live rate is read against.
	all.push({ text: averageText, repeatsHeadline: averageText === `avg ${headline}`, hideWhenStreaming: true });
	// The session peak: a high-water mark over messages that already ended, so it
	// is the last thing worth columns.
	all.push({ text: peakText, repeatsHeadline: peakText === `peak ${headline}`, hideWhenStreaming: true });
	// The session total, which changes slowest of all: the first row of
	// /token-rate stats, and the first thing to go when the line runs out of room.
	if (snapshot.tokens > 0) {
		all.push({ text: `${formatTokens(snapshot.tokens)} tok`, repeatsHeadline: false, hideWhenStreaming: true });
	}

	const details = all
		.filter((item) => !(item.hideWhenStreaming && inFlight) && !item.repeatsHeadline)
		.slice(0, DETAIL_LIMIT[detail]);

	// The budget is what is left of the terminal after the icon and the two spaces
	// that frame the trace. One column of it is deliberately left unused at the
	// right edge: the trace has a fixed bar count, so spare columns stay empty
	// rather than padding the numbers.
	const budget = width - ICON_WIDTH - 3;

	// Columns the trace would get with no details at all: the whole window if the
	// terminal can afford it beside the headline, less if it cannot.
	const fieldFor = (count: number): number => {
		let detailsWidth = 0;
		for (const item of details.slice(0, count)) {
			// A reserved item is budgeted at its widest, a settled one at its current
			// width: only the former changes while the session runs.
			detailsWidth += Math.max(measure(style("dim", item.text)), item.reserve ?? 0);
		}
		if (count > 0) detailsWidth += count * measure(separator);
		// The headline is budgeted at its widest rather than measured. It is the one
		// piece of the line that changes with the token flow, and measuring it would
		// make the trace breathe every time the number gained or lost a digit.
		// Reserving its widest form costs a few unused columns at the right edge on
		// some frames, which is much cheaper than a chart that resizes itself. The
		// measured width still wins if it is somehow larger, so the line cannot
		// overflow.
		const tailWidth = Math.max(HEADLINE_RESERVE, measure(rate)) + detailsWidth;
		return Math.min(snapshot.traceSlots, budget - tailWidth);
	};

	// The most details that still leave the trace its whole window. Details compete
	// with the chart for columns, and letting the least important of them halve the
	// trace is the wrong trade: the trace is the only thing on the line that shows a
	// shape over time. The detail list is in importance order, so the last one is
	// what goes.
	let best = -1;
	for (let count = 0; count <= details.length; count++) {
		if (fieldFor(count) < snapshot.traceSlots) break;
		best = count;
	}
	// A terminal too narrow to give the trace its whole window anyway: the details
	// win there, and the chart keeps a readable minimum. Four bars is a shape rather
	// than a history, and a chart that cannot say anything is worse than no chart.
	if (best < 0) {
		for (let count = 0; count <= details.length; count++) {
			if (fieldFor(count) < MIN_TRACE) break;
			best = count;
		}
	}
	if (best < 0) {
		// Nothing wide enough is left for a trace, so the line is the headline alone.
		const bare = `${icon} ${rate}`;
		return lineWidth(bare, measure) <= width ? [bare] : [];
	}
	const fragments = details.slice(0, best).map((item) => style("dim", item.text));
	return [
		`${icon} ${fitTrace(snapshot.trace, snapshot.traceMax, fieldFor(best), style)} ${[rate, ...fragments].join(separator)}`,
	];
}

/**
 * The parts of a child-usage report worth drawing, or undefined when there is
 * nothing to draw. An all-zero report is a session that ran no children, which
 * is the absence of the segment rather than a zero on the line.
 */
function readChildren(usage: ChildUsageSnapshot | undefined): ChildReading | undefined {
	if (!usage) return undefined;
	if (usage.output <= 0 && usage.children <= 0 && usage.unresolved <= 0) return undefined;
	return { output: usage.output, children: usage.children, lowerBound: usage.unresolved > 0 };
}

/**
 * Columns a rendered line occupies.
 *
 * `measure` counts the icon as the one code unit it is, so a line that carries
 * the icon needs exactly one column more than `measure` reports: the icon is
 * {@link ICON_WIDTH} wide, not one.
 */
function lineWidth(text: string, measure: (text: string) => number): number {
	return measure(text) + ICON_WIDTH - 1;
}

/**
 * The trace in exactly `room` columns, padded on the left with the character an
 * empty trace uses.
 *
 * The width is fixed rather than growing with the history: a line that starts
 * short and stretches as bars arrive moves everything to its right on every
 * frame, which reads as the whole line twitching. Padding on the left, rather
 * than on the right, keeps the newest bar next to the rate and lets the trace
 * fill in from the far end. Spaces would leave a hole in the middle of the line
 * instead, which looks like a rendering fault rather than a track waiting for
 * data.
 */
function fitTrace(trace: readonly number[], max: number, room: number, style: StyleFn): string {
	if (trace.length === 0) {
		return style("muted", SPARK_PLACEHOLDER.repeat(room));
	}
	const bars = sparkline(trace, max);
	const visible = bars.length <= room ? bars : bars.slice(bars.length - room);
	const fill = room - visible.length;
	return fill > 0 ? `${style("muted", SPARK_PLACEHOLDER.repeat(fill))}${visible}` : visible;
}

/** Visible columns of a styled string, ignoring ANSI escapes.
 *
 * Escape sequences are the only thing stripped; East Asian width is not applied,
 * because the only glyph this extension draws outside ASCII is the icon, which
 * is measured explicitly as {@link ICON_WIDTH}.
 */
export function visibleWidth(text: string): number {
	return text.replace(ANSI_PATTERN, "").length;
}
