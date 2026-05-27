# Write Coordinator

A single-actor pattern for serialising writes to a single better-sqlite3 + WAL database, so concurrent agent processes and long-running background ops do not freeze the UI.

This is a **proposal**, not yet wired into production code. It is staged here so the eventual better-sqlite3 migration (tracked in #423) can adopt it with low integration risk.

- Implementation: `packages/electron/src/main/database/WriteCoordinator.ts`
- Spec / unit tests (gated until better-sqlite3 lands): `packages/electron/src/main/database/__tests__/WriteCoordinator.test.example.ts`
- Empirical performance bench: `packages/electron/bench/write-coordinator/`

## Problem

After the migration off PGLite to better-sqlite3 + WAL, two write-side problems remain:

1. **A long write blocks other writes.** WAL gives concurrent readers + one writer. If an FTS backfill, a heavy tracker JSON update, or an `incremental_vacuum` holds the writer slot for hundreds of ms, every other write queues behind it. UI saves stall.
2. **A long sync call on the JS main thread blocks everything.** better-sqlite3 is synchronous native. If a slow op is called as one sync transaction it blocks the entire Node event loop for its duration. Reads on the main thread, IPC handlers, timer callbacks, all queue behind it. The UI freezes even though WAL would otherwise let reads through.

The Codex Meta-Agent case (a parent session plus N subagents writing transcript + session state concurrently) is the same problem class: many writers contending for the single writer slot at the same time. Without coalescing, each pays its own fsync.

## Design

One `WriteCoordinator` instance per database file. All writes route through it. Two priority lanes:

### Hot lane

- For UI saves, agent transcript writes, session-state updates - anything user-facing or fast.
- Caller calls `coord.hotWrite(stmts)`. The call returns a `CommitToken` promise.
- Coordinator coalesces incoming hot writes into batches of `<= maxBatch` statements or `<= maxBatchWindowMs` (whichever first). One transaction per batch.
- All writes in a batch resolve together when the batch commits. Each caller gets a `{writeId, ok, error?}` result.
- Callers that need read-your-own-write `await` the token; fire-and-forget otherwise.

Benefit: under burst load, 50 individual hot writes become 1-2 batched transactions, paying 1-2 fsyncs instead of 50. Throughput goes up; tail latency stays bounded by batch-window + batch-time.

### Bg lane

- For FTS backfill, sync flushes, `incremental_vacuum`, batch imports - anything large or non-interactive.
- Caller calls `coord.bgWrite(work)` with either a flat statement list or a pre-chunked array of statement lists.
- Coordinator adaptively chunks based on EMA of measured ms-per-statement: small workloads (estimated <= `minWorkMs`) run as a single chunk with no yields; larger workloads chunk and yield between chunks.
- Between chunks, the coordinator yields the JS event loop (`setImmediate`) and re-checks the hot lane. If hot writes are queued, the hot batch drains before the next bg chunk.

Benefit: a slow op no longer monopolises the writer slot or the event loop. Hot writes interleave continuously. The slow op completes slightly slower in wall-time, but the UI never freezes.

### Reads

Reads bypass the coordinator entirely. WAL handles read concurrency natively; coordinator serialisation is only for the write side.

### Required Database PRAGMAs

The Database instance passed to the coordinator must already be in WAL mode and should have a `busy_timeout` set. The coordinator does NOT set these itself - they live with the Database lifecycle:

```ts
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000'); // required - the coord assumes the engine will wait
db.pragma('wal_autocheckpoint = 1000'); // soft cap; pair with explicit checkpoints
```

### WAL checkpoint policy

SQLite's docs at sqlite.org/wal.html document the "checkpoint starvation" failure mode: a long-lived reader holding a snapshot prevents the WAL file from being reset, and the WAL grows without bound. A 20GB WAL on a 2GB database is the canonical war story (see loke.dev/blog/sqlite-checkpoint-starvation-wal-growth for one writeup).

The coordinator exposes `coord.checkpoint(mode)` for explicit control:
- `'PASSIVE'` (default): non-blocking, runs only what it can without waiting.
- `'FULL'` waits for readers.
- `'RESTART'`: FULL + restarts the WAL after.
- `'TRUNCATE'`: RESTART + truncates the file on disk.

**Recommended policy** (callers, not the coord, decide when):
- After any large bg op (FTS rewrite, bulk JSON update): `await coord.checkpoint('TRUNCATE')`.
- On a daily or hourly schedule (whichever lines up with quiet periods).
- Before a backup snapshot.

### Required SQLite expression-index discipline

Expression indexes only match a query when the query's expression is **byte-for-byte identical** to the index's expression. `json_extract(data, '$.title')` and `json_extract(data, "$.title")` do NOT use the same index even though they look the same. Canonicalise every indexed JSON path expression in a single helper module; never let two call-sites independently write the same path.

### Fairness

- `hotStarvationMs` (default 300): if the hot lane has dominated for this long, the next bg chunk gets one turn before the next hot batch. Prevents bg starvation in pathological burst scenarios.
- `maxQueueDepth` (default 800): combined hot + bg queue depth cap. Writes beyond this reject with `QueueFullError` so callers can throttle or persist locally. Prevents unbounded memory pressure.

### Future-proofing: per-database coordinators

`WriteCoordinatorRegistry.for(db, opts)` returns a coordinator scoped to a specific Database instance. When the codebase later shards by `.db` file (FTS into `fts.db`, transcripts into `transcripts.db`, etc.), each database gets its own coordinator with its own EMA, queues, and fairness state. No call-site changes - the pattern composes naturally with sharding.

## Empirical results

From `packages/electron/bench/write-coordinator/results.md` (Codex-review-fixed v5 methodology):

| Backend | Baseline ops/s | Baseline p99 | Burst (50 in-process) total |
|---|---:|---:|---:|
| better-sqlite3+WAL (direct) | 8328 | 0.17ms | 3ms |
| better-sqlite3+WAL+Coordinator | 17946 | 1.35ms | 2ms |
| postgres | 920 | 6.24ms | 32ms |

Under HOL pressure (slow FTS rewrite + concurrent hot writes):

| Backend | slow-op | hot ops during | hot p99 during |
|---|---:|---:|---:|
| direct (dev-chunked) | 644ms | 500 | 1.3ms |
| coord | 2311ms | 10980 | 14ms |
| postgres | 188ms | 124 | 11.8ms |

Reading the table:

- Coord gives ~2x baseline throughput via transaction/fsync amortisation.
- Coord lets MORE hot ops run during a slow op (10980 vs 500) at the cost of higher p99 (14ms vs 1.3ms direct).
- The dev-direct path can match coord IF the dev chunks every slow op manually. Coord makes that a centralised policy instead of a discipline.
- PG loses on both throughput and latency for this single-user write workload.

## What this PR does NOT do

- Does not migrate the codebase off PGLite. That is the broader work tracked in #423.
- Does not wire any existing write call sites through the coordinator. Those changes belong in the migration PR(s).
- Does not validate the cross-process Codex Meta-Agent case (subagents over IPC). That requires a separate cross-process bench.
- Does not benchmark sustained load > 5s windows or WAL checkpoint pressure under that load.

## Open design questions for review

1. **CommitToken semantics on error.** Currently the whole batch rolls back on any error and every caller gets `ok: false` with the same `error`. A more granular API could attribute failures per-statement, but it requires running each statement in its own savepoint, which costs about 2x. Worth the complexity?
2. **Bg lane priority hints.** Some bg ops are "user clicked reindex - finish soon"; others are "drain when convenient". A `priority: 'soon' | 'whenever'` parameter on `bgWrite` would let callers express that. Add now or defer?
3. **Cross-process IPC layer.** The coordinator runs in main; subagent processes send via IPC. The IPC payload format (raw SQL? declarative ops? per-op writeId?) needs a separate design. Pantheon recommended declarative ops with an allow-list. Worth scoping in a follow-up doc.
4. **Automatic checkpoint after large bg ops.** The coord currently exposes `checkpoint()` and leaves the call to the application layer. An auto-policy ("checkpoint TRUNCATE after any bg op writing >5000 statements") would remove the discipline burden but adds a per-bg-op call overhead. Worth adding now or keep explicit?

## Adjacent risks for the broader migration (not coordinator scope)

These are surfaced from the deep-research pass and listed here so they don't get lost:

- **FTS5 vs to_tsvector parity testing.** Snowball stemming, BM25 vs ts_rank scoring, NEAR vs `<->` syntax. Greg's RFC's FTS workload needs a parity corpus before commit: markdown + agent transcripts + code-like identifiers (snake_case, dotted package names) with FTS5 `tokenchars` tuned for `_`, `-`, `.`, `@`, `/`.
- **Node ABI / better-sqlite3 version pin.** Current better-sqlite3 line targets Node 20.x+. Electron version pin needs to match. Verify before committing.
- **Encryption-at-rest.** The local DB stores tracker items, document history, AI sessions, transcript events. None of the visible storage code addresses encryption-at-rest, key management, or redaction. If this is a requirement, it's a separate workstream from the coordinator.
- **`embedded-postgres` fallback.** If kept around as a developer affordance, the asar packaging issue (paperclipai/paperclip#5410, leinelissen/embedded-postgres#18), `createPostgresUser` host-modification flag, and the ~57-200MB binary footprint per platform all need explicit gates in CI before this path can ship to end users.
