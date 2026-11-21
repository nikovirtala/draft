# Wait for checks to start before offering acceptance

## Goal
A new head whose checks have not started yet must not look green in a repository where none are required.

## Notes
Zero reported checks count as green when GitHub says clean, so a repository without CI works and a missing required check shows as blocked. A new head with unstarted, unrequired checks looks green.

## Done when
- Decide whether to wait a grace period after a push before raising a request.
