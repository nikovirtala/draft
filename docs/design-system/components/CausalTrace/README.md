# CausalTrace

How the map answers "what led to this, and what did it lead to?" Two real chains from 23 November 2026.

- **A cascade.** A merge fires a wait in kiro-remote, which wakes the waiting session; it rebases, the checks pass, the next pull request is merged and the issue it carries closes.
- **An open end, chosen.** Three notes are queued for a session; the session is deleted for a cause no source recorded; the notes are lost and nothing follows yet.

The rules it shows:

- No lanes. Events follow the order of causes, not a clock, left to right; a branch takes the next row down. Under each event, its source in `text` and its time in `muted` ("kiro-remote · 20:25"); the person's own acts read "you".
- What a person or Claude did is a command in the imperative (`› merge`, `› send 3 notes`, `› launch session`), with its source saying who ("you", "Claude"). A command is a cause, not a state, so it has no state colour: a `raised` chip with a `line-strong` hairline and `ink` words.
- An event is a state chip in its kind's meaning (the chip rule: pastel fill, word in the same hue, `--radius-chip`). A failure is the dashed waiting chip with a cross.
- A recorded cause is an arrow. On the chosen event's path, back to its root and forward to its last effect, it is `moved-mark` at 1.6px; elsewhere `edge` at 1.2px.
- A reference that is not a cause is a dotted `edge` line. A cause no source recorded is a dashed `loop-mark` stub reading "cause unknown", never a guess. An effect that leads nowhere ends in a dashed `loop-mark` ring, "open end".
- The chosen event is shown by its path and by the line under the trace (caused by, refers to, led to), not by filling its chip: the chip keeps its state's fill.
