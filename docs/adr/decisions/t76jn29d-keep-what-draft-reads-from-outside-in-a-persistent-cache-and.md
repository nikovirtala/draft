# Keep what draft reads from outside in a persistent cache and show the last snapshot at launch

## Context
Every launch of draft starts from empty memory. `ArkRecords` keeps what it read from GitHub (blobs by sha, tree shas, pull request heads) and `GithubClient` keeps ETags, all in process memory. The ledgers of nikovirtala/draft and nikovirtala/ark hold 212 and 269 event files, and each title, relation and resolution is one blob request, made one at a time, at most 100 a refresh, one refresh every 30 s. The map takes minutes to fill, on every launch, and a person without a token (60 requests an hour) never sees it fill.

What draft reads from outside is of two kinds. A blob, addressed by its sha, can never change. A listing (a tree, the open pull requests, deployments) can change and answers `304 Not Modified`, which GitHub does not count against the rate limit, when sent its ETag. The causal trace (ADR cqwg12zy) and kiro-remote's feed need the same two things: content by address, and the last marker seen per source (tree sha, ETag, cursor).

Options considered:

- Read the ledgers from the local clone: no request at all for a repository that is cloned, but it needs a clone of every covered repository, it reads the working tree and not the default branch on GitHub, and it does not help the pull request heads. Not now.
- GitHub GraphQL batches: one request can carry many blobs, which makes a first load cheaper. The client is REST-only and GET-only by decision 9p8jj6p5 (GraphQL is POST), and a query costs rate limit points, not nothing. Not now.
- A tarball of the repository: one request for every file, but it moves the whole repository, ignores ETag savings on a second launch unless it is cached too, and needs unpacking. Not now.
- A persistent cache of what was read, and the last derived snapshot: chosen.

## Decision
draft keeps what it reads from outside in a persistent cache on the device, so a launch begins from what the last one read.

- **Content by address is kept forever.** A blob read by its sha is stored by that sha and never fetched twice on a device, since its content can't change.
- **Conditional reads are kept with their ETag.** A response to a GET is stored by URL and media type with its ETag and body, and sent back as `If-None-Match`, so an unchanged answer is a 304 that costs no rate limit. The cache outlives the process.
- **The last derived snapshot is shown at launch.** Per context, draft stores the last `ArkSnapshot` with the tree sha and pull request heads key it was derived from and when it was read. The map shows it at once, saying it is as of that time, until the first refresh replaces it. When the tree sha and heads are unchanged, the refresh reads nothing else.
- **The store is small and general.** It holds content by address and, per source, the last seen marker (tree sha, ETag, cursor), and nothing specific to ark's records, so the causal trace and kiro-remote's feed can use it.
- **It is a cache, never a source of truth.** It lives in its own file per device, `cache.db`, beside `device.db`, uses `node:sqlite` (ADR t8bp85a7), is bounded in size (the least recently used entries go first) and can be deleted at any time: the next launch reads again and loses time, nothing else. Nothing in it is written to the log (ADR q7hkbw4h), and a projection built from it is a projection of what the log and the sources say.
- **The first load, with nothing stored,** reads blobs with bounded concurrency and a larger budget for a context's first refresh, still within the rate limit. Without a token the map says a token is needed for the first load to finish.

## Scope
Everything draft reads from GitHub and keeps across launches: `packages/core/src/github.ts` (conditional reads), `packages/core/src/ark-records.ts` and `map-ark.ts` (blobs, snapshot, the first load), the cache store in `packages/core`, and its file under each context's directory in `apps/desktop/src/main/contexts/`. It adds a database next to the ones ADR t8bp85a7 names, `cache.db`, which is also never a source of truth.

## Consequences
Easier: a second launch shows the map at once and refreshes with a few 304s, with no blob request; a first load takes a fraction of the time; the same store serves other sources.

Harder: a snapshot on screen can be old, so it is labelled as of its time until the refresh replaces it, and a snapshot written by an older build is discarded when its shape changes (it carries a version). The cache grows to its bound, 50 MB, on each device, and holds the text of ledger files, which in a private repository is private content on the person's disk, as the clones draft makes already are.

Risk: a cache that outlives its source could show what GitHub no longer says. A blob by sha can't be wrong, a listing is validated by its ETag at each refresh, and a snapshot is replaced by the first refresh that succeeds. Deleting `cache.db` is always safe.

Alternatives left open: the local clone, GraphQL batches and a tarball stay candidates if the first load still hurts.
