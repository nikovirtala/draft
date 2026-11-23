# Check

What a merged pull request still leaves for the person. A check that asks for you is `waiting-fill` as a whole (it drops the fill once answered, like a settled interrupt), with a "Waiting for you" wait chip, the title in `ink`, where it came from and how long it has waited. Opened, it gives the reason, then the steps: every command in a box with a Copy button, and what the person should see. It names the decision it gates, has a note field, and two answers: Failed, and Passed as the main action.

- **Failed**: no fill once answered, the failure chip (dashed `waiting-mark` hairline, a cross, the word) and one line of words with the person's note. Failing without a note says so in place, as a failure notice. Nothing is offered for the decision it gates.
- **Passed**: the done chip and one line of words, never a green block, and no fill of its own once answered. The decision it gated now offers its acceptance inside the check, as the usual request.
- Several checks that wait are counted in the title bar and listed on `surface`, one wait chip each.

The preview shows keyboard focus on Passed: a 1.5px `moved-mark` ring, no fill.

Screenshots it is compared with: `k01`, `k02`, `k03`, `k04`.
