# Fix what the map's first real use showed

## Goal
The map's first run on Niko's Mac (kiro-remote context, 22 Nov) counted decisions and issues exactly, but asked him about a failure nobody needs to act on and showed some noise. Fix those so what the map lights is always real.

## Notes
- **A failed deployment that is already handled waits on you.** kiro-remote production shows Failed · 1 for you: the failing-smoke-check drill. @nikovirtala/deployment marks earlier successes inactive when a run succeeds and leaves failures as they are on purpose (ark packages/deployment/src/provenance.ts and its test), so a failure stays `failure` on GitHub forever. A failure should wait on you only while it is the newest deployment of its environment; a later deployment that succeeds resolves it. While it is the newest, whether it still needs you depends on the freeze, which the map can't read: ark's companion issue has the unfreeze mark the failure, and the map should read that mark as resolved.
- **The "still reading … from GitHub" line is printed twice.**
- **The empty-state text is out of date:** it names only draft's own kinds, not decisions, issues and deployments.
- **Empty rows fill the panel before anything has happened** (eight rows of zeros). Decide in the graph view issue whether empty kinds show at all; here, at least keep `alwaysShown` rows to the ones that help.
- Checked against the repositories: Accepted 44, Superseded 4, issues 77 / 1 / 67 equal the sums of draft, ark and kiro-remote; Proposed 14 is main's 13 plus one proposal on an open pull request branch, as designed.

## Done when
- A failed deployment followed by a success in the same environment, or marked resolved by the unfreeze, shows as settled and not for you; tests cover both and a failure that is still the newest.
- The reading line shows once, the empty state names every kind on the map, and the fixture context's map has no row of only zeros that the registry didn't mean to show.
