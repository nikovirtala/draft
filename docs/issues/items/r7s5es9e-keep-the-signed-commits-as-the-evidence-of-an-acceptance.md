# Keep the signed commits as the evidence of an acceptance

## Goal
When a person's acceptance is merged by rebase, the signed commits they accepted stay reachable and verifiable from what lands on main, so the proof of who accepted is one hop away rather than lost.

## Notes
- Found in ?42 on 2026-11-22 with nikovirtala/draft#20: all 19 commits on the pull request were verified (signed with Niko's SSH key), and all 19 copies GitHub made on main by Rebase and merge are unsigned.
- Niko chose to keep merging by rebase (ADR k8af6zrg) rather than fast-forward main, which would need a push to main past branch protection.
- GitHub keeps a pull request's commits under refs/pull/<n>/head, so the signed originals stay fetchable.
- At settlement, draft records for each accepted commit: the signed commit's SHA, GitHub's verification (verified and its reason) as read at that moment, and after the merge, the SHA of main's copy. The log then links main's copy to the signed original.
- The acceptance's stub and thread show the verification, so the person sees it was signed when they accepted.
- A check (later, as a fitness check) can walk main's accept commits and confirm each has a recorded signed original.

## Done when
- A test with the fake GitHub records the signed SHA, its verification and main's copy for each commit of an accepted pull request merged by rebase.
- In a real acceptance, the thread shows that the accepted commits were verified, and the log links main's copies to them.
