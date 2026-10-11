# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-11

### Added

- Branch summaries are measured. `/tree` summarization is a model call in the
  same shape as compaction — outside the agent loop, so nothing streams — and it
  is now timed, counted and stored in the session. The statistics cover a branch
  switch, which the README claimed and the extension did not do.
- `/token-rate stats` gained a `summaries` row: the number of summarization
  calls, their output tokens and their total end-to-end time, so the difference
  between the session output and the measured replies is on the report instead
  of only in a footnote.
- The line reads `⚡ ░ summarizing <wait>` while either kind of call runs. The
  label was `compacting`, which is wrong for a branch summary.

### Fixed

- **Summarization no longer contaminates the rates.** A compaction was admitted
  as an ordinary message, so its end-to-end window could drag the session
  average down — a 3k-token summary over 40s took `avg` from 204 to 92 tok/s —
  or hold the session peak for the rest of the session, where 3k over 9s made
  `peak` 333 tok/s. Those windows are prefill, queueing and retries rather than
  tokens arriving, which is exactly what the average and the peak exclude
  elsewhere. Summaries are now counted apart: their tokens towards the output,
  nothing towards `avg`, `peak`, `spread`, `generated` or the message count.
- **An aborted branch summary no longer leaves the line waiting forever.** pi
  emits no terminal event for it — `navigateTree` returns without `session_tree`
  — so the line now reconciles the claim against `ctx.isIdle()` on every frame.
  The claim and the measurement are separate: a frame that ends the claim early
  costs a line, never a record.
- **A buffered response stays buffered across `/reload` and `/resume`.** The flag
  that holds a front-loaded window out of the peak and the average was measured
  but never written to the session, so after a reload the record came back as an
  ordinary one: the caveat disappeared and the peak it had been withheld from
  came back with it.
- `kind` is validated when session entries are read, so an unknown value in a
  hand-edited session file is not mistaken for a known one.

### Changed

- Sessions written by 0.1.0 that contain compaction records are read with those
  records excluded from the rates, so a resumed session's `avg` and `peak` can
  rise where a summary had been pulling them down. The new `summaries` row
  accounts for the difference.

## [0.1.0] - 2026-09-30

### Added

- The first release: session-wide output-token throughput on one adaptive line
  above or below the editor, with a live smoothed rate, a time-based trace, the
  progress of the message in flight, the mean time to first token, the session
  average, the session peak and the session output, plus `/token-rate stats`,
  `/token-rate reset` and configurable position, detail, tick and window.

[0.2.0]: https://github.com/ningh123/pi-token-rate/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ningh123/pi-token-rate/releases/tag/v0.1.0
