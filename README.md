# pi-token-rate

Session-wide output-token throughput for [pi](https://github.com/earendil-works/pi),
on one adaptive line above the editor:

```
⚡ ▂▄▆█▆▄▂ ~190 tok/s · 6.4s 1.2k tok · ttft 0.7s · avg 134 tok/s · peak 249 tok/s
```

- **One surface.** A single line, above or below the editor, styled with the active
  theme and trimmed to the terminal width: trailing detail is dropped first, then
  trace columns, and the headline rate is never truncated away. A detail that
  would repeat the headline is not shown at all.
- **Still from the first frame.** The trace is allocated its full width before the
  first bar arrives and the bars fill it from the right, so the line never creeps
  across the terminal while the window fills.
- **Ordered by importance.** After the rate come the progress of the message in
  flight, the time to first token, the session average, and the session peak. The
  detail level and a narrow terminal both cut that list from the right, and the
  two session aggregates are left off entirely while a message is streaming:
  they describe messages that have already ended.
- **Continuous.** One session-continuous model feeds the line, so nothing restarts
  at a message or tool boundary. A tool call pauses generation: the trace holds
  its last shape and the number decays smoothly instead of resetting.
- **Whole-session statistics.** Every measured message is appended to the session,
  so the numbers cover the whole session across `/reload`, `/resume`, forks, and
  branch switches. Compactions and branch summaries are timed and counted on a
  row of their own, never folded into a rate.
- **Subagent output accounted apart.** Children run by pi-subagents stream to
  their own sessions, so their tokens never pass through this one. The line and
  the report carry what pi-subagents' accounting reports — cumulative child
  output on its own segment — marked `+` when some of it could not be read.
- **Honest numbers.** Live values are estimated from streamed deltas and marked
  with `~` until the provider reports `usage.output`.

## Commands

| Command | Effect |
| --- | --- |
| `/token-rate` | Toggle the display |
| `/token-rate on` / `off` | Enable / disable explicitly |
| `/token-rate position [above]` / `below` | Where the line sits relative to the editor. The bracketed value is the default |
| `/token-rate detail minimal` / `compact` / `[full]` | How much to show, as a prefix of the detail list above; a narrow terminal trims further |
| `/token-rate tick 250ms` / `500ms` / `1s` / `[2s]` | Width of one trace bar |
| `/token-rate window 8s` / `16s` / `[32s]` / `60s` | Time the trace covers; the bar count follows |
| `/token-rate stats` | Session report: output, generation time, throughput, rate spread, time to first token, any summarization calls, the trace, and any caveats |
| `/token-rate reset` | Clear the statistics for this run |
| `/token-rate help` | List every option with the current state |

Subcommands and their arguments complete with Tab. The value that needs no argument
is bracketed — `[above]` — wherever the values are listed: `/token-rate help`, a usage
line after a mistyped value, and the README above; the Tab popup marks it `default`
instead. All three read the same table, which reads the defaults themselves, so a help
line cannot claim one value while the code uses another.

Preferences are stored in the session, so `position`, `detail`, `tick`, and `window`
survive a `/reload` but start from their defaults in a new session. Changing the resolution restarts the
trace so that every bar has the same width; statistics are untouched.

The trace only advances while tokens are arriving, and its vertical scale is held
at its peak and released slowly, so an idle line renders identically on every
frame instead of twitching as the window slides.

The default tick is two seconds, which is half the columns a one-second bar would
need for the same window. A 250ms bar covers about five rate samples, so one
buffered frame dominates it and the picture disagrees with the smoothed headline;
at 2s a bar averages roughly forty samples and the trace reads as a calm wave. The
window is still half a minute, so nothing is lost but resolution — and the columns
are worth more as numbers than as bars. The tick is a choice, not a limitation:
`/token-rate tick 250ms` with a short window buys finer detail back.

## Install

From npm or git:

```bash
pi install npm:pi-token-rate
pi install git:github.com/<owner>/pi-token-rate
```

From a local checkout (loaded by reference, not copied):

```bash
pi install /path/to/pi-token-rate
# or, for development, link it into the extensions directory:
ln -s /path/to/pi-token-rate ~/.pi/agent/extensions/pi-token-rate
```

Run `/reload` after installing. Only the interactive TUI renders anything; JSON and
print modes are untouched, and the extension never touches the built-in footer or
the extension status row.

## How the rate is measured

Providers only report token usage after a response completes, so the live rate
comes from the streamed text, thinking, and tool-call deltas:

1. Deltas are converted to tokens with pi's own heuristic (4 characters per token).
2. The estimate is scaled by a calibration factor learned from finished messages
   (`reported output tokens / estimated tokens`, clamped to a sane range).
3. Tokens are pooled over at least 40ms before a rate sample is taken, so a burst
   of deltas inside one millisecond cannot report a meaningless spike.
4. Samples feed one exponential average (6s time constant) with bias correction.
   One smoothing step is capped at one second, so a long pause moves the number
   gradually instead of replacing it in a single step.
5. A message's throughput is measured over the window in which tokens actually
   arrived (first token to last token). Queueing, provider retries, and stalls
   inside the response are not generation time, so they never deflate the rate or
   the session average. Sparkline bars use the same rule.
6. When a message ends, provider-reported usage replaces the estimate and the
   calibration factor is updated.

Only model output counts. The tokens a model spends writing a tool call are
counted, because they are output tokens; the tool's result is not, because it is
input for the next request. Subagent children are counted by neither side of
that rule here — their output belongs to their own sessions and is reported
separately by pi-subagents — so a line with `sub 92k tok` on it still measures
only the parent's own stream.

## Summarization

pi summarizes in two places: `/compact`, and the summary offered when `/tree`
leaves a branch. Both call the model outside the agent loop, so no message events
are emitted and nothing can be watched while they run. The line shows the wait
(`⚡ ░ summarizing 12.4s`), and the provider's own `usage.output` times the call
from start to finish, so both are measured.

Those end-to-end windows are not generation windows: a summary reads a large
context, and most of its time goes into prefill, queueing and retries. They are
therefore counted apart, on a `summaries` row of their own, and kept out of
`avg`, `peak`, `spread`, `generated` and the message count. Their tokens do count
towards the session output, and they are stored, so a summary that ran before a
`/reload` is still in the report. `/token-rate reset` clears them like anything
else.

A summary that never reports usage — a cancelled one, or a failed compaction — is
not recorded at all: there is no output to count and no generation to time.

## Subagents

A subagent child is its own pi session: its messages stream to its own event bus,
its session file is its own, and nothing about it reaches the extension events
this meter listens to. That is by design in both extensions — the parent's
measurement stays the parent's — and it means a family of children producing
tokens at full speed shows an idle line here, which is exactly when their total
belongs on it.

pi-subagents exposes the accounting as data — the same report `/subagent-cost`
renders — over the process event bus, and this extension reads it on the turn
boundaries its contract asks for: session start, the readiness notice, and every
settled turn. The answer is cumulative tokens, not a stream, so no child rate
can be derived from it; what the line gains is a segment —

```
⚡ ▂▄▆█▆▄▂ 134 tok/s · ttft 0.7s · sub 92k tok · avg 134 tok/s · peak 249 tok/s · 12k tok
```

— and what the report gains is a row:

```
    children  92k tok          6 subagents · parallel output, never in the rates above
```

Child output never enters the average, the peak, the spread or the trace: a
total that cannot be timed is accounting, not a rate, which is the same rule a
summarization call follows. A `+` after the count — `sub 92k+ tok` — means some
async child's usage could not be read, so the figure is a lower bound. Without
pi-subagents installed the segment and the row simply never appear, and the
meter never waits on it: an unanswered request costs one timer and is asked
again at the next turn boundary.

`peak` is the fastest average rate of any single message, recomputed from stored
tokens and generation time, so it is identical before and after a reload. A
response the provider **buffered** is held out of it: when the first delta already
carries a sizeable chunk, the whole answer was written before delivery began, and
that window measures the transport rather than the model. Such a record's tokens
still count towards the total, and the session average is barely affected — one
inflated record is diluted by the rest — but a peak is a maximum, so admitting one
would keep the transport speed for the rest of the session. If *every* response
arrived buffered there is nothing else to report, and the rates are shown with
that caveat rather than as zeros.

Records whose generation window is shorter than 250ms cannot yield a rate, so
they contribute their tokens to the total but no time to the average or the peak;
`/token-rate stats` prints an aligned report and reports how many were skipped:

```
Token rate · this session
      output  168k tok          245 messages
   generated  19m09s            8.6k tok per minute
  throughput  144 tok/s         session average · now 151 tok/s · peak 744 tok/s
      spread  31 … 744 tok/s    median 175 tok/s
 first token  5.0s              31 of 242 messages timed
   summaries  6.4k tok          3 calls · 41.2s end to end
    children  92k tok          6 subagents · parallel output, never in the rates above
       trace  ▇█▇██▇█▇█▇█▇█▇█▇██▇█▇█▇█▇█▇█▇██▇  32 bars · 1.0s each · 32.0s span
  43 messages arrived faster than a frame: tokens counted, but no rate can be derived from them
  summarization is timed end to end, so it counts towards the output but not towards the average, the peak or the spread
  rates marked ~ are estimated from stream deltas; the rest are provider-reported
```

`spread` is the distribution of per-message rates, so a peak that is far above the
median reads as an outlier rather than as the model's speed. Caveats are listed
only when they apply. Sessions written by earlier
versions of this extension stored a wall-clock span instead of a generation
window, and their very short spans land in that bucket, which is why a session
can start with a peak in the hundreds rather than tens of thousands.

Time to first token is measured from the start of the turn, or from the end of the
previous step, because pi emits `message_start` when the provider *opens* its
stream: measuring from there yields a millisecond that says nothing about the wait
the user experienced. When a message's first delta already carries a sizeable
chunk, the provider front-loaded the response and the interval is reported as
unknown instead of as a suspiciously small number; `/token-rate stats` says how
many messages that applies to. A time to first token of zero means "not measured"
and is left out of the mean, so sessions recorded by earlier versions do not
report an artificially low figure.

## Reading the line

```
streaming  ⚡ ▂▄▆█▆▄▂ ~190 tok/s · 6.4s 1.2k tok · ttft 0.7s
idle       ⚡ ▂▄▆█▆▄▂ 134 tok/s · ttft 0.7s · sub 92k tok · avg 134 tok/s · peak 249 tok/s · 12k tok
              trace    rate          live     ttft        sub           avg            peak      total
```

| Field | Meaning |
| --- | --- |
| `⚡` | The line itself. It is two columns wide, so it is measured as two |
| `▂▄▆█▆▄▂` | The trace: one bar per tick, oldest on the left |
| `~190 tok/s` | The headline rate. `~` means estimated from stream deltas; without it the provider reported the usage |
| `6.4s 1.2k tok` | The message in flight: how long it has been running, and the output so far. Dropped as soon as it ends |
| `ttft 0.7s` | Mean wait for the first token over the messages that reported one |
| `sub 92k tok` | Output of subagent children this session, as pi-subagents accounted it. `sub 92k+ tok` marks a lower bound. Never inside a rate |
| `avg 134 tok/s` | Session throughput: output per generation second |
| `peak 249 tok/s` | Fastest single message this session |
| `12k tok` | Session output so far, including the message in flight |

Details appear in that order and are dropped from the right, so the headline and
the trace outlive everything else. The last three are off the line entirely while a
message is streaming: they describe messages that have already ended.

The trace gets its whole window first and the details take what is left, because a
chart that shows a shape is worth more than the least important number on the line:
the session total is dropped rather than allowed to halve the trace. On a terminal
too narrow to hold the whole window at all, the order reverses — the details are
kept and the trace keeps a readable minimum of eight columns, and below that only
the headline is drawn.

While a message is streaming the two counts in that field grow every frame, and
every digit either gained or lost would move the columns beside it. Both are
therefore budgeted at the width they could need rather than the width they happen
to occupy, which is why the elapsed time is shown to one decimal: `6.4s` occupies
its cell whether the real elapsed time is `0.4s` or `64.2s`, so the separator
lands in the same column on every frame and the trace never shifts. The headline
rate is budgeted the same way, for the same reason: a rate that crosses from `999`
to `1.0k` cannot resize the trace. The line therefore ends up a few columns short
of the terminal edge on some frames, which is invisible, instead of a chart that
breathes.

| Glyph | Meaning |
| --- | --- |
| `▁▂▃▄▅▆▇█` | A trace bar, from a stall to the fastest bar in the window |
| `·` | A bar that has not arrived yet. The whole field is drawn before the first one, so the line never moves |
| `░` | Drawn where the trace sits while a call that does not stream — a compaction or a branch summary — is running |
| `~` | The number is estimated rather than provider-reported |
| ` · ` | Separator between details |

Colours come from the active pi theme: the icon and the headline in the accent
colour, the details dim, the empty part of the trace muted. Nothing is styled on
its own, so the line follows whatever theme is active.

A bar's height is the rate over the time tokens were actually arriving, and the
vertical scale is held at the peak of the window and released slowly, so an idle
line renders identically on every frame instead of rescaling as the window slides.
A stall is a short bar, never a fast one, and a bar only sets the in-message peak
if it was productive for at least 150ms.

## Layout

The trace is allocated its full width on the first frame, whatever the history so
far: a session that has produced nothing yet draws the whole field as `·`, and the
bars fill it in from the right. Nothing to the right of the trace therefore moves
while the window fills. A narrow terminal is the only thing that shrinks the field,
and never below eight columns, because four bars is a shape rather than a history.
Spaces would leave a hole in the middle of the line instead, which looks like a
rendering fault.

Details follow the rate in order of importance: the progress of the message in
flight, the time to first token, the session average, the session peak. Both the
detail level and the terminal width cut that list from the right, so the last thing
is always the first to go. The session average and the session peak describe
messages that have already ended, so while a message is in flight both are off the
line regardless of the width: the headline already is the live rate, and the columns
are worth more to the trace while something is being generated.

The rate is not given a field of its own. Reserving one was tried and reverted
twice: a hole before the number is visible on every frame, and padding on the right
detaches "tok/s" from its number. Letting the tail shift by a column or two when
the number crosses a digit boundary is the smaller cost.

Switching the line off hides it and nothing else: measurement continues, so the
session statistics do not lose the messages produced while it was hidden. A
setting command always names what it changed, and says which command brings a
hidden line back.

The session output total is the last thing on the line, because it changes slowest
of all. It is also the first detail to be given up when the terminal narrows, and
it stays off the line entirely while a message is streaming, where the columns
belong to the trace.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | Wiring: events, session persistence, the widget, commands |
| `rate-view.ts` | The display: one width-adaptive line |
| `metrics.ts` | The session-continuous rate model (no pi imports) |
| `__tests__/*.test.ts` | Unit tests for the pure modules, integration tests driving the extension with a stub API |

## Development

```bash
npm install
npm test          # node --test "__tests__/*.test.ts"
npm run typecheck # tsc -p tsconfig.json
npm run lint      # biome check .
npm run format    # biome check --write .
```

The extension has no runtime dependencies: pi loads extension modules through jiti,
and the only import from the host package is a type-only one, which is erased before
the module runs. `@earendil-works/pi-coding-agent` is a devDependency here so that
`tsc` and the editor resolve it from `node_modules` like any other package; it is
deliberately not a `peerDependency`, because a `*` range would make a plain
`npm install pi-token-rate` download the whole host package for nothing.

## Releasing

`npm publish` runs `prepublishOnly`, which type-checks, lints, and tests first.
Before tagging, confirm the packed tarball is the whole product and that it loads
from `node_modules` the way pi loads it:

```bash
npm pack
mkdir /tmp/consumer && cd /tmp/consumer && npm init -y
npm install /path/to/pi-token-rate/pi-token-rate-0.1.0.tgz
# jiti is pi's extension loader, so it is what decides whether a published
# TypeScript extension can be loaded at all.
npm install --no-save jiti
node -e "import('jiti').then(async ({createJiti}) => {
  const m = await createJiti(process.cwd() + '/', { interopDefault: true }).import('pi-token-rate', { default: true });
  console.log(typeof m === 'function' ? 'loads and exports a function' : 'UNEXPECTED EXPORT');
})"
```

`files` in `package.json` is the allowlist: the three extension sources, plus the
`README`, `LICENSE`, and `package.json` npm always includes. Tests, `tsconfig.json`,
and `biome.json` stay in the repository and out of the tarball.

## License

MIT © 2026 Ning. See [LICENSE](LICENSE).
