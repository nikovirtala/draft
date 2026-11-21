# Record deploy provenance for the products draft builds

## Goal
Carry deploy provenance (revision, repository, environment) for the software that draft's agents build and ship, not only for draft itself.

## Notes
- draft's own telemetry already carries `vcs.ref.head.revision`, `vcs.repository.url.full` and `deployment.environment.name` (packages/core `provenanceAttributes`).
- For products, provenance comes from the sessions and PRs draft supervises; it belongs in the log as status or step events.

## Done when
- A release of a product draft built is linked in the log to its commit, repository and environment.
