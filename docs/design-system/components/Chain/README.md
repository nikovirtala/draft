# Chain

The answer to "why did this happen?", as a block (docs/model.md, "Why"). It reads left to right like a sentence: a verdict, the links in the order of causes (what started it first, where the problem was seen last), then what was ruled out. Three states, from draft's own log of 23 November 2026:

- **A finished chain.** The cascade from the CausalTrace preview: #50 merges, a wait fires, the session wakes and rebases, the checks pass, you merge #51 and the issue it closes, ?86 (adr4w0ds, "Show what Kiro Remote decided: waits, wakes and ended waits"), closes.
- **"Cause unknown" is the answer.** The three lost notes: no source recorded why the session was deleted, so the chain starts at the "cause unknown" stub and lists what it is not.
- **While it runs.** The same investigation under way: one link is only proposed (the merge of #52 as the cause of the delete), so its arrow says "unproven"; the steps show as a checklist with one running.

The issue is the one #51's description names ("Closes issue adr4w0ds"). #51 merged at 21:09 (19:09 UTC) on 23 November; the issue's close was recorded earlier on the branch (19:25 local) and reached `main` with the merge, so its time reads 21:09. The ruled-out reasons in the second and third states are illustrations in the log's own terms, not recorded findings.

## Parts and classes

Each part has one class, so the code builds the block from these names. The link card is written the same in the Graph preview's trace; change one, change both.

| Class | Part |
| --- | --- |
| `chain` | The block, on `page`. Blocks of one thread are told apart by a `line` hairline above. |
| `chain-title` | The question, `title` style in `ink`. |
| `chain-verdict` | One sentence in the serif `message` style, in `text`, above the links. |
| `chain-link` | One link: kind, card and source line, 112px wide. |
| `chain-kind` | The kind above the card, in `muted` capitals: SIGNAL, DEPLOYMENT, COMMIT, PULL REQUEST, ISSUE, DECISION, SESSION, THREAD, COMMAND. A Kiro session is a SESSION; a THREAD is a conversation thread (the lost notes). |
| `chain-card` | The card: `raised`, a `line` hairline, `--radius-card`. It keeps the ground's colours. |
| `chain-name` | The name in `ink`. The state is the chip beside it, drawn by the chip rule, never by the card. |
| `chain-seen` | "seen here" in `waiting-word`, beside the kind. The card gets a `waiting-mark` hairline and nothing else: no fill, no red. |
| `chain-when` | The source in `text` and its time in `muted`; the person's own acts read "you". |
| `chain-arrow` | A recorded cause: a solid `moved-mark` arrow, 1.6px. Unproven: a dashed `loop-mark` line with the word "unproven" on it, in `muted`. |
| `chain-stub` | "cause unknown", the dashed `loop-mark` stub of the CausalTrace preview. |
| `chain-open` | The open-end ring of the CausalTrace preview, with its words. |
| `chain-ruled-out` | "Ruled out": a cross in `loop-mark`, the cause in `text`, why in `muted`. While it runs: "Ruled out so far". |
| `chain-steps` | "Steps": the check mark in `done-mark` for a done step, the Working ring for the running one, a `idle-line` hairline circle for one not started. |

## Rules

- **One problem mark.** Exactly one link says "seen here".
- **Recorded or unproven, never a guess.** A recorded cause is solid. A proposed one is dashed and says "unproven" until evidence backs it. A cause nobody recorded is the stub. draft never turns one into the other.
- **A command is a cause, not a state.** Its card holds the command chip (`raised`, `line-strong` hairline, `ink`) and no state chip.
- **Shared marks.** Event chips, the command chip, the solid arrow, the dashed stub and the open-end ring are the CausalTrace preview's, not a second set.
- **Never colour alone.** Every link says its kind and state in words; the problem says "seen here"; an unproven link says "unproven".
- **Room for later.** The asks (sex1prmq) and what rests on this (wjfp7ca4) reuse the link card; nothing in the card is specific to a cause.
