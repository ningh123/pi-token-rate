/**
 * Unit tests for the rate view: the width-adaptive line and the summary.
 *
 * Run with:
 *   npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type MessageRecord, SessionRateModel } from "../metrics.ts";
import { buildWidgetLines, type DetailLevel, RateView, type RateViewSnapshot, visibleWidth } from "../rate-view.ts";

/** Unstyled fragments keep the width arithmetic readable. */
const style = (_color: "accent" | "dim" | "muted", text: string) => text;

/** Fake SGR styling, to prove the width math ignores escapes. */
const ansi = (color: "accent" | "dim" | "muted", text: string) => `[${color === "accent" ? "1" : "2"}m${text}[0m`;

const NOW = 100_000;

function render(snapshot: RateViewSnapshot, width: number, detail: DetailLevel = "full", styled = style): string[] {
	return buildWidgetLines(snapshot, width, detail, styled, visibleWidth);
}

const plain = (_color: string, text: string) => text;

function snapshot(overrides: Partial<RateViewSnapshot> = {}): RateViewSnapshot {
	return {
		rate: 91,
		exact: true,
		trace: [10, 40, 90, 130, 80, 30],
		traceMax: 130,
		peakRate: 130,
		meanTtftMs: 820,
		tokens: 14_200,
		averageRate: 87,
		messageTokens: 0,
		messageElapsedMs: 0,
		hasData: true,
		activity: "idle",
		silentElapsedMs: 0,
		traceSlots: 32,
		...overrides,
	};
}

function record(overrides: Partial<MessageRecord> = {}): MessageRecord {
	return { tokens: 400, elapsedMs: 4000, ttftMs: 500, ttftFrom: "turn", peakRate: 0, exact: true, ...overrides };
}

/** A model mid-message: `deltas` chunks of 40 characters, `stepMs` apart. */
function streamingModel(deltas = 40, stepMs = 50): SessionRateModel {
	const model = new SessionRateModel();
	model.mergeRecord(record());
	model.begin(0);
	model.beginMessage(0);
	for (let i = 1; i <= deltas; i++) model.addDelta("x".repeat(40), i * stepMs);
	return model;
}

describe("widget line", () => {
	it("renders the trace with rate, progress, and ttft while streaming", () => {
		const [line] = render(snapshot({ messageTokens: 1200, messageElapsedMs: 6400 }), 140);
		assert.ok(line, "a line is rendered");
		assert.match(line, /⚡/);
		assert.match(line, /91 tok\/s/);
		assert.match(line, / · 6\.4s 1\.2k tok ·/, "the message in flight leads with its elapsed time and its output");
		assert.match(line, /ttft 0\.8s/);
		// The session total changes slowest of all, so it is the first detail to go
		// and it never appears while a message is in flight.
		assert.doesNotMatch(line, /14k tok/, line);
	});

	it("shows the session total last, after the peak", () => {
		const [line] = render(snapshot({ messageTokens: 0, messageElapsedMs: 0 }), 140);
		assert.match(line, /ttft 0\.8s · avg 87 tok\/s · peak 130 tok\/s · 14k tok$/, line);
		// It is the first thing to be given up when the line runs out of room.
		assert.doesNotMatch(render(snapshot({ messageTokens: 0, messageElapsedMs: 0 }), 60)[0] ?? "", /14k tok/);
	});

	it("leaves the session aggregates off the line while a message is in flight", () => {
		// Both describe messages that have already ended, so while the headline is
		// the live rate they would cost the trace columns for nothing.
		const streaming = render(snapshot({ messageTokens: 1200, messageElapsedMs: 6400 }), 140)[0] ?? "";
		assert.doesNotMatch(streaming, /avg|peak/, streaming);
		const idle = render(snapshot({ messageTokens: 0, messageElapsedMs: 0 }), 140)[0] ?? "";
		assert.match(idle, /avg 87 tok\/s/, idle);
		assert.match(idle, /peak 130 tok\/s/, idle);
	});

	it("gives the trace its whole window before the last detail", () => {
		// The session total is the least important thing on the line, and it must not
		// be allowed to halve the chart to fit itself in.
		const idle = snapshot({ messageTokens: 0, messageElapsedMs: 0, traceSlots: 16 });
		const roomy = render(idle, 120)[0] ?? "";
		const tight = render(idle, 80)[0] ?? "";
		assert.match(roomy, /peak 130 tok\/s · 14k tok$/, roomy);
		assert.doesNotMatch(tight, /14k tok/, "the total is the first detail to go");
		assert.match(tight, /ttft 0\.8s · avg 87 tok\/s · peak 130 tok\/s$/, tight);
		for (const line of [roomy, tight]) {
			assert.equal((/^⚡ (\S+) /.exec(line)?.[1] ?? "").length, 16, `the chart kept its window: ${line}`);
		}
	});

	it("lets the details win when the terminal cannot hold the whole window", () => {
		// 32 slots in 60 columns: the window cannot fit at all, so the details are
		// kept and the chart falls back to a readable minimum rather than being
		// squeezed out of existence.
		const state = snapshot({ messageTokens: 1200, messageElapsedMs: 6400, traceSlots: 32 });
		const line = render(state, 45)[0] ?? "";
		assert.match(line, / · 6\.4s 1\.2k tok$/, `the important details survive: ${line}`);
		const field = (/^⚡ (\S+) /.exec(line)?.[1] ?? "").length;
		assert.ok(field >= 8, `the chart is still a chart: ${field} columns`);
	});

	it("gives up the chart before it gives up the headline", () => {
		for (const width of [30, 24, 20, 16]) {
			const line = render(snapshot({ messageTokens: 1200, messageElapsedMs: 6400 }), width)[0] ?? "";
			assert.match(line, /91 tok\/s/, `the headline survives at ${width}: ${line}`);
		}
	});

	it("keeps the trace readable instead of squeezing it to a few columns", () => {
		// Details yield before the trace does: four bars is a shape, not a history.
		for (const width of [100, 80, 64, 52, 44]) {
			const state = snapshot({ messageTokens: 4800, messageElapsedMs: 30_000, trace: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
			const line = render(state, width)[0] ?? "";
			const trace = /^⚡ (\S+) /.exec(line)?.[1] ?? "";
			assert.ok(trace.length >= 8, `the trace is ${trace.length} columns at ${width}: ${line}`);
		}
	});

	it("honours the detail level", () => {
		// A level is a cut in the importance order: minimal keeps one detail,
		// compact adds the next, full shows everything there is.
		const streaming = snapshot({ messageTokens: 1200, messageElapsedMs: 6400 });
		assert.match(render(streaming, 140, "minimal")[0] ?? "", / · 6\.4s 1\.2k tok$/);
		assert.match(render(streaming, 140, "compact")[0] ?? "", / · 6\.4s 1\.2k tok · ttft 0\.8s/);
		// There is nothing below the time to first token while streaming, so full
		// adds nothing to compact.
		assert.doesNotMatch(render(streaming, 140, "full")[0] ?? "", /avg|peak|14k tok/);

		// Idle is the only state where the session figures earn their columns.
		const idle = snapshot({ messageTokens: 0, messageElapsedMs: 0 });
		assert.match(render(idle, 140, "minimal")[0] ?? "", /ttft 0\.8s$/);
		assert.match(render(idle, 140, "compact")[0] ?? "", /ttft 0\.8s · avg 87 tok\/s$/);
		assert.match(render(idle, 140, "full")[0] ?? "", /ttft 0\.8s · avg 87 tok\/s · peak 130 tok\/s · 14k tok/);
	});

	it("promotes the next detail when one has nothing to say", () => {
		// No message reported a wait, so the time to first token cannot take a slot:
		// the session average takes it instead rather than leaving a gap.
		const state = snapshot({ messageTokens: 0, messageElapsedMs: 0, meanTtftMs: undefined });
		const line = render(state, 140, "minimal")[0] ?? "";
		assert.match(line, /avg 87 tok\/s/, line);
	});

	it("omits a detail that would render exactly what the headline shows", () => {
		// Idle with one message: the average, the peak, and the headline are the
		// same number, so only one of them is shown.
		const [line] = render(snapshot({ rate: 87, peakRate: 87, averageRate: 87 }), 140);
		assert.equal(line.match(/87 tok\/s/g)?.length, 1, line);
		assert.doesNotMatch(line, /avg/);
		assert.doesNotMatch(line, /peak/);
	});

	it("keeps a detail that is merely close to the headline", () => {
		// A tolerance would drop a peak of 143 next to a headline of 145, and those
		// are two different numbers.
		const [line] = render(snapshot({ rate: 145, peakRate: 143, averageRate: 100 }), 140);
		assert.match(line, /145 tok\/s/, line);
		assert.match(line, /peak 143 tok\/s/, line);
		assert.match(line, /avg 100 tok\/s/, line);
	});

	it("omits progress while no message is in flight", () => {
		// A zero-token progress readout is noise between messages.
		const [line] = render(snapshot({ messageTokens: 0, messageElapsedMs: 0 }), 140);
		assert.doesNotMatch(line, /· 0 tok/, line);
	});

	it("omits ttft when no message reported one", () => {
		const [line] = render(snapshot({ meanTtftMs: undefined }), 140);
		assert.doesNotMatch(line, /ttft/);
	});

	it("reserves the whole trace field before the first bar arrives", () => {
		// The line must not creep while the window fills. The field is allocated at
		// its full width on the first frame, and the bars fill it from the right.
		const lines = [0, 1, 2, 5, 32].map((count) => {
			const trace = Array.from({ length: count }, (_, index) => 100 + index);
			return render(snapshot({ trace, traceMax: 200, tokens: 100 }), 120)[0] ?? "";
		});
		const fields = lines.map((line) => /^⚡ (\S+) /.exec(line)?.[1] ?? "");
		assert.equal(fields[0], "·".repeat(32), "an empty trace is a full-width track");
		assert.match(fields[4] ?? "", /^[▅▆]{32}$/, "a full window fills the same field with bars only");
		for (const field of fields) assert.equal(field.length, 32, `the field changed size: ${field}`);
		// Nothing to the right of the trace moves, so every frame is the same width.
		assert.equal(new Set(lines.map(visibleWidth)).size, 1, lines.join(" | "));
	});

	it("keeps the field constant on a narrow terminal too", () => {
		const fields = [0, 1, 4, 32].map((count) => {
			const trace = Array.from({ length: count }, (_, index) => 100 + index);
			const line = render(snapshot({ trace, traceMax: 200, tokens: 100 }), 60, "minimal")[0] ?? "";
			return /^⚡ (\S+) /.exec(line)?.[1] ?? "";
		});
		assert.ok(
			fields.every((field) => field.length === fields[0].length),
			fields.join(" | "),
		);
		assert.ok((fields[0]?.length ?? 0) >= 8, `the field keeps a readable trace: ${fields[0]}`);
	});

	it("keeps the field constant while the rate changes every frame", () => {
		// The headline is the one piece of the line that moves with the token flow.
		// It is budgeted at its widest, so a number gaining or losing a digit cannot
		// resize the trace: the line ends a little earlier instead.
		const frames = [0, 1, 7, 9, 10, 99, 100, 999, 1000, 1234, 999_499].map((rate) => {
			const state = snapshot({ rate, exact: false, messageTokens: 1200, messageElapsedMs: 6400 });
			const line = render(state, 120)[0] ?? "";
			return { rate, line, field: /^⚡ (\S+) /.exec(line)?.[1] ?? "" };
		});
		const progress = [1, 45, 812, 999, 1000, 12_345, 140_000].map((messageTokens) => {
			const state = snapshot({ rate: 190, exact: false, messageTokens, messageElapsedMs: 6400 });
			const line = render(state, 120)[0] ?? "";
			return /^⚡ (\S+) /.exec(line)?.[1] ?? "";
		});
		assert.deepEqual(
			[...new Set(frames.map((frame) => frame.field.length))],
			[32],
			frames.map((frame) => `${frame.rate}:${frame.field.length}`).join(" "),
		);
		for (const frame of frames) {
			assert.ok(visibleWidth(frame.line) + 1 <= 120, frame.line);
		}
		// The same holds for the output count of the message in flight, which grows
		// on every frame and crosses from "999 tok" to "1.0k tok" while doing it.
		assert.deepEqual([...new Set(progress.map((field) => field.length))], [32], progress.join(" | "));
	});

	it("renders a placeholder before the session has any trace", () => {
		const [line] = render(
			snapshot({ trace: [], hasData: false, rate: 0, peakRate: 0, meanTtftMs: undefined, averageRate: 0, tokens: 0 }),
			60,
		);
		assert.ok(line.includes("·"), line);
		assert.match(line, /0 tok\/s/);
	});

	it("gives up on very narrow terminals", () => {
		assert.deepEqual(render(snapshot(), 11), []);
		assert.deepEqual(render(snapshot(), 0), []);
	});

	it("never exceeds the width, with or without styling", () => {
		const state = snapshot({ messageTokens: 1200, messageElapsedMs: 6400 });
		for (const width of [12, 20, 30, 45, 60, 80, 120, 200]) {
			for (const styled of [style, ansi]) {
				for (const detail of ["minimal", "compact", "full"] as DetailLevel[]) {
					for (const line of render(state, width, detail, styled)) {
						// `visibleWidth` counts the icon as one code unit, but a terminal
						// following Unicode's width property draws it two columns wide.
						assert.ok(visibleWidth(line) + 1 <= width, `${JSON.stringify(line)} at ${width}/${detail}`);
					}
				}
			}
		}
	});

	it("shortens the trace rather than the numbers", () => {
		const long = snapshot({ trace: Array.from({ length: 40 }, (_, i) => i + 1), traceMax: 40 });
		const [wide] = render(long, 120);
		const [tight] = render(long, 50);
		assert.ok(visibleWidth(wide ?? "") <= 120);
		assert.ok(visibleWidth(tight ?? "") <= 50);
		assert.match(tight ?? "", /91 tok\/s/, "the headline is never truncated away");
		assert.ok((tight ?? "").includes("█"), `the trace keeps its most recent bars: ${tight ?? ""}`);
	});

	it("measures visible columns, not escape sequences", () => {
		assert.equal(visibleWidth("[1mabc[0m"), 3);
		assert.equal(visibleWidth("abc"), 3);
	});
});

describe("RateView", () => {
	it("marks the rate as estimated while a message is in flight", () => {
		const model = streamingModel();
		// The provider has not reported usage for the message in flight yet.
		assert.match(new RateView(model).widgetLines(120, { style, now: NOW })[0], /~\d+ tok\/s/);
		model.endMessage(2000, 400);
		assert.doesNotMatch(new RateView(model).widgetLines(120, { style, now: NOW })[0], /~/);
	});

	it("shows the session rate before anything streams", () => {
		const model = new SessionRateModel();
		model.mergeRecord(record());
		model.begin(0);
		// 400 tokens in 4s of generation time.
		assert.match(new RateView(model).widgetLines(120, { style, now: NOW })[0], /100 tok\/s/);
	});

	it("reports the elapsed time and the output of the message in flight", () => {
		const model = streamingModel();
		const view = new RateView(model);
		const state = view.snapshot(2000);
		assert.equal(state.messageTokens, 400);
		assert.equal(state.messageElapsedMs, 2000);
		// Both are shown, and both are budgeted at their widest so a count that grows
		// every frame cannot move the columns around it.
		assert.match(view.widgetLines(140, { style, now: 2000 })[0] ?? "", / · 2\.0s 400 tok ·/);
	});

	it("counts history and live output together", () => {
		const model = new SessionRateModel();
		model.mergeRecord(record({ tokens: 1000, elapsedMs: 10_000 }));
		model.begin(0);
		model.beginMessage(0);
		for (let i = 1; i <= 40; i++) model.addDelta("x".repeat(40), i * 50);
		model.endMessage(2000, 400);
		assert.equal(new RateView(model).snapshot(NOW).tokens, 1400);
		assert.equal(model.stats.messages, 2);
	});

	it("takes the detail level from its constructor and setter", () => {
		const model = new SessionRateModel();
		model.mergeRecord(record());
		const view = new RateView(model, "minimal");
		assert.equal(view.detailLevel, "minimal");
		view.detailLevel = "full";
		assert.equal(view.detailLevel, "full");
	});

	it("summarizes the whole session in aligned columns", () => {
		const model = new SessionRateModel();
		model.mergeRecord(record({ tokens: 1000, elapsedMs: 10_000, ttftMs: 600 }));
		model.begin(0);
		assert.equal(
			new RateView(model).summary(NOW),
			[
				"Token rate · this session",
				"      output  1.0k tok          1 message",
				"   generated  10.0s             6.0k tok per minute",
				"  throughput  100 tok/s         session average · now 0 tok/s · peak 100 tok/s",
				"      spread  100 … 100 tok/s   median 100 tok/s",
				" first token  0.6s              1 of 1 message timed",
				"       trace  ································  32 bars · 0.5s each · 16.0s span",
				"  every rate comes from provider-reported usage",
			].join("\n"),
		);
	});

	it("names the configuration the report was collected under", () => {
		const model = new SessionRateModel({ bucketMs: 2000, buckets: 16 });
		model.mergeRecord(record());
		model.begin(0);
		const summary = new RateView(model, "compact").summary(NOW, { enabled: true, position: "below" });
		assert.match(summary, /^ {6}layout {2}below the editor {2}detail compact$/m, summary);
		assert.match(summary, /^ {7}trace .*16 bars · 2\.0s each · 32\.0s span$/m, summary);

		// A hidden line still has a configuration worth stating, and the report says
		// how to bring it back.
		const off = new RateView(model).summary(NOW, { enabled: false, position: "above" });
		assert.match(off, /above the editor {2}detail full · display is off, \/token-rate on to show it/, off);

		// The row is optional so the view stays usable without one.
		assert.doesNotMatch(new RateView(model).summary(NOW), /layout/, "no configuration, no row");
	});

	it("shows the configuration even before anything is measured", () => {
		const model = new SessionRateModel();
		model.begin(0);
		const summary = new RateView(model).summary(NOW, { enabled: true, position: "above" });
		assert.match(summary, /no output measured in this session yet/, summary);
		assert.match(summary, /layout {2}above the editor/, summary);
	});

	it("reports records it could not time", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 53, elapsedMs: 1, peakRate: 0, exact: true });
		model.mergeRecord(record({ tokens: 600, elapsedMs: 3000 }));
		model.begin(0);
		const summary = new RateView(model).summary(NOW);
		assert.match(summary, /1 message arrived faster than a frame: tokens counted/);
		assert.match(summary, /output {2}653 tok\s+2 messages/);
		assert.match(summary, /throughput {2}200 tok\/s/);
	});

	it("sets the rate one space after the trace, with its unit attached", () => {
		// A reserved field for the rate was tried: a hole before the number shows on
		// every frame, and padding on the right splits "tok/s" from its number.
		for (const rate of [1200, 340, 95, 1500, 7]) {
			const line = buildWidgetLines(snapshot({ rate, exact: false, trace: [100, 200, 300] }), 90, "full", plain).join("");
			assert.match(line, /█ ~\S+ tok\/s · /, `the rate does not follow the trace by one space: ${line}`);
			assert.doesNotMatch(line, / {2}tok\/s/, `the unit is detached from its number: ${line}`);
		}
	});

	it("says so when the session has no output", () => {
		const model = new SessionRateModel();
		model.begin(0);
		assert.match(new RateView(model).summary(NOW), /no output measured/);
	});
});

describe("trace resolution", () => {
	it("reports the tick, the bar count, and the span", () => {
		const model = new SessionRateModel({ bucketMs: 1000, buckets: 16 });
		model.mergeRecord(record());
		model.begin(0);
		const reading = new RateView(model).reading(0);
		assert.equal(reading.bars, 16);
		assert.equal(reading.tick, "1.0s");
		assert.equal(reading.span, "16.0s");
	});

	it("keeps idle frames identical instead of rescaling the trace", () => {
		const model = new SessionRateModel({ bucketMs: 500, buckets: 8 });
		model.begin(0);
		model.beginMessage(0);
		// A fast burst, then a slow one: the window maximum sits at the front.
		for (let i = 1; i <= 20; i++) model.addDelta("x".repeat(160), i * 50);
		for (let i = 21; i <= 40; i++) model.addDelta("x".repeat(20), i * 50);
		model.endMessage(2000);
		const view = new RateView(model);
		const idle = view.widgetLines(60, { style, now: 2000 })[0];
		// No new tokens arrive, so every later frame must render the same line.
		for (const now of [2500, 3000, 4000, 5000]) {
			assert.equal(view.widgetLines(60, { style, now })[0], idle, `frame at ${now}`);
		}
	});

	it("reconfigures the resolution and restarts the trace", () => {
		const model = new SessionRateModel();
		model.mergeRecord(record());
		model.begin(0);
		model.beginMessage(0);
		model.addDelta("x".repeat(400), 100);
		model.endMessage(200);
		assert.equal(model.sparkline.length, 1, "one bar before the change");

		model.configure({ bucketMs: 2000, buckets: 8 });
		assert.equal(model.tickMs, 2000);
		assert.equal(model.tickCount, 8);
		assert.equal(model.traceSpanMs, 16_000);
		assert.equal(model.sparkline.length, 0, "the trace restarts so every bar has one width");
		// The seeded record and the message just closed both survive.
		assert.equal(model.stats.messages, 2, "aggregates are untouched");
		assert.equal(model.stats.totalTokens, 500, "400 recorded plus 100 just streamed");
	});
});

describe("minimum rate window", () => {
	it("leaves a message that arrived faster than a frame untimed", () => {
		const model = new SessionRateModel();
		model.begin(0);
		model.beginMessage(0);
		model.addDelta("x".repeat(40), 0);
		const record = model.endMessage(1, 40);
		assert.equal(record?.elapsedMs, 0, "the raw window is kept, not floored");
		assert.equal(model.stats.measuredMessages, 0, "too short to derive a rate from");
		assert.equal(model.stats.unmeasuredMessages, 1);
		assert.equal(model.stats.totalTokens, 40, "its tokens still count");
		assert.equal(model.stats.peakRate, 0, "so it cannot set the peak");
	});

	it("labels buffered rates on the report even beside an untimed message", () => {
		// The caveat used to require every record to be front-loaded, which is a
		// different condition from the one that filled the rates: a session with a
		// message too short to time has no other rate to show either, and the
		// numbers on the report would have been transport speeds with nothing to
		// say so.
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 1200, elapsedMs: 288, peakRate: 0, exact: true, frontLoadedFirstChunk: true });
		model.mergeRecord({ tokens: 40, elapsedMs: 80, peakRate: 0, exact: true });
		const report = new RateView(model).summary(NOW);
		assert.match(report, /rather than the model that wrote it/, report);
	});

	it("says nothing about buffers when the rates came from real generation", () => {
		const model = new SessionRateModel();
		model.mergeRecord({ tokens: 1200, elapsedMs: 288, peakRate: 0, exact: true, frontLoadedFirstChunk: true });
		model.mergeRecord({ tokens: 1200, elapsedMs: 19_900, peakRate: 60, exact: true });
		const report = new RateView(model).summary(NOW);
		assert.doesNotMatch(report, /rather than the model that wrote it/, report);
	});
});
