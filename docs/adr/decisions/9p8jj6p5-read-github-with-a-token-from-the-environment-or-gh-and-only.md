# Read GitHub with a token from the environment or gh, and only read

## Context
The pull request and ark issue resolvers need GitHub. draft stores no credential.

## Decision
The resolvers use GITHUB_TOKEN from the environment, else the output of gh auth token, else no token and public access, with a note in the main conversation saying so. The client has no way to send anything but GET and uses ETags so an unchanged resource answers 304. A fine-grained token with read access to pull requests, checks, commit statuses and contents is enough; draft never needs write scope. A rate limit is a failed poll that backs off at least as long as GitHub asks.

## Scope
packages/core/src/github.ts and the resolvers that use it.

## Consequences
Without a token, private repositories do not resolve, a review requested from you cannot be told, and 60 requests an hour is the limit. A gh token has the scopes gh gave it, which are broader than draft needs; draft still only reads.
