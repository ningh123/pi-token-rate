# pi-token-rate

Session-wide output-token throughput for [pi](https://github.com/earendil-works/pi),
on one line above the editor:

```
⚡ ▂▄▆█▆▄▂ ~190 tok/s · 6.4s 1.2k tok · ttft 0.7s · avg 134 tok/s · peak 249 tok/s
```

The line shows the live rate and its sparkline, the message in flight, and
the session's average, peak, and first-token wait — styled with the active
theme and trimmed to the terminal width. Measurement covers the whole
session: nothing restarts across messages, tool calls, `/reload`, `/resume`,
forks, or branch switches. Live values are marked `~` until the provider
reports real usage.

## Install

```bash
pi install npm:pi-token-rate
```

Run `/reload`, then `/token-rate` to show the line. Only the interactive TUI
renders anything; JSON and print modes are untouched.

## Usage

| Command | Effect |
| --- | --- |
| `/token-rate` | Toggle the display |
| `/token-rate on` / `off` | Enable / disable explicitly |
| `/token-rate position [above]` / `below` | Where the line sits relative to the editor |
| `/token-rate detail minimal` / `compact` / `[full]` | How much to show; a narrow terminal trims further |
| `/token-rate tick 250ms` / `500ms` / `1s` / `[2s]` | Width of one trace bar |
| `/token-rate window 8s` / `16s` / `[32s]` / `60s` | Time the trace covers; the bar count follows |
| `/token-rate stats` | Session report |
| `/token-rate reset` | Clear the statistics for this run |
| `/token-rate help` | List every option with the current state |

Subcommands and arguments complete with Tab; bracketed values are the defaults.
Preferences survive a `/reload` but start from their defaults in a new session.
Hiding the line changes nothing else: measurement continues, and
`/token-rate stats` still covers the messages produced while it was hidden.

## Reading the line

```
streaming  ⚡ ▂▄▆█▆▄▂ ~190 tok/s · 6.4s 1.2k tok · ttft 0.7s
              trace   rate         live            ttft

idle       ⚡ ▂▄▆█▆▄▂ 134 tok/s · ttft 0.7s · sub 92k tok · avg 134 tok/s · peak 249 tok/s · 12k tok
              trace   rate        ttft        sub           avg             peak             total
```

Details appear in that order and are dropped from the right, so the headline and
the trace outlive everything else. `avg`, `peak`, and the total describe messages
that have already ended, so they stay off the line while a message is streaming.
A narrow terminal shrinks the trace first, never below eight columns; past that
the details go instead, and below that only the headline is drawn.

## The stats report

`/token-rate stats` prints the session:

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

`spread` is the distribution of per-message rates, so a peak far above the median
reads as an outlier rather than as the model's speed. Caveats are listed only
when they apply.

## How the numbers are computed

Providers report token usage only after a response completes, so while a message
streams its rate is estimated from the deltas and marked `~`; when the message
ends, the provider's figure replaces the estimate and recalibrates future ones.

- **Generation time only.** A message's rate covers the window from its first
  token to its last. Queueing, provider retries, and stalls are not generation
  time, so they never deflate a rate. Bars follow the same rule.
- **Peak.** The fastest single message, recomputed from stored records so it
  survives a reload. Responses the provider buffered — the whole answer written
  before delivery began — are held out of the peak, and messages shorter than
  250ms contribute tokens but no rate.
- **Tool calls.** Tokens spent writing a tool call are output and count; the
  tool's result is input for the next request and does not.
- **Time to first token.** Measured from the start of the turn, or from the end
  of the previous step — not from when the provider opens its stream. A
  front-loaded first delta reports unknown rather than a suspiciously small
  number.
- **Summaries.** `/compact` and branch summaries are timed end to end on their
  own row — that window is prefill and queueing, not generation — and kept out
  of `avg`, `peak`, and `spread`. Their tokens count towards the session total.
  A summary that never reports usage is not recorded.
- **Subagents.** Children are separate pi sessions, so their output never
  enters a rate: it is accounted by pi-subagents and shown as its own total.
  `sub 92k+ tok` marks a lower bound; without pi-subagents installed the
  segment and the row never appear.

## License

MIT © 2026 Ning. See [LICENSE](LICENSE).
