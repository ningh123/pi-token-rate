/**
 * Session-continuous token-rate model.
 *
 * One model per session. It never resets at message boundaries, which is what
 * makes the number and the trace continuous: a tool call in the middle of a turn
 * pauses generation instead of restarting the measurement.
 *
 * This module has no pi imports so it can be unit tested with `node --test`.
 */

/**
 * Average characters per token. Matches pi's own `estimateTokens()` heuristic
 * (4 characters per token) so live numbers are consistent with pi's estimates.
 */
export const CHARS_PER_TOKEN = 4;

/**
 * Time constant of the smoothed rate. Long enough that a short tool call does not
 * read as a restart, short enough to stay responsive.
 */
export const DEFAULT_SMOOTHING_MS = 6000;

/**
 * Width of one sparkline bucket, in milliseconds, for a model that was never
 * configured. The extension sets its own resolution through `configure()`, so this
 * is the fallback a bare `new SessionRateModel()` starts from, not the resolution
 * the line ships with.
 */
export const DEFAULT_BUCKET_MS = 500;

/**
 * Shortest interval used for one rate sample. Deltas arrive in bursts, so
 * sampling over a single millisecond would report a meaningless spike; pooling
 * this long measures the real throughput.
 */
export const MIN_SAMPLE_MS = 40;

/**
 * Minimum smoothing weight used to correct the exponential average.
 *
 * Bias correction alone would let the very first sample of a burst set the
 * displayed rate. Requiring a little weight first damps that first reading while
 * still converging within a couple of seconds.
 */
export const MIN_SAMPLE_WEIGHT = 0.35;

/**
 * Longest interval that counts toward a single smoothing step.
 *
 * Without this, one observation after a long pause carries almost the whole
 * weight of the average: a 30s tool call would replace the rate with a single
 * zero sample, and the first sample after the pause would replace it with one
 * interval. Both read as the number resetting. Capping the step keeps the value
 * continuous no matter how long the gap was.
 */
export const MAX_SMOOTHING_STEP_MS = 1000;

/**
 * Minimum generation time inside a sparkline bucket before that bucket may set
 * the session peak.
 *
 * Providers deliver buffered frames in bursts, so a chunk of tokens arriving in
 * a few milliseconds measures the transport, not the model. Requiring most of a
 * bucket to have been productive makes the peak a sustained rate. The bar is
 * still drawn, so the trace stays honest.
 */
export const MIN_PEAK_ACTIVE_MS = 150;

/**
 * Tokens in the first delta above which the time to first token is not reported.
 *
 * `message_start` fires when the provider opens its stream, so the first delta
 * normally lands within a millisecond of it. When that first delta already
 * carries a sizeable chunk, the provider front-loaded or buffered the response
 * and the interval says nothing about how long the user waited.
 */
export const MAX_FIRST_CHUNK_TOKENS = 16;

/**
 * Shortest raw estimate the calibration is learned from.
 *
 * A handful of characters says nothing about how a provider counts tokens, and a
 * ratio taken from it would be mostly rounding.
 */
const MIN_CALIBRATION_TOKENS = 32;

/**
 * Range the calibration factor may take.
 *
 * Pi's heuristic is four characters per token, which over-counts nothing and
 * under-counts dense scripts: Chinese runs closer to one character per token, so
 * the true factor there is three or four. A ceiling of eight leaves room for that
 * and stops one anomalous response from multiplying every later reading. The floor
 * covers a provider that counts more generously than the characters it delivered.
 */
const MIN_CALIBRATION = 0.25;
const MAX_CALIBRATION = 8;

/** How fast the trace's vertical scale is allowed to fall back, per bar. */
const TRACE_SCALE_RELEASE = 0.97;

/**
 * Shortest time to first token reported as a measurement.
 *
 * `message_start` fires when the provider opens its stream, so a first delta that
 * lands a millisecond later says the events were delivered promptly rather than
 * that the user waited. Below this the interval measures the plumbing, and a
 * handful of those readings would drag the reported mean down to a number nobody
 * experienced.
 */
export const MIN_TTFT_MS = 10;

/**
 * Longest time to first token reported as a measurement.
 *
 * The interval runs from the start of the turn, so a stale reference — a turn
 * that began before the extension was loaded, say — yields an absurd number
 * rather than a slow one. Past this point the clock and the reference disagree,
 * and an unknown wait is better than a wrong one.
 */
export const MAX_TTFT_MS = 10 * 60 * 1000;

/**
 * Shortest generation window a rate can be derived from. A message must have
 * been generating for *longer* than this to be timed.
 *
 * Such a record is excluded from the rate statistics rather than being given a
 * floor, because flooring the window would *raise* the rate and put an invented
 * number into the peak. The comparison is strict, which also discards records
 * written by the version that used to floor short windows to exactly this value.
 */
export const MIN_RATE_WINDOW_MS = 250;

/**
 * Number of buckets kept for the sparkline, for a model that was never configured.
 * With the fallback bucket that is 32 bars of half a second, about sixteen seconds.
 */
export const DEFAULT_BUCKETS = 32;

/** Estimate tokens from a character count using pi's heuristic. */
export function estimateTokensFromChars(chars: number): number {
	if (!Number.isFinite(chars) || chars <= 0) return 0;
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Token units, largest first, so the mantissa never needs more than three digits. */
const TOKEN_UNITS = [
	{ unit: 1_000_000_000_000, suffix: "T" },
	{ unit: 1_000_000_000, suffix: "G" },
	{ unit: 1_000_000, suffix: "M" },
	{ unit: 1_000, suffix: "k" },
] as const;

/**
 * The mantissa of a token count in one unit: one decimal below ten, whole numbers
 * above it.
 *
 * Rounding can carry 9.96 up to `"10.0"`, which is a character wider than the field
 * allows and reads as the next magnitude. The carry keeps its own unit and loses the
 * decimal instead, so 9_960 tokens is `"10k"` and never `"0.0M"`.
 */
function tokenMantissa(value: number, unit: number): string {
	const mantissa = value / unit;
	if (mantissa >= 10) return String(Math.round(mantissa));
	const text = mantissa.toFixed(1);
	return text === "10.0" ? "10" : text;
}

/** Format a token count compactly: 812 -> "812", 12345 -> "12k", 9960 -> "10k". */
export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens)) return "-";
	const value = Math.max(0, Math.round(tokens));
	if (value < 1000) return String(value);
	// The result is never more than four characters wide, which is what lets the
	// widget reserve a fixed field for a number it cannot predict in advance.
	let index = TOKEN_UNITS.findIndex((candidate) => value >= candidate.unit);
	// Nothing to find means the value is at least a thousand, so the smallest unit
	// always matches; the guard only keeps the type from claiming otherwise.
	if (index < 0) index = TOKEN_UNITS.length - 1;
	let text = tokenMantissa(value, TOKEN_UNITS[index].unit);
	// A mantissa that rounded up to four digits moves up a unit rather than
	// printing "1000k": 999_500 tokens is "1.0M", not a thousand thousands.
	while (text.length > 3 && index > 0) {
		index -= 1;
		text = tokenMantissa(value, TOKEN_UNITS[index].unit);
	}
	return `${text}${TOKEN_UNITS[index].suffix}`;
}

/** Format a duration: 820 -> "0.8s", 6400 -> "6.4s", 72000 -> "1m12s". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "-";
	// Sub-second values read as one decimal of a second rather than as
	// milliseconds: "0.8s" sits next to "17.8s" without a change of unit, and the
	// distinction between 45ms and 60ms is not one worth making.
	if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	// Rounding the seconds alone can produce "17m60s", so the carry is folded
	// into the minutes first.
	const total = Math.round(seconds);
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return `${minutes}m${String(rest).padStart(2, "0")}s`;
}

/** Format a rate: 87.4 -> "87 tok/s", 1234 -> "1.2k tok/s". */
export function formatRate(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "0 tok/s";
	return `${formatTokens(tokensPerSecond)} tok/s`;
}

/**
 * The headline rate, with `~` in front when it is estimated from stream deltas
 * rather than reported by the provider.
 */
export function formatRateSegment(tokensPerSecond: number, exact: boolean): string {
	const rate = formatRate(tokensPerSecond);
	return exact ? rate : `~${rate}`;
}

/**
 * Which summarization call produced a record.
 *
 * pi summarizes in two places: context compaction, and the summary offered when
 * `/tree` navigates away from a branch. Both are a real model call whose output
 * never streams to extensions, so neither can be watched while it runs.
 */
export type SummaryKind = "compaction" | "branch-summary";

/**
 * Cumulative usage of the subagent children this session has run.
 *
 * A child is its own pi session: its messages never reach this session's event
 * bus, so nothing about it can be measured while it runs. What pi-subagents
 * reports instead is accounting — the tokens every finished child consumed —
 * read at a turn boundary, which is why this is a snapshot rather than a
 * record: it has no window, and no rate can be derived from it.
 */
export interface ChildUsageSnapshot {
	/** Cumulative output tokens across every counted child. */
	output: number;
	/** Cumulative input tokens across every counted child. */
	input: number;
	/** Cumulative cache-read tokens across every counted child. */
	cacheRead: number;
	/** Children whose usage was counted. */
	children: number;
	/**
	 * Async children whose usage could not be read, so every total above is a
	 * lower bound rather than a complete account.
	 */
	unresolved: number;
}

/** One measured assistant message. */
export interface MessageRecord {
	/** Output tokens: provider-reported when available, else calibrated estimate. */
	tokens: number;
	elapsedMs: number;
	/**
	 * Milliseconds from the start of the turn, or from the end of the previous
	 * step, until the first streamed token. Undefined when the message produced
	 * nothing, when its first chunk was already large, or when the call does
	 * not stream at all.
	 */
	ttftMs?: number;
	/** True when the first delta already carried a sizeable chunk. */
	frontLoadedFirstChunk?: boolean;
	/**
	 * What produced the record. A summarization call is a model call whose
	 * output never streams to extensions, so it is timed but has no live rate
	 * and no measurable time to first token.
	 */
	kind?: SummaryKind;
	/**
	 * What the time to first token was measured from. Records from earlier
	 * versions used the provider's stream-open event, which is a different and
	 * much smaller quantity, so they are not comparable.
	 */
	ttftFrom?: "turn";
	/** Highest sustained output rate inside the message. */
	peakRate: number;
	/** False when `tokens` is an estimate rather than provider-reported usage. */
	exact: boolean;
}

/** Live view of the session, recomputed on demand. */
export interface SessionRateLive {
	/** Smoothed output rate over the whole session. */
	smoothed: number;
	/** Cumulative output tokens for the session. */
	tokens: number;
	/** Highest sustained rate seen this session. */
	peak: number;
	/** Tokens produced so far by the message in flight, 0 when idle. */
	messageTokens: number;
	/** What the session is doing right now. */
	activity: "idle" | "streaming" | "summarizing";
	/** Elapsed time of a call that does not stream, 0 otherwise. */
	silentElapsedMs: number;
}

export interface SessionRateStats {
	/**
	 * Assistant replies recorded, including records merged from session history.
	 * Summarization calls are not replies and are counted on their own, so every
	 * rate and average below describes the same population.
	 */
	messages: number;
	/** Output tokens across every record, including unmeasured ones. */
	totalTokens: number;
	/**
	 * Records whose generation window is long enough to derive a rate from.
	 * Records below that, and records the provider front-loaded, still contribute
	 * tokens but no time, so they cannot distort a rate.
	 */
	measuredMessages: number;
	unmeasuredMessages: number;
	/** Total milliseconds the model spent generating output, measured records only. */
	generationMs: number;
	/** Output tokens of the measured records, the numerator of `averageRate`. */
	measuredTokens: number;
	/** Session throughput: output tokens per generation second. */
	averageRate: number;
	/**
	 * Fastest average rate of any single message.
	 *
	 * A message the provider front-loaded is held back: its whole response was
	 * buffered before any of it was written, so its generation window measures the
	 * transport that delivered the buffer rather than the model that produced it.
	 * The average would survive that, because one inflated record is diluted by the
	 * rest, but a peak is a maximum and would keep the transport speed for the rest
	 * of the session. When every response was buffered there is nothing else to
	 * report, and these rates are used with that caveat.
	 */
	peakRate: number;
	/** Mean time to first token across the messages that reported one. */
	meanTtftMs: number | undefined;
	/** How many messages that mean is based on. */
	ttftMessages: number;
	/** Messages whose first chunk was already large, so their TTFT is unknown. */
	frontLoadedMessages: number;
	/**
	 * Whether the rates on this report were derived from front-loaded windows
	 * because nothing else could be measured, which makes them transport speeds
	 * rather than model speeds. The report has to say so; a report that derived the
	 * same rates for a different reason would not.
	 */
	ratesFromBufferedWindows: boolean;
	/**
	 * Rates of the individual messages, slowest / median / fastest. The median
	 * is what a typical reply achieved; the fastest is the peak.
	 */
	rateSpread: { slowest: number; median: number; fastest: number };
	/**
	 * Summarization calls recorded: context compactions and branch summaries.
	 * They contribute tokens to `totalTokens` and nothing else, because their
	 * window is prefill and queueing rather than tokens arriving.
	 */
	summaryMessages: number;
	/** Output tokens those summarization calls produced. */
	summaryTokens: number;
	/** Total wall-clock time those calls took from start to finish. */
	summaryElapsedMs: number;
	/** True when every recorded call had provider-reported usage. */
	allExact: boolean;
	/** True when anything at all was recorded, summaries included. */
	hasData: boolean;
}

export interface SessionRateOptions {
	/** Time constant of the smoothed rate. */
	smoothingMs?: number;
	/** Sparkline bucket width. */
	bucketMs?: number;
	/** Sparkline history length. */
	buckets?: number;
	/** Estimated-tokens to reported-tokens ratio learned from finished messages. */
	calibration?: number;
}

/**
 * Tracks output-token throughput for a whole session.
 *
 * Deltas from every assistant message feed one continuous series. Rates are
 * derived from the tokens produced between two observations, then smoothed with
 * an exponential moving average, so a burst of deltas inside a few milliseconds
 * cannot dominate the displayed number.
 */
export class SessionRateModel {
	private readonly tau: number;
	private bucketMs: number;
	private bucketLimit: number;
	private calibration: number;

	private chars = 0;
	private lastTokens = 0;
	private emaRaw = 0;
	/** Total smoothing weight applied so far, for bias correction. */
	private weight = 0;
	/** Clock and tokens of the open rate sample. */
	private sampleAt = 0;
	private sampleTokens = 0;

	private bucketStart: number | undefined;
	/**
	 * True once the live clock has a reference point.
	 *
	 * A model starts with a zero clock, and zero is a perfectly good instant in the
	 * tests, so the reference has to be recorded rather than inferred from it.
	 */
	private clockStarted = false;
	private bucketTokens = 0;
	/**
	 * Milliseconds inside the open bucket during which tokens were actually
	 * arriving. A stall adds none, so it cannot stretch a bar or dump the tokens
	 * that follow it into a bar that looks far too fast.
	 */
	private bucketActiveMs = 0;
	private history: number[] = [];
	/**
	 * Vertical scale of the trace, held at its peak and released slowly.
	 *
	 * Normalizing by the maximum of the visible window would rescale every bar
	 * as the window slides, so an idle trace would keep twitching. Recomputing
	 * only when a bar arrives keeps idle frames identical.
	 */
	private traceScale = 0;

	/** A model call whose output does not stream to extensions, such as compaction. */
	private silentKind: SummaryKind | undefined;
	private silentStart = 0;
	/**
	 * Whether the open silent call is still believed to be running.
	 *
	 * Separate from the bookkeeping above on purpose: believing a call is over
	 * must never be what loses its measurement.
	 */
	private silentRunning = false;
	private messageActive = false;
	private messageStart = 0;
	/** Cached statistics, invalidated whenever a record is added or cleared. */
	private statsCache: SessionRateStats | undefined;
	/** When the wait the user cares about started: the turn, or the previous step. */
	private messageTtftFrom = 0;
	private messageFirstTokenAt: number | undefined;
	private messageLastTokenAt: number | undefined;
	private messageStartTokens = 0;
	/** Raw characters at the start of the message, for the calibration ratio. */
	private messageStartChars = 0;
	private messageFirstChunkTokens = 0;
	private messagePeak = 0;

	private records: MessageRecord[] = [];
	/** Latest cumulative child-subagent usage, replaced wholesale at each report. */
	private childUsage: ChildUsageSnapshot | undefined;

	constructor(options: SessionRateOptions = {}) {
		this.tau = options.smoothingMs ?? DEFAULT_SMOOTHING_MS;
		this.bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
		this.bucketLimit = options.buckets ?? DEFAULT_BUCKETS;
		this.calibration = options.calibration && options.calibration > 0 ? options.calibration : 1;
	}

	/** Start (or restart) the live series. Aggregates are kept. */
	begin(now: number): void {
		this.chars = 0;
		this.lastTokens = 0;
		this.emaRaw = 0;
		this.weight = 0;
		this.sampleAt = now;
		this.sampleTokens = 0;
		this.restartTrace(now);
		this.clockStarted = true;
		this.messageActive = false;
		this.messageFirstTokenAt = undefined;
		this.messageLastTokenAt = undefined;
		this.silentKind = undefined;
		this.silentRunning = false;
	}

	get calibrationFactor(): number {
		return this.calibration;
	}

	/** Cumulative calibrated token estimate for the live series. */
	get tokens(): number {
		return estimateTokensFromChars(this.chars) * this.calibration;
	}

	/** Rolling bucket rates for the sparkline, oldest first. */
	get sparkline(): readonly number[] {
		return this.history;
	}

	/**
	 * Vertical scale for the trace. Stable while no bar arrives, so an idle
	 * trace renders identically on every frame.
	 */
	get traceMax(): number {
		return this.traceScale;
	}

	/** Width of one trace bar. */
	get tickMs(): number {
		return this.bucketMs;
	}

	/** Number of bars the trace holds. */
	get tickCount(): number {
		return this.bucketLimit;
	}

	/** Total time span the trace covers. */
	get traceSpanMs(): number {
		return this.bucketMs * this.bucketLimit;
	}

	/**
	 * Change the trace resolution. Aggregates and the live rate are untouched;
	 * the trace restarts so every bar has the same width.
	 *
	 * Only the trace is restarted. A message in flight keeps its identity, so
	 * changing the resolution mid-stream still ends in a record instead of
	 * dropping the tokens the model already produced.
	 */
	configure(options: { bucketMs?: number; buckets?: number }, now: number = Date.now()): void {
		if (options.bucketMs !== undefined && options.bucketMs > 0) this.bucketMs = Math.round(options.bucketMs);
		if (options.buckets !== undefined && options.buckets > 0) this.bucketLimit = Math.round(options.buckets);
		this.restartTrace(now);
	}

	/**
	 * Empty the trace and align it to the current clock. The live rate, the
	 * message in flight, and the aggregates all survive it.
	 */
	private restartTrace(now: number): void {
		this.bucketStart = now;
		this.bucketTokens = 0;
		this.bucketActiveMs = 0;
		this.history = [];
		// A new window starts from nothing, so the old peak must not keep the
		// first bars of the new one flat.
		this.traceScale = 0;
	}

	/** Live view of the session. */
	live(now = Date.now()): SessionRateLive {
		return {
			smoothed: this.smoothed,
			tokens: this.tokens,
			peak: this.peak,
			messageTokens: this.messageActive ? this.tokens - this.messageStartTokens : 0,
			activity: this.isSummarizing ? "summarizing" : this.messageActive ? "streaming" : "idle",
			// A call that does not stream can only be timed from end to end.
			silentElapsedMs: this.isSummarizing ? Math.max(0, now - this.silentStart) : 0,
		};
	}

	/**
	 * True while the line is claiming to be waiting on a call that does not stream.
	 * A call whose end nobody reported is not claimed: see
	 * {@link noteSilentCallEnded}.
	 */
	get isSummarizing(): boolean {
		return this.silentKind !== undefined && this.silentRunning;
	}

	/**
	 * Start tracking a model call whose output does not stream to extensions.
	 *
	 * Compaction and branch summarization are the only such calls pi reports: both
	 * invoke the model directly instead of running the agent loop, so no message
	 * events are emitted and nothing about them can be measured while they run.
	 */
	beginSilentCall(kind: SummaryKind, now: number): void {
		this.silentKind = kind;
		this.silentStart = now;
		this.silentRunning = true;
	}

	/**
	 * Finish such a call. The elapsed time covers the wait as well as the
	 * generation, so it is an end-to-end measurement rather than a generation
	 * speed; the wait is exactly what the user spent, and the record is kept out
	 * of every rate for that reason.
	 */
	endSilentCall(now: number, reportedTokens?: number): MessageRecord | undefined {
		if (this.silentKind === undefined) return undefined;
		const kind = this.silentKind;
		this.silentKind = undefined;
		if (reportedTokens === undefined || reportedTokens <= 0) return undefined;
		const record: MessageRecord = {
			tokens: reportedTokens,
			elapsedMs: Math.max(0, now - this.silentStart),
			peakRate: 0,
			exact: true,
			kind,
		};
		this.mergeRecord(record);
		return record;
	}

	/**
	 * Stop claiming that an open silent call is running, without forgetting it.
	 *
	 * pi does not emit a terminal event for every way a summarization can end:
	 * `navigateTree` returns without `session_tree` when the user aborts the
	 * summary, so the line would otherwise wait on a call that has already ended.
	 * A second opinion from pi closes the claim.
	 *
	 * The timing is kept, not discarded: the terminal event is what turns a call
	 * into a record, and if pi's own state were ever briefly wrong, the usage that
	 * arrives with that event still has to be counted rather than thrown away with
	 * the claim. A call that really was aborted reports no usage and records
	 * nothing, which is the outcome either way.
	 */
	noteSilentCallEnded(): void {
		this.silentRunning = false;
	}

	/**
	 * Smoothed session rate.
	 *
	 * The exponential average is bias corrected, so the first seconds of a burst
	 * are not damped by a smoothing constant that has not elapsed yet.
	 */
	private get smoothed(): number {
		if (this.weight <= 0) return 0;
		return this.emaRaw / Math.max(this.weight, MIN_SAMPLE_WEIGHT);
	}

	/**
	 * Highest sustained rate this session: the fastest message average, or the
	 * current message's live rate while it is still producing.
	 */
	get peak(): number {
		return Math.max(this.stats.peakRate, this.messagePeak);
	}

	/** True while an assistant message is streaming. */
	get isMessageActive(): boolean {
		return this.messageActive;
	}

	/**
	 * Milliseconds the message in flight has been open, including its wait for
	 * the first token. Reported separately from the generation window so the
	 * widget can show progress without folding queueing into the rate.
	 */
	messageElapsedMs(now: number): number {
		if (!this.messageActive) return 0;
		return Math.max(0, now - this.messageStart);
	}

	/**
	 * Mark the start of an assistant message.
	 *
	 * `ttftFrom` is when the wait the user perceives began: the start of the
	 * turn, or the end of the previous step. It defaults to `now`, which is only
	 * correct when the caller has nothing earlier to offer.
	 */
	beginMessage(now: number, ttftFrom?: number): void {
		this.silentKind = undefined;
		this.silentRunning = false;
		this.messageActive = true;
		this.messageStart = now;
		// A reference at or before zero means the caller had nothing to offer, so
		// the message start is used rather than the epoch: the interval would
		// otherwise be the whole clock.
		this.messageTtftFrom = ttftFrom === undefined || ttftFrom <= 0 ? now : Math.min(now, ttftFrom);
		this.messageFirstTokenAt = undefined;
		this.messageLastTokenAt = undefined;
		this.messageStartTokens = this.tokens;
		this.messageStartChars = this.chars;
		this.messageFirstChunkTokens = 0;
		this.messagePeak = 0;
	}

	/**
	 * Feed a streamed text, thinking, or tool-call delta. Empty deltas are
	 * ignored so redacted or whitespace-only chunks do not move the rate.
	 */
	addDelta(delta: string, now: number): void {
		if (!delta) return;
		if (this.messageActive) {
			if (this.messageFirstTokenAt === undefined) {
				this.messageFirstTokenAt = now;
				this.messageFirstChunkTokens = estimateTokensFromChars(delta.length) * this.calibration;
			}
			this.messageLastTokenAt = now;
		}
		this.chars += delta.length;
		this.advance(now, true);
	}

	/**
	 * Advance the clock without new tokens, so the smoothed rate decays while
	 * the agent runs tools. Does not touch the sparkline: the trace shows
	 * generation activity and holds still when nothing is being generated.
	 */
	observe(now: number): void {
		this.advance(now, false);
	}

	/**
	 * Close the current assistant message.
	 *
	 * `reportedTokens` is the provider's `usage.output`. When it is missing the
	 * calibrated estimate is used and the record is marked inexact.
	 */
	endMessage(now: number, reportedTokens?: number): MessageRecord | undefined {
		if (!this.messageActive) return undefined;

		// Close the open rate sample and bucket while the message is still
		// active, so a message shorter than one sample or bucket still
		// contributes a rate, a bar, and its peak.
		this.advance(now, false, true);
		this.flushBucket(now);
		this.messageActive = false;

		const estimated = this.tokens - this.messageStartTokens;
		const reported = typeof reportedTokens === "number" && reportedTokens > 0 ? reportedTokens : undefined;
		const tokens = reported ?? estimated;
		// Throughput is measured over the window in which tokens actually arrived.
		// Queueing, provider retries, and a stall before the first token are not
		// generation time, so they must not lower the reported rate.
		const elapsedMs = this.generationWindowMs();
		// A front-loaded first chunk makes the interval meaningless, so it is
		// reported as unknown rather than as a suspiciously small number.
		const frontLoaded = this.messageFirstChunkTokens > MAX_FIRST_CHUNK_TOKENS;
		const ttftMs =
			this.messageFirstTokenAt === undefined || frontLoaded ? undefined : this.messageFirstTokenAt - this.messageTtftFrom;
		const record: MessageRecord = {
			tokens,
			elapsedMs,
			// Out of range means the reference was stale or the interval too short to
			// mean anything, not that the user waited that precisely.
			ttftMs: ttftMs !== undefined && ttftMs >= MIN_TTFT_MS && ttftMs <= MAX_TTFT_MS ? ttftMs : undefined,
			frontLoadedFirstChunk: frontLoaded || undefined,
			ttftFrom: "turn",
			peakRate: this.messagePeak,
			exact: reported !== undefined,
		};
		// The calibration is learned against pi's own character heuristic, not
		// against the calibrated estimate: a ratio taken from a calibrated number
		// divides the factor it was derived with back out, and the factor oscillates
		// between the true ratio and one on every message.
		this.learnCalibration(record, estimateTokensFromChars(this.chars - this.messageStartChars));
		this.mergeRecord(record);
		return record;
	}

	/**
	 * Latest child-subagent usage, when pi-subagents has reported any.
	 *
	 * The report walks the current session branch, so it is adopted as-is rather
	 * than merged: a branch switch can legitimately lower it, exactly as it
	 * changes which parent records the statistics are seeded from.
	 */
	get children(): ChildUsageSnapshot | undefined {
		return this.childUsage;
	}

	/** Adopt the latest cumulative child-subagent usage for this session. */
	setChildren(usage: ChildUsageSnapshot | undefined): void {
		this.childUsage = usage;
	}

	/**
	 * Add a record recovered from session history, so statistics cover the whole
	 * session even across reloads and resumes.
	 */
	mergeRecord(record: MessageRecord): void {
		this.records.push(record);
		this.statsCache = undefined;
	}

	/**
	 * Session statistics.
	 *
	 * Computed on demand and cached, because the widget reads them several times
	 * per frame and the derivation sorts every message rate.
	 */
	get stats(): SessionRateStats {
		this.statsCache ??= this.computeStats();
		return this.statsCache;
	}

	private computeStats(): SessionRateStats {
		let totalTokens = 0;
		let measuredTokens = 0;
		let generationMs = 0;
		let measuredMessages = 0;
		let peakRate = 0;
		let unmeasuredMessages = 0;
		let frontLoadedMessages = 0;
		const messageRates: number[] = [];
		// The front-loaded records, kept aside: they are transport rates, but if
		// nothing else can be measured they are the only rates the session has.
		const bufferedRates: number[] = [];
		let bufferedTokens = 0;
		let bufferedMs = 0;
		let summaryMessages = 0;
		let summaryTokens = 0;
		let summaryElapsedMs = 0;
		let ttftSum = 0;
		let ttftCount = 0;
		let allExact = this.records.length > 0;

		for (const record of this.records) {
			totalTokens += record.tokens;
			if (!record.exact) allExact = false;

			// A summarization call is a real model call and its output is real, but
			// its window is prefill, queueing and retries rather than tokens arriving
			// at the speed the model produced them. Admitting it would let one
			// end-to-end wall time stand in for a generation speed: a slow summary
			// would drag the session average down, and a fast one would hold the
			// peak for the rest of the session. It is counted apart instead, and
			// every rate below describes replies only.
			if (record.kind !== undefined) {
				summaryMessages++;
				summaryTokens += record.tokens;
				summaryElapsedMs += Math.max(0, record.elapsedMs);
				continue;
			}

			if (record.frontLoadedFirstChunk) frontLoadedMessages++;
			// Only records measured from the same reference are comparable: earlier
			// versions timed from the provider's stream-open event, which is not the
			// wait the user experiences.
			if (record.ttftFrom === "turn" && record.ttftMs !== undefined && record.ttftMs > 0) {
				ttftSum += record.ttftMs;
				ttftCount++;
			}

			// A window this short carries no rate information, so the record
			// contributes its tokens but neither time nor a peak.
			if (record.elapsedMs <= MIN_RATE_WINDOW_MS) {
				if (!record.frontLoadedFirstChunk) unmeasuredMessages++;
				continue;
			}
			const rate = (record.tokens / record.elapsedMs) * 1000;

			// A front-loaded response was buffered before any of it was written, so
			// its window measures the delivery of that buffer rather than the model
			// that produced it. The tokens are real and count towards the total, but
			// the rate is held back: the average would survive it, since one inflated
			// record is diluted by the rest, while a peak is a maximum and would keep
			// the transport speed for the rest of the session.
			if (record.frontLoadedFirstChunk) {
				bufferedRates.push(rate);
				bufferedTokens += record.tokens;
				bufferedMs += record.elapsedMs;
				continue;
			}

			measuredMessages++;
			measuredTokens += record.tokens;
			messageRates.push(rate);
			generationMs += record.elapsedMs;
			if (rate > peakRate) peakRate = rate;
		}

		// With every response buffered there is nothing else to report, and a
		// labelled estimate beats a row of zeros: these are the rates the session
		// actually produced, however much they describe the transport.
		const ratesFromBufferedWindows = measuredMessages === 0 && bufferedRates.length > 0;
		if (ratesFromBufferedWindows) {
			measuredMessages = bufferedRates.length;
			measuredTokens = bufferedTokens;
			generationMs = bufferedMs;
			peakRate = Math.max(...bufferedRates);
			messageRates.push(...bufferedRates);
		}

		messageRates.sort((a, b) => a - b);
		const middle = messageRates.length >> 1;

		return {
			messages: this.records.length - summaryMessages,
			totalTokens,
			measuredMessages,
			unmeasuredMessages,
			measuredTokens,
			generationMs,
			averageRate: generationMs > 0 ? (measuredTokens / generationMs) * 1000 : 0,
			peakRate,
			meanTtftMs: ttftCount > 0 ? ttftSum / ttftCount : undefined,
			ttftMessages: ttftCount,
			frontLoadedMessages,
			ratesFromBufferedWindows,
			rateSpread: {
				slowest: messageRates[0] ?? 0,
				median:
					messageRates.length === 0
						? 0
						: messageRates.length % 2 === 1
							? messageRates[middle]
							: (messageRates[middle - 1] + messageRates[middle]) / 2,
				fastest: messageRates[messageRates.length - 1] ?? 0,
			},
			summaryMessages,
			summaryTokens,
			summaryElapsedMs,
			allExact,
			hasData: this.records.length > 0,
		};
	}

	/** Clear aggregates, including merged history and child usage, and restart the live series. */
	reset(): void {
		this.records = [];
		this.childUsage = undefined;
		this.statsCache = undefined;
		this.begin(Date.now());
	}

	/**
	 * Update the calibration factor from a measured message.
	 *
	 * `rawTokens` is the message's output as pi's heuristic sees it, before any
	 * calibration, so the learned factor is absolute rather than relative to the one
	 * already in use. The ratio is clamped so one anomalous provider response cannot
	 * make future live rates absurd.
	 */
	learnCalibration(record: MessageRecord, rawTokens: number): number {
		if (!record.exact || rawTokens < MIN_CALIBRATION_TOKENS) return this.calibration;
		const ratio = record.tokens / rawTokens;
		if (ratio >= MIN_CALIBRATION && ratio <= MAX_CALIBRATION) this.applyCalibration(ratio);
		return this.calibration;
	}

	/**
	 * Adopt a new calibration factor without inventing tokens.
	 *
	 * Every running reference is moved by the same factor, so the tokens already
	 * counted stay counted: only the rate at which the *next* deltas are converted
	 * changes. Rescaling the references is what keeps a factor change from looking
	 * like a burst — without it, raising the factor credits the whole message again
	 * as fresh output and the live rate diverges on every message.
	 */
	private applyCalibration(next: number): void {
		if (next === this.calibration || !(this.calibration > 0)) return;
		const scale = next / this.calibration;
		this.lastTokens *= scale;
		this.sampleTokens *= scale;
		this.bucketTokens *= scale;
		this.messageStartTokens *= scale;
		this.calibration = next;
	}

	/**
	 * Milliseconds the message spent producing tokens, excluding pauses. Zero
	 * when the message produced nothing, or when its output arrived faster than
	 * a frame batch, in which case no rate can be derived from it.
	 */
	private generationWindowMs(): number {
		const first = this.messageFirstTokenAt;
		const last = this.messageLastTokenAt;
		if (first === undefined || last === undefined) return 0;
		return Math.max(0, last - first);
	}

	/** Fold one observation into the token counters, the trace, and the rate. */
	private advance(now: number, countTokens: boolean, force = false): void {
		// A model that has never been started carries no clock, and changing the
		// resolution deliberately leaves the live series alone, so a fresh model can
		// reach its first delta without one. The first observation is what defines the
		// reference: measuring against the epoch instead would read as a rate of zero
		// and hand the first bar a second of free time.
		if (!this.clockStarted) {
			this.sampleAt = now;
			this.bucketStart = now;
			this.clockStarted = true;
		}

		const tokens = this.tokens;
		const produced = Math.max(0, tokens - this.lastTokens);
		this.lastTokens = tokens;
		if (countTokens) this.sampleTokens += produced;

		// The trace is time based, so it advances on every observation.
		this.flushBuckets(now, countTokens);

		const elapsed = now - this.sampleAt;
		if (elapsed <= 0) return;
		if (!force && elapsed < MIN_SAMPLE_MS) return;

		const instant = (this.sampleTokens / elapsed) * 1000;
		if (this.sampleTokens > 0) {
			// Only time in which tokens were arriving counts as generation time,
			// and a bucket's tokens and time always come from the same samples, so
			// a stall can neither stretch a bar nor inflate the next one.
			this.bucketActiveMs += Math.min(elapsed, MAX_SMOOTHING_STEP_MS);
			this.bucketTokens += this.sampleTokens;
		}
		// Cap the step so a long gap moves the average gradually instead of
		// replacing it. Idle time is still reflected, just not all at once.
		const alpha = 1 - Math.exp(-Math.min(elapsed, MAX_SMOOTHING_STEP_MS) / this.tau);
		this.emaRaw += (instant - this.emaRaw) * alpha;
		// Compound the weight exactly like the average it corrects, so a steady
		// rate reads back unchanged instead of drifting.
		this.weight += alpha * (1 - this.weight);
		this.sampleTokens = 0;
		this.sampleAt = now;
	}

	/** Close every bucket the clock has passed, at most one per observation. */
	private flushBuckets(now: number, emit: boolean): void {
		const start = this.bucketStart ?? now;
		if (now - start < this.bucketMs) return;
		if (emit) {
			this.push(this.bucketTokens, this.bucketActiveMs);
		} else {
			// The trace holds still while the agent runs tools, so the pending
			// bucket is dropped rather than drawn as a bar.
			this.bucketTokens = 0;
			this.bucketActiveMs = 0;
		}
		// Keep the remainder so buckets stay aligned to the series start.
		this.bucketStart = now - ((now - start) % this.bucketMs);
	}

	/** Close the open bucket immediately, e.g. at the end of a message. */
	private flushBucket(now: number): void {
		const start = this.bucketStart ?? now;
		if (now - start <= 0) return;
		this.push(this.bucketTokens, this.bucketActiveMs);
		this.bucketStart = now;
	}

	/**
	 * Record one bar. A bucket with no generation time is a zero-rate bar, which
	 * is what a stall looks like: idle in the trace, never a fake rate.
	 *
	 * `activeMs` decides whether the bucket may set the peak, so a single burst
	 * of buffered frames cannot become the session's top speed.
	 */
	private push(tokens: number, activeMs: number): void {
		const rate = activeMs > 0 && Number.isFinite(tokens) ? tokens / (activeMs / 1000) : 0;
		this.bucketTokens = 0;
		this.bucketActiveMs = 0;
		this.history.push(rate);
		if (this.history.length > this.bucketLimit) this.history.shift();
		this.traceScale = Math.max(rate, this.traceScale * TRACE_SCALE_RELEASE);
		if (activeMs >= MIN_PEAK_ACTIVE_MS && this.messageActive && rate > this.messagePeak) {
			this.messagePeak = rate;
		}
	}
}

/** Characters used to draw a sparkline bar, from lowest to highest. */
export const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Placeholder drawn where the sparkline has no data yet. */
export const SPARK_PLACEHOLDER = "·";

/**
 * Render values as a sparkline.
 *
 * `max` fixes the vertical scale. Passing one keeps an idle trace from
 * twitching: without it the scale follows the visible window, so every bar is
 * rescaled as the window slides.
 */
export function sparkline(values: readonly number[], max?: number): string {
	if (values.length === 0) return "";
	const scale = max === undefined ? Math.max(0, ...values) : max;
	if (scale <= 0) return SPARK_CHARS[0].repeat(values.length);
	return values
		.map((value) => {
			const ratio = Math.max(0, Math.min(1, value / scale));
			const index = Math.min(SPARK_CHARS.length - 1, Math.round(ratio * (SPARK_CHARS.length - 1)));
			return SPARK_CHARS[index];
		})
		.join("");
}
