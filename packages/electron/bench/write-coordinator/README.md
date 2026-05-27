# WriteCoordinator HOL Bench

This bench measures whether the `WriteCoordinator` pattern fixes head-of-line blocking on a single-writer SQLite + WAL database under three workload shapes Greg's RFC names: FTS-style bulk rewrites, JSON-heavy bulk updates, and incremental_vacuum.

Production code: `packages/electron/src/main/database/WriteCoordinator.ts`

The bench impl in `write-coordinator-bench-impl.mjs` is a plain-JS sibling of the production TypeScript class - identical logic, ESM `.mjs` for fast iteration outside the Electron build.

## Running

The bench runs natively on the host. Only Postgres goes in docker so the bs3+coord vs PG comparison is fair.

```bash
# 1. Start the Postgres comparison backend
docker compose up -d postgres

# 2. Install deps (compiles better-sqlite3 native module for your host arch)
npm install

# 3. Run the bench
node --no-warnings bench.mjs

# 4. Tear down
docker compose down
```

Output: `results.json` (raw) and `results.md` (rendered table).

Knobs via env vars: `PHASE_MS` (default 5000), `PG_URL` (default `postgres://postgres:bench@127.0.0.1:15555/nimbalyst_bench`).

### Per-platform notes

**macOS (arm64 or x64):**
- Requires Xcode Command Line Tools for the `better-sqlite3` native compile. If `npm install` fails with `gyp ERR! ...`, run `xcode-select --install` once and retry.
- Docker Desktop required for the Postgres backend. Apple Silicon: confirmed working with `postgres:16-alpine` (multi-arch image).

**Linux (glibc):**
- Needs `python3`, `make`, `g++` for the native compile if a prebuilt binary is not available. On Debian/Ubuntu: `apt-get install python3 make g++`.

**Windows:**
- Needs Visual Studio Build Tools or `windows-build-tools` for native compile fallback. Most recent Node distributions on Windows ship prebuilds so npm install usually does not need to compile.

### Troubleshooting

- `EADDRINUSE: 15555` - another process holds the port. Either stop it or remap in `docker-compose.yml`.
- `Cannot find module 'better-sqlite3'` after `npm install` - the native module didn't compile. See platform notes above. As a quick sanity check: `node -e "require('better-sqlite3')(':memory:')"`.
- PG seed phase takes 13s - that's the first-run insert latency over the docker network. Expected. Subsequent phases are fast.
- bs3 phases are sub-second per phase; the whole bench takes about 60-90s end to end (Postgres seed dominates).

## What it measures

Five phases per backend:

1. **Baseline.** 4 concurrent hot writers, no slow op. Sustains for `PHASE_MS`.
2. **WRITES during FTS-rewrite HOL.** Single slow op rewrites all `ai_agent_messages` content. Hot writers concurrent. Split latencies by during-slow-op vs after-slow-op buckets.
3. **WRITES during JSON-update HOL.** Single slow op patches all `tracker_items.data`. Hot writers concurrent.
4. **WRITES during VACUUM HOL.** Single slow op runs `incremental_vacuum(1000)`. Hot writers concurrent.
5. **READS during FTS-rewrite HOL.** 4 read workers concurrent with the FTS slow op.
6. **Multi-writer burst.** 50 concurrent in-process writes fired at once. Measures batch-coalescing.

Three backends compared:

- `better-sqlite3+WAL (direct, dev-chunked)` - dev manually chunks slow ops with explicit yields.
- `better-sqlite3+WAL+Coordinator` - same DB engine, slow ops routed through `coord.bgWrite(work)` which chunks adaptively.
- `postgres` - upper-bound reference (semantic equivalent of embedded-Postgres).

## Methodology notes (from Codex adversarial review)

- All hot workers use IDENTICAL pacing across backends. Every iteration ends with `await new Promise(r => setImmediate(r))` so a setTimeout-based stop signal can fire and no backend gets unfair scheduling penalty.
- Slow ops on the bs3 backends both yield between chunks. The diff between the two bs3 backends is who owns the chunking: the dev (direct) or the coordinator (coord). Both preserve interleaving.
- Workers start BEFORE the slow op so the "during" classifier sees real overlap. Ops that span the slow-op boundary are classified by their start time.
- VACUUM uses `incremental_vacuum(1000)` on both bs3 backends (not full VACUUM, which would be a different operation).

## What it does NOT measure

- **Cross-process Codex Meta-Agent burst.** This bench's multi-writer burst is in-process Promise.all. Real subagents writing via IPC have a different latency profile. A cross-process bench is the next item to build.
- **First-run / cold-cache.** All phases run on a hot cache after seeding.
- **WAL checkpoint pressure under sustained load.** Long-running real workloads need explicit checkpointing or `wal_autocheckpoint` tuning; this bench's 5s window does not stress that.

## Honest results summary

Coordinator delivers about 2x baseline write throughput via transaction/fsync amortisation. It trades slightly higher p99 (1.35ms vs 0.17ms direct) for that throughput. The slow op completes 3-4x slower under coord because hot writes get more share - acceptable when the goal is "user never sees a freeze," but worth knowing.

Both bs3 backends keep read latency at ~0.06ms p99 during a slow write. WAL handles read-during-write contention natively.

PG loses on both throughput (920 ops/s) and latency (6.24ms p99 baseline) for this single-user workload. Its concurrent-write strengths show up only when row-level locks are exercised, which this bench does not.

Full numbers: see `results.md`.
