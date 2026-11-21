# Raise an acceptance request only on green evidence, ranked after failures, and let only a person answer

## Context
Every human gate in draft should be one pattern: something waits for a person's yes with its evidence attached (docs/model.md, Acceptance). ADR f50z57dk said acceptance requests would join the attention order as a kind with a rank, and left the rank open. The next slice drafts decisions, tasks and designs as ark records that are accepted here, so the pattern must not be written for ADRs and pull requests alone.

## Decision
An acceptance request is an interrupt of the kind acceptance, raised by the resolver of the thing waiting (an ADR, a pull request). The kind of record declares its own evidence, the effect of each answer and the inverse of that effect (reversible, compensable with a named step, or irreversible with a reason); the interface in packages/core/src/acceptance.ts takes any such kind, and the UI draws whatever evidence the request carries. The request is raised only while every item of its evidence is green, and cleared with a reason when one goes red or the thing is closed. Its key names the commit it was judged on, so a new push is a new request and an answered one stays answered. Its rank sits between failures and what is left to resolve: after something broken, before interrupted steps and conclusions, because green work waiting for a yes is what the rest of the process is stopped at, and a failure may make it moot. The answers are accepted, changes-requested and rejected. Changes requested posts the person's note into the thread as a message to the agent and waits for new evidence; rejected needs a reason. Acceptance runs on the state machine module: the transitions that accept, reject or request changes are marked person only, and a transition with an effect must declare its inverse, which the checker enforces. The completion of the step that carried the answer out records the resulting commit or merge SHA, the evidence as it was when the person answered and the declared inverse. Nothing executes an inverse yet. For an ADR, accepting is a signed commit on the proposing pull request's branch, and merging that pull request is a second, separate acceptance.

## Scope
packages/core/src/acceptance.ts
packages/core/src/interrupts.ts
packages/core/src/machine.ts

## Consequences
Evidence is declared once per kind, so a new kind of record needs no UI work. A request can disappear while the person looks at it, when a check goes red; answering a request whose evidence changed is refused. An ADR that is already on the default branch as proposed has no proposing pull request, so it gets no request until a later change gives it a branch. Reverts, drafting records and accepting issues are not part of this decision.
