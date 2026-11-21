# Open contexts bound to folders the person trusted

## Goal
A context has its own log and view state, is bound on this device to a folder the person trusted, and its agent works in that folder. A person opens one by sentence, from a recent list, with a path at launch, or by importing a DRAFT_DATA_DIR setup.

## Notes
ADRs 17gtag9n (contexts and registry), 1vey5j12 (where the agent runs, Kiro's trust), 4e115peq (one window per context), gw4vxvw4 (references across contexts). The existing log stays as the context local. Out of scope: sharing contexts, contexts suggested by the agent, the universe view in the map.

## Done when
- The existing log opens as the context local with its bytes and hash chain unchanged.
- A trusted folder is the agent's working directory; an untrusted one leaves the agent in its own workspace; both are shown in the log as a person's decision.
- Opening works by sentence with one confirmation, from a recent list, with a path at launch (a second launch hands it to the running app) and by import.
- A reference across contexts carries a snapshot, never reaches the agent unless pulled in, and every crossing is in the log.
- pnpm check and the end-to-end run pass.
