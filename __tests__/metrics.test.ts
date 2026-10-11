/**
 * Unit tests for the session-continuous rate model.
 *
 * Run with:
 *   npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CHARS_PER_TOKEN,
	estimateTokensFromChars,
	formatDuration,
	formatRate,
	formatRateSegment,
	formatTokens,
	MAX_TTFT_MS,
	SessionRateModel,
	SPARK_CHARS,
	sparkline,
} from "../metrics.ts";

/**
 * Stream `chars` characters per delta for `spanMs`, in `deltas` steps.
 * Returns the clock after the last delta.
 */
function stream(
	model: SessionRateModel,
	opts: { deltas: number; chars: number; spanMs: number; startAt?: number; observeEachStep?: boolean },
): number {
	const startAt = opts.startAt ?? 0;
	const stepMs = opts.spanMs / opts.deltas;
	const text = "x".repeat(opts.chars);
	let at = startAt;
	for (let i = 1; i <= opts.deltas; i++) {
		at = startAt + i * stepMs;
		// An extra observation one millisecond earlier, as a tool or status event
		// would produce, so the smoothed rate sees real elapsed time.
		if (opts.observeEachStep) model.observe(at - 1);
		model.addDelta(text, at);
	}
	return at;
}

describe("token estimation", () => {
	it("uses pi's characters-per-token heuristic", () => {
		assert.equal(CHARS_PER_TOKEN, 4);
		assert.equal(estimateTokensFromChars(4), 1);
		assert.equal(estimateTokensFromChars(9), 3);
		assert.equal(estimateTokensFromChars(0), 0);
	});

	it("treats invalid or negative character counts as zero", () => {
		assert.equal(estimateTokensFromChars(-10), 0);
		assert.equal(estimateTokensFromChars(Number.NaN), 0);
	});
});

describe("formatting", () => {
	it("formats token counts compactly", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(812), "812");
		assert.equal(formatTokens(1234), "1.2k");
		assert.equal(formatTokens(12345), "12k");
		assert.equal(formatTokens(2_500_000), "2.5M");
		// Rounding must not carry into a four-digit mantissa: the widget budgets a
		// fixed field for a rate, so the compact form has a hard width limit.
		assert.equal(formatTokens(999_500), "1.0M");
		assert.equal(formatTokens(999_999_999), "1.0G");
		assert.equal(formatTokens(1_000_000_000), "1.0G");
		// The other carry: a mantissa just under ten rounds to "10.0", which is a
		// character too wide and would be promoted to the next unit — where it
		// reads as almost nothing. A 10k-token reply is ordinary, so the carry keeps
		// its own unit and drops the decimal instead.
		assert.equal(formatTokens(9960), "10k");
		assert.equal(formatTokens(9999), "10k");
		assert.equal(formatTokens(9_960_000), "10M");
		assert.equal(formatTokens(9_999_500), "10M");
		// 9.95 itself does not carry: 9.95 is stored just below the midpoint, so the
		// first value that does is 9.955.
		assert.equal(formatTokens(9_950_000_000), "9.9G");
		assert.equal(formatTokens(9_955_000_000), "10G");
		// Promotion has to keep counting units: a kilo of billions is trillions.
		assert.equal(formatTokens(999_950_000_000), "1.0T");
		assert.equal(formatTokens(5_000_000_000_000), "5.0T");
	});

	it("never renders a token count as a collapse to zero", () => {
		// Every compact form has to stay within a rounding error of the value it
		// stands for, whatever the magnitude. A "0.0M" for 9,960 tokens is not a
		// formatting quirk: it is a number that reads as nothing next to a rate the
		// reader has just seen.
		const units: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
		for (let value = 1000; value <= 2e13; value = Math.ceil(value * 1.0007)) {
			const text = formatTokens(value);
			assert.ok(text.length <= 4, `${value} -> "${text}" is wider than the reserved field`);
			const shown = Number(text.slice(0, -1)) * (units[text.slice(-1)] ?? 1);
			assert.ok(
				shown >= value * 0.92 && shown <= value * 1.08,
				`${value} -> "${text}" stands for ${shown}, which is not the same number`,
			);
		}
	});

	it("keeps a compact rate within the width the widget reserves", () => {
		// `HEADLINE_RESERVE` in rate-view.ts is eleven columns, and this is what
		// keeps that true: six for " tok/s", one for the estimate marker, and four
		// for the number.
		for (let exponent = -2; exponent <= 9; exponent++) {
			for (let mantissa = 1; mantissa < 1000; mantissa++) {
				const rate = mantissa * 10 ** exponent;
				for (const exact of [true, false]) {
					assert.ok(formatRateSegment(rate, exact).length <= 11, `${rate} renders as ${formatRateSegment(rate, exact)}`);
				}
			}
		}
	});

	it("formats durations", () => {
		// Sub-second values stay in seconds, so a line never changes unit.
		assert.equal(formatDuration(820), "0.8s");
		assert.equal(formatDuration(400), "0.4s");
		assert.equal(formatDuration(999), "1.0s");
		assert.equal(formatDuration(6400), "6.4s");
		assert.equal(formatDuration(72_000), "1m12s");
		// Rounding the seconds on their own produced "17m60s" and "16m60s" here.
		assert.equal(formatDuration(1_079_600), "18m00s");
		assert.equal(formatDuration(1_019_900), "17m00s");
		assert.equal(formatDuration(-1), "-");
	});

	it("formats rates and guards against non-positive values", () => {
		assert.equal(formatRate(87.4), "87 tok/s");
		assert.equal(formatRate(0), "0 tok/s");
		assert.equal(formatRate(Number.NaN), "0 tok/s");
		assert.equal(formatRate(1500), "1.5k tok/s");
	});

	it("marks estimated segments and keeps them ASCII", () => {
		// The line is measured in code units to place the trace, so a glyph that
		// may render two columns wide would shift every column after it.
		assert.equal(formatRateSegment(87.4, true), "87 tok/s");
		assert.equal(formatRateSegment(87.4, false), "~87 tok/s");
		for (const rate of [0, 1, 87.4, 1500, 1_250_000]) {
			for (const exact of [true, false]) {
				assert.match(formatRateSegment(rate, exact), /^[\x20-\x7e]+$/);
			}
		}
	});
});

describe("SessionRateModel live series", () => {
	it("accumulates tokens across message boundaries", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		stream(model, { deltas: 10, chars: 40, spanMs: 1000 });
		const first = model.endMessage(1000);
		assert.equal(first?.tokens, 100);

		// A second message continues the same series instead of resetting it.
		model.beginMessage(1000);
		stream(model, { deltas: 10, chars: 40, spanMs: 1000, startAt: 1000 });
		const second = model.endMessage(2000);
		assert.equal(second?.tokens, 100);
		assert.equal(model.tokens, 200);
		assert.equal(model.stats.messages, 2);
		assert.equal(model.stats.totalTokens, 200);
	});

	it("keeps the smoothed rate continuous across a tool call", () => {
		const model = new SessionRateModel({ smoothingMs: 6000 });
		model.begin(0);
		model.beginMessage(0);
		stream(model, { deltas: 20, chars: 40, spanMs: 1000, observeEachStep: true });
		const duringMessage = model.live().smoothed;
		model.endMessage(1000);

		// A two-second tool call: the rate decays smoothly instead of resetting.
		model.observe(1500);
		const midway = model.live().smoothed;
		model.observe(2000);
		const afterTool = model.live().smoothed;
		assert.ok(midway < duringMessage, "rate decays while tools run");
		assert.ok(afterTool < midway, "and keeps decaying");
		assert.ok(afterTool > 0, "but never snaps back to zero");
		assert.ok(afterTool > duringMessage * 0.4, `and stays in the same range: ${duringMessage} -> ${afterTool}`);

		// The trace holds its shape while nothing is generated.
		const held = model.sparkline.length;
		model.observe(3000);
		assert.equal(model.sparkline.length, held, "no bars are drawn while idle");
	});

	it("does not collapse to zero during a long tool call", () => {
		const model = new SessionRateModel({ smoothingMs: 6000 });
		model.begin(0);
		model.beginMessage(0);
		for (let i = 1; i <= 60; i++) model.addDelta("x".repeat(40), i * 50);
		const streaming = model.live().smoothed;
		model.endMessage(3000);

		// A long tool call reports the clock twice: start and end.
		model.observe(3000);
		model.observe(33_000);
		const afterTool = model.live().smoothed;
		assert.ok(afterTool > streaming * 0.5, `the rate must not collapse: ${streaming} -> ${afterTool}`);
		assert.ok(afterTool < streaming, "but it does fade while nothing is generated");
	});

	it("is not replaced by the first sample after a long pause", () => {
		const model = new SessionRateModel({ smoothingMs: 6000 });
		model.begin(0);
		model.beginMessage(0);
		for (let i = 1; i <= 60; i++) model.addDelta("x".repeat(40), i * 50);
		const before = model.live().smoothed;
		model.endMessage(3000);

		// A new message after a long gap converges gradually.
		model.beginMessage(30_000);
		model.addDelta("x".repeat(400), 30_100);
		const firstSample = model.live().smoothed;
		assert.ok(
			Math.abs(firstSample - before) < before * 0.5,
			`one sample must not replace the average: ${before} -> ${firstSample}`,
		);
		for (let i = 2; i <= 40; i++) model.addDelta("x".repeat(40), 30_000 + i * 50);
		const settled = model.live().smoothed;
		assert.ok(settled > firstSample, "and it keeps climbing towards the real rate");
	});

	it("ignores empty deltas so they do not move time to first token", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		model.addDelta("", 100);
		model.addDelta("abcd", 150);
		const record = model.endMessage(200);
		assert.equal(record?.ttftMs, 150);
	});

	it("measures the wait from the message start when the turn start is unknown", () => {
		const model = new SessionRateModel();
		model.begin(0);
		// A reference of zero is what a caller with nothing to offer can end up
		// passing; measuring from it would report the whole clock as the wait.
		model.beginMessage(1_000_000, 0);
		model.addDelta("abcd", 1_000_150);
		const record = model.endMessage(1_000_400);
		assert.equal(record?.ttftMs, 150);
	});

	it("refuses a wait too short to be one", () => {
		const model = new SessionRateModel();
		model.begin(0);
		// The provider opens the stream and the first delta arrives with the next
		// event: that measures the plumbing, not the user.
		model.beginMessage(1000, 1000);
		model.addDelta("abcd", 1002);
		assert.equal(model.endMessage(1500)?.ttftMs, undefined, "two milliseconds is not a wait");
	});

	it("refuses a time to first token no user could have waited", () => {
		const model = new SessionRateModel();
		model.begin(0);
		// A reference left over from a turn that ended hours ago.
		model.beginMessage(1_000, 1);
		model.addDelta("abcd", MAX_TTFT_MS + 60_000);
		const record = model.endMessage(MAX_TTFT_MS + 61_000);
		assert.equal(record?.ttftMs, undefined, "an unknown wait, not a wrong one");
		assert.equal(record?.ttftFrom, "turn", "the record still says what it measured from");
	});

	it("takes its clock from the first observation when it was never started", () => {
		// `configure` restarts the trace without touching the live series, so a fresh
		// model can reach its first delta without a clock. Measuring that delta
		// against the epoch would read as a rate of zero and hand the first bar a
		// second of free time, which dilutes it.
		const model = new SessionRateModel();
		model.configure({ bucketMs: 1000, buckets: 8 });
		model.beginMessage(1000);
		// 100 tokens every 100ms is 1000 tok/s.
		for (let i = 1; i <= 20; i++) model.addDelta("x".repeat(400), 1000 + i * 100);
		const record = model.endMessage(3000, 2000);

		const bars = [...model.sparkline];
		assert.ok(bars.length > 0, "the trace recorded something");
		assert.ok(
			bars.every((bar) => bar > 900),
			`a bar was diluted by the clock: ${bars}`,
		);
		// The exponential average is damped for the first samples on purpose, so
		// this checks it converged rather than that it started high.
		assert.ok(model.live(3000).smoothed > 800, `the rate never left the epoch: ${model.live(3000).smoothed}`);
		// The window is the time between the first and the last token, not the
		// distance from the epoch.
		assert.ok((record?.elapsedMs ?? 0) > 1500, `the window was measured against the epoch: ${record?.elapsedMs}`);
	});

	it("keeps the message in flight when the resolution changes", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		model.addDelta("x".repeat(400), 100);
		model.configure({ bucketMs: 2000, buckets: 8 });
		assert.equal(model.isMessageActive, true, "the trace restarts, the message does not");
		model.addDelta("x".repeat(400), 300);
		const record = model.endMessage(500, 200);
		assert.equal(record?.tokens, 200, "the tokens streamed before the change are still counted");
	});

	it("survives a clock that does not advance", () => {
		const model = new SessionRateModel();
		model.begin(1000);
		model.beginMessage(1000);
		model.addDelta("x".repeat(40), 1000);
		model.addDelta("x".repeat(40), 1000);
		const live = model.live();
		assert.ok(Number.isFinite(live.smoothed));
		assert.equal(live.tokens, 20);
		// A zero-length window carries no rate, so the record is left untimed
		// rather than given a floor that would inflate one.
		const record = model.endMessage(1000);
		assert.equal(record?.elapsedMs, 0);
		assert.equal(model.stats.measuredMessages, 0);
		assert.equal(model.stats.totalTokens, 20, "its tokens still count");
	});

	it("excludes time to first token from the message rate", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		// 30 seconds of queueing or provider retries before the first token.
		for (let i = 1; i <= 60; i++) model.addDelta("x".repeat(40), 30_000 + i * 50);
		const record = model.endMessage(33_000);
		assert.equal(record?.ttftMs, 30_050);
		assert.equal(record?.elapsedMs, 2950, "only the generation window counts");
		assert.ok(Math.abs(((record?.tokens ?? 0) / (record?.elapsedMs ?? 1)) * 1000 - 203) < 5);
	});

	it("does not let a stall distort the trace or the peak", () => {
		const model = new SessionRateModel({ bucketMs: 500 });
		model.begin(0);
		model.beginMessage(0);
		// 1s at a steady 200 tok/s, a 4s stall, then 1s at the same rate.
		for (let i = 1; i <= 20; i++) model.addDelta("x".repeat(40), i * 50);
		for (let i = 1; i <= 20; i++) model.addDelta("x".repeat(40), 5000 + i * 50);
		const record = model.endMessage(6000);

		const bars = model.sparkline.map((rate) => Math.round(rate));
		// Every bar is at the real rate, except the one that straddles the stall:
		// that slice was genuinely part idle, so it reads lower.
		const off = bars.filter((rate) => Math.abs(rate - 200) > 20);
		assert.ok(off.length <= 1, `stall distorted the trace: ${bars}`);
		assert.ok(
			bars.every((rate) => rate <= 260),
			`no bar may exceed the real rate: ${bars}`,
		);
		assert.ok(Math.abs((record?.peakRate ?? 0) - 200) < 20, `peak is not the real rate: ${record?.peakRate}`);
		assert.ok((record?.elapsedMs ?? 0) > 0);
	});

	it("prefers provider-reported usage and learns calibration", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		stream(model, { deltas: 20, chars: 40, spanMs: 1000, observeEachStep: true });
		const record = model.endMessage(1000, 400);
		assert.equal(record?.tokens, 400);
		assert.equal(record?.exact, true);
		assert.equal(model.calibrationFactor, 2);

		// The next message is estimated with the learned factor.
		model.beginMessage(1000);
		stream(model, { deltas: 10, chars: 40, spanMs: 1000, startAt: 1000, observeEachStep: true });
		assert.equal(model.live().messageTokens, 200);
	});

	it("keeps the calibration factor steady across messages", () => {
		// The factor is learned against pi's character heuristic, not against the
		// already calibrated estimate. A relative ratio divides the factor it came
		// from back out, and the factor then oscillates between the true value and
		// one on every message.
		const model = new SessionRateModel();
		model.begin(0);
		// A provider that counts four times the characters pi can see.
		for (let message = 0; message < 5; message++) {
			const at = message * 4000;
			model.beginMessage(at, at);
			stream(model, { deltas: 20, chars: 100, spanMs: 2000, startAt: at });
			model.endMessage(at + 2000, 2000);
			assert.equal(model.calibrationFactor, 4, `the factor drifted on message ${message + 1}`);
		}
		// A factor that changes mid-session must not look like a burst of output:
		// raising it used to credit the whole message again as fresh tokens, and the
		// live rate grew without bound.
		assert.ok(model.live(20_000).smoothed < 2000, `the live rate diverged: ${model.live(20_000).smoothed}`);
		const bars = [...model.sparkline];
		assert.ok(
			bars.every((bar) => bar < 2000),
			`a bar was inflated by the factor: ${bars}`,
		);
	});

	it("falls back to the estimate when the provider reports nothing", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		stream(model, { deltas: 10, chars: 40, spanMs: 1000 });
		const record = model.endMessage(1000, 0);
		assert.equal(record?.exact, false);
		assert.equal(record?.tokens, 100);
	});

	it("ignores endMessage without a matching beginMessage", () => {
		const model = new SessionRateModel();
		model.begin(0);
		assert.equal(model.endMessage(100), undefined);
		assert.equal(model.stats.messages, 0);
	});

	it("records a bucket for a message shorter than one bucket", () => {
		const model = new SessionRateModel({ bucketMs: 500 });
		model.begin(0);
		model.beginMessage(0);
		stream(model, { deltas: 4, chars: 100, spanMs: 200 });
		const record = model.endMessage(200);
		assert.equal(model.sparkline.length, 1);
		// 400 chars -> 100 tokens in 0.2s -> 500 tok/s.
		assert.equal(record?.peakRate, 500);
		assert.equal(model.peak, 500);
	});

	it("keeps the trace bounded and drops the oldest buckets", () => {
		const model = new SessionRateModel({ bucketMs: 100, buckets: 4 });
		model.begin(0);
		model.beginMessage(0);
		for (let i = 1; i <= 20; i++) model.addDelta("x".repeat(40), i * 100);
		// 10 tokens per 100ms is a steady 100 tok/s in every bucket.
		assert.equal(model.sparkline.length, 4);
		assert.deepEqual(model.sparkline, [100, 100, 100, 100]);
	});

	it("converges on the real rate instead of a burst spike", () => {
		const model = new SessionRateModel({ smoothingMs: 4000 });
		model.begin(0);
		model.beginMessage(0);
		// 40 characters every 50ms is 10 tokens, so 200 tok/s.
		for (let i = 1; i <= 60; i++) model.addDelta("x".repeat(40), i * 50);
		const smoothed = model.live().smoothed;
		assert.ok(Math.abs(smoothed - 200) < 5, `expected ~200 tok/s, got ${smoothed}`);
		assert.ok(model.peak <= 210, `peak should not exceed the real rate, got ${model.peak}`);
	});
});

describe("SessionRateModel statistics", () => {
	it("reports zeros for an empty session", () => {
		const stats = new SessionRateModel().stats;
		assert.equal(stats.messages, 0);
		assert.equal(stats.hasData, false);
		assert.equal(stats.totalTokens, 0);
		assert.equal(stats.averageRate, 0);
		assert.equal(stats.meanTtftMs, undefined);
		assert.equal(stats.allExact, false);
	});

	it("weights the session rate by generation time", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 100, elapsedMs: 1000, ttftMs: 200, ttftFrom: "turn", peakRate: 120, exact: true });
		model.mergeRecord({ tokens: 900, elapsedMs: 9000, ttftMs: 400, ttftFrom: "turn", peakRate: 150, exact: true });
		const stats = model.stats;
		assert.equal(stats.messages, 2);
		assert.equal(stats.totalTokens, 1000);
		assert.equal(stats.generationMs, 10_000);
		assert.equal(stats.averageRate, 100);
		assert.equal(stats.meanTtftMs, 300);
		// Both messages average 100 tok/s, so the peak equals the average.
		assert.equal(stats.peakRate, 100);
		assert.equal(stats.allExact, true);
		assert.equal(stats.hasData, true);
	});

	it("merges records recovered from session history", () => {
		const model = new SessionRateModel();
		// A previous run measured 400 tokens in 4s.
		model.mergeRecord({ tokens: 400, elapsedMs: 4000, ttftMs: 500, peakRate: 130, exact: true });
		model.begin(Date.now());
		model.beginMessage(1000);
		stream(model, { deltas: 10, chars: 40, spanMs: 1000, startAt: 1000, observeEachStep: true });
		model.endMessage(2000, 200);

		const stats = model.stats;
		assert.equal(stats.messages, 2, "history and live messages are counted together");
		assert.equal(stats.totalTokens, 600);
		// The live message is measured over its generation window, not the span
		// from message_start, so the total is 4000ms plus the streamed window.
		assert.ok(stats.generationMs >= 4900 && stats.generationMs <= 5000, `generationMs: ${stats.generationMs}`);
		assert.ok(Math.abs(stats.averageRate - 120) < 5, `averageRate: ${stats.averageRate}`);
		// The peak is the fastest message average: 200 tokens in 0.9s.
		assert.ok(Math.abs(stats.peakRate - 222) < 5, `peakRate: ${stats.peakRate}`);
	});

	it("flags sessions that contain estimated messages", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 100, elapsedMs: 1000, ttftMs: 100, ttftFrom: "turn", peakRate: 100, exact: true });
		assert.equal(model.stats.allExact, true);
		model.mergeRecord({ tokens: 100, elapsedMs: 1000, ttftMs: undefined, ttftFrom: "turn", peakRate: 100, exact: false });
		assert.equal(model.stats.allExact, false);
		assert.equal(model.stats.meanTtftMs, 100, "estimated messages without ttft are skipped");
	});

	it("keeps a front-loaded response out of the peak", () => {
		const model = new SessionRateModel();
		// A message that streamed: 1200 tokens over 20s is 60 tok/s.
		model.mergeRecord({ tokens: 1200, elapsedMs: 19_900, peakRate: 63, exact: true });
		// A message the provider buffered and flushed in 288ms. The tokens are real,
		// but the window measures the delivery of the buffer, not the model.
		model.mergeRecord({ tokens: 1200, elapsedMs: 288, peakRate: 2083, exact: true, frontLoadedFirstChunk: true });
		const stats = model.stats;
		assert.ok(Math.abs(stats.peakRate - 60) < 1, `the transport rate became the session peak: ${stats.peakRate}`);
		assert.ok(Math.abs(stats.averageRate - 60) < 1, `the average is diluted, not poisoned: ${stats.averageRate}`);
		assert.equal(stats.totalTokens, 2400, "its tokens still count");
		assert.equal(stats.frontLoadedMessages, 1);
		assert.equal(stats.measuredMessages, 1, "and it contributes no time to the rates");
		assert.equal(stats.unmeasuredMessages, 0, "it is not reported as too short to time");
	});

	it("reports buffered rates when nothing else can be measured", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 1200, elapsedMs: 288, peakRate: 0, exact: true, frontLoadedFirstChunk: true });
		const stats = model.stats;
		// A labelled estimate beats a row of zeros.
		assert.ok(stats.peakRate > 4000, `the only rate the session has: ${stats.peakRate}`);
		assert.equal(stats.measuredMessages, 1);
		assert.equal(stats.ratesFromBufferedWindows, true, "which is what the report labels");
	});

	it("flags buffered rates however many unmeasurable records sit beside them", () => {
		// The report has to say when its rates measure a transport rather than a
		// model, and it must not depend on every record being front-loaded for that
		// to be true: a session that also holds a record too short to time still
		// has no other rate to show, and still needs the caveat.
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 1200, elapsedMs: 288, peakRate: 0, exact: true, frontLoadedFirstChunk: true });
		// Too short to derive a rate from, and not front-loaded.
		model.mergeRecord({ tokens: 40, elapsedMs: 80, peakRate: 0, exact: true });
		const stats = model.stats;
		assert.notEqual(stats.frontLoadedMessages, stats.messages, "not every record is front-loaded");
		assert.equal(stats.unmeasuredMessages, 1);
		assert.equal(stats.ratesFromBufferedWindows, true, "but the rates still come from the buffer");
	});

	it("does not flag buffered rates when a real measurement exists", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 1200, elapsedMs: 288, peakRate: 0, exact: true, frontLoadedFirstChunk: true });
		model.mergeRecord({ tokens: 1200, elapsedMs: 19_900, peakRate: 60, exact: true });
		const stats = model.stats;
		assert.equal(stats.frontLoadedMessages, 1);
		assert.equal(stats.ratesFromBufferedWindows, false, "the report's rates are the model's own, so no caveat");
	});

	it("derives the peak from message averages, ignoring recorded maxima", () => {
		const model = new SessionRateModel();
		// A recorded peakRate of 950 came from buffered frames in an older run;
		// the peak must be recomputed from tokens and generation time instead.
		model.mergeRecord({ tokens: 100, elapsedMs: 1000, ttftMs: 10, peakRate: 400, exact: true });
		model.mergeRecord({ tokens: 900, elapsedMs: 1000, ttftMs: 10, peakRate: 950, exact: true });
		const stats = model.stats;
		assert.equal(stats.peakRate, 900, "the fastest message average");
		assert.equal(stats.averageRate, 500);
	});

	it("keeps the peak identical before and after a reload", () => {
		const stored = { tokens: 1554, elapsedMs: 11_153, ttftMs: 0, peakRate: 1243, exact: true };
		const before = new SessionRateModel();
		before.mergeRecord(stored);
		const after = new SessionRateModel();
		for (const entry of [stored]) after.mergeRecord(entry);
		assert.equal(after.stats.peakRate, before.stats.peakRate);
		assert.ok(after.stats.peakRate < 200, `peak should be the real rate, got ${after.stats.peakRate}`);
	});

	it("lets a burst of buffered frames set neither the peak nor the bars", () => {
		const model = new SessionRateModel({ bucketMs: 500 });
		model.begin(0);
		model.beginMessage(0);
		let t = 0;
		// Three seconds at a steady 140 tok/s.
		for (let i = 0; i < 60; i++) {
			t += 50;
			model.addDelta("x".repeat(28), t);
		}
		// One frame carrying 100 tokens arrives at once.
		t += 80;
		model.addDelta("x".repeat(400), t);
		for (let i = 0; i < 60; i++) {
			t += 50;
			model.addDelta("x".repeat(28), t);
		}
		const record = model.endMessage(t + 10, 900);
		assert.ok((record?.peakRate ?? 0) < 400, `burst set the peak: ${record?.peakRate}`);
		assert.ok(model.peak < 400, `burst set the session peak: ${model.peak}`);
	});

	it("ignores records whose window is too short to time", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 53, elapsedMs: 1, ttftMs: undefined, peakRate: 0, exact: true });
		model.mergeRecord({ tokens: 0, elapsedMs: 0, ttftMs: undefined, peakRate: 0, exact: true });
		// An older version floored short windows to exactly the minimum, so a
		// record sitting on that boundary is an artifact, not a measurement.
		model.mergeRecord({ tokens: 272, elapsedMs: 250, ttftMs: undefined, peakRate: 0, exact: true });
		model.mergeRecord({ tokens: 600, elapsedMs: 3000, ttftFrom: "turn", ttftMs: 40, peakRate: 0, exact: true });

		const stats = model.stats;
		assert.equal(stats.messages, 4);
		assert.equal(stats.unmeasuredMessages, 3);
		assert.equal(stats.measuredMessages, 1);
		assert.equal(stats.totalTokens, 925, "their tokens still count");
		assert.equal(stats.measuredTokens, 600);
		assert.equal(stats.generationMs, 3000, "but not their time");
		assert.equal(stats.averageRate, 200);
		assert.equal(stats.peakRate, 200, "no rate can come from an untimed record");
	});

	it("leaves a message that arrived faster than a frame untimed", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		model.addDelta("x".repeat(1088), 0);
		const record = model.endMessage(1, 1088);
		assert.equal(record?.elapsedMs, 0, "the raw window, never floored");
		assert.equal(model.stats.measuredMessages, 0);
		assert.equal(model.stats.totalTokens, 1088, "its tokens still count");
		assert.equal(model.stats.peakRate, 0, "so it cannot invent a peak");
	});

	it("keeps aggregates when the live series restarts", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 400, elapsedMs: 4000, ttftMs: 500, peakRate: 130, exact: true });
		model.begin(10_000);
		assert.equal(model.stats.messages, 1);
		assert.equal(model.tokens, 0);
	});

	it("clears aggregates on reset", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 400, elapsedMs: 4000, ttftMs: 500, peakRate: 130, exact: true });
		model.reset();
		assert.equal(model.stats.messages, 0);
		assert.equal(model.peak, 0);
		assert.equal(model.sparkline.length, 0);
	});

	it("recomputes the statistics when a record arrives", () => {
		// The statistics are cached because the widget reads them several times per
		// frame, so a record added after the first read has to invalidate them.
		const model = new SessionRateModel();
		assert.equal(model.stats.messages, 0);
		model.mergeRecord({ tokens: 400, elapsedMs: 4000, peakRate: 0, exact: true });
		assert.equal(model.stats.messages, 1);
		assert.equal(model.stats.totalTokens, 400);
		model.reset();
		assert.equal(model.stats.messages, 0, "and clearing them invalidates them too");
	});

	it("keeps a summarization call out of every rate", () => {
		// One reply at 200 tok/s, then a compaction that took 40s to write 3k
		// tokens: 75 tok/s end to end, and nothing like the speed of a reply.
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 400, elapsedMs: 2000, ttftFrom: "turn", ttftMs: 600, peakRate: 200, exact: true });
		model.beginSilentCall("compaction", 10_000);
		model.endSilentCall(50_000, 3000);

		const stats = model.stats;
		assert.equal(stats.messages, 1, "a summary is not a reply");
		assert.equal(stats.totalTokens, 3400, "its output is still the session's output");
		assert.equal(stats.generationMs, 2000, "but its wait is not generation time");
		assert.equal(stats.averageRate, 200, "a slow summary cannot deflate the average");
		assert.equal(stats.peakRate, 200, "nor a fast one hold the peak");
		assert.equal(stats.rateSpread.slowest, 200, "nor the spread report a window that is not one");
		assert.equal(stats.summaryMessages, 1);
		assert.equal(stats.summaryTokens, 3000);
		assert.equal(stats.summaryElapsedMs, 40_000);
		assert.equal(stats.meanTtftMs, 600, "the summary has no first token to time");
	});

	it("lets a fast summarization call set the peak of nothing", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 400, elapsedMs: 2000, peakRate: 0, exact: true });
		// 3k tokens in 9s: 333 tok/s, faster than any reply, and not a rate at all.
		model.beginSilentCall("compaction", 10_000);
		model.endSilentCall(19_000, 3000);
		assert.equal(model.stats.peakRate, 200);
		assert.equal(model.stats.rateSpread.fastest, 200);
	});

	it("reports a summary as a session with no replies", () => {
		// A session that only ever compacted still has output, and says so.
		const model = new SessionRateModel();
		model.beginSilentCall("compaction", 0);
		const record = model.endSilentCall(4000, 1200);
		assert.equal(record?.kind, "compaction");
		const stats = model.stats;
		assert.equal(stats.hasData, true);
		assert.equal(stats.messages, 0);
		assert.equal(stats.totalTokens, 1200);
		assert.equal(stats.summaryMessages, 1);
		assert.equal(stats.averageRate, 0, "there is no reply to average");
	});

	it("marks a branch summary as one", () => {
		const model = new SessionRateModel();
		model.beginSilentCall("branch-summary", 1000);
		const record = model.endSilentCall(6000, 2400);
		assert.equal(record?.kind, "branch-summary");
		assert.equal(model.stats.summaryMessages, 1);
		assert.equal(model.stats.summaryElapsedMs, 5000);
	});

	it("records nothing for a summary that reported no usage", () => {
		const model = new SessionRateModel();
		model.beginSilentCall("compaction", 0);
		assert.equal(model.endSilentCall(5000, undefined), undefined);
		assert.equal(model.isSummarizing, false, "and leaves no call open behind it");
		assert.equal(model.stats.hasData, false);
	});

	it("stops claiming a silent call that pi says has ended", () => {
		// An aborted branch summary emits no terminal event, so the claim has to be
		// closable from outside or the line waits on a call that ended.
		const model = new SessionRateModel();
		model.beginSilentCall("branch-summary", 0);
		assert.equal(model.isSummarizing, true);
		assert.equal(model.live(3000).activity, "summarizing");
		model.noteSilentCallEnded();
		assert.equal(model.isSummarizing, false);
		assert.equal(model.live(3000).activity, "idle");
		assert.equal(model.live(3000).silentElapsedMs, 0);
		assert.equal(model.stats.hasData, false, "an aborted call produced no output to count");
	});

	it("still records a summary whose claim was dropped early", () => {
		// The claim and the measurement are separate on purpose: if pi's own state
		// is ever briefly wrong, the usage arriving with the terminal event has to
		// be counted rather than thrown away with the claim.
		const model = new SessionRateModel();
		model.beginSilentCall("compaction", 1000);
		model.noteSilentCallEnded();
		const record = model.endSilentCall(9000, 2400);
		assert.equal(record?.tokens, 2400);
		assert.equal(record?.elapsedMs, 8000, "the wait it was started with is still the measurement");
		assert.equal(model.stats.summaryTokens, 2400);
	});

	it("closes a summary a new message supersedes", () => {
		const model = new SessionRateModel();
		model.beginSilentCall("compaction", 0);
		model.beginMessage(4000);
		assert.equal(model.live(4100).activity, "streaming", "the message is what the line describes now");
	});

	it("ignores a terminal event for a call that was never opened", () => {
		const model = new SessionRateModel();
		assert.equal(model.endSilentCall(5000, 900), undefined, "nothing to time, nothing to record");
		assert.equal(model.stats.totalTokens, 0);
	});
});

describe("sparkline", () => {
	it("returns an empty string without data", () => {
		assert.equal(sparkline([]), "");
	});

	it("draws a flat line at full height for a constant series", () => {
		assert.equal(sparkline([5, 5, 5]), "███");
	});

	it("normalizes against the maximum", () => {
		assert.equal(sparkline([0, 5]), "▁█");
		assert.equal(sparkline([1, 5]), "▂█");
		assert.equal(sparkline([2.5, 5]), "▅█");
	});

	it("draws the lowest bar for an all-zero series", () => {
		assert.equal(sparkline([0, 0]), `${SPARK_CHARS[0]}${SPARK_CHARS[0]}`);
	});
});
