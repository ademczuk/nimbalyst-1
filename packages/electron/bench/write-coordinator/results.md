# HOL bench v5 results (Codex-review fixes applied)

Methodology:
- Hot workers use IDENTICAL async pacing across all backends (no sleep(0) penalty)
- Slow ops on bs3 backends are ALL chunked + yielding (direct uses hand-rolled chunk loop; coord uses bgWrite). The diff is who owns the discipline.
- Workers start BEFORE slow op so during/after classification is honest
- VACUUM uses incremental_vacuum(1000) on both bs3 backends
- Burst phase is in-process; cross-process IPC case unmeasured.

Seed: 1000 sessions, 20000 messages, 2000 trackers. Hot workers: 4. Baseline phase: 5000ms.

## Baseline

| Backend | ops/s | p50 | p99 | max |
|---|---:|---:|---:|---:|
| better-sqlite3+WAL (direct, dev-chunked) | 8328 | 0.04ms | 0.17ms | 115.03ms |
| better-sqlite3+WAL+Coordinator | 17946 | 0.1ms | 1.35ms | 208.11ms |
| postgres | 920 | 4.13ms | 6.24ms | 32.06ms |

## WRITES during FTS-rewrite HOL

| Backend | slow-op | during ops | during p50 | during p99 | during max | after ops | after p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| better-sqlite3+WAL (direct, dev-chunked) | 644ms | 500 | 0.05ms | 1.3ms | 1.36ms | 2340 | 0.19ms |
| better-sqlite3+WAL+Coordinator | 2311ms | 10980 | 0.22ms | 14.03ms | 16.48ms | 3284 | 1.34ms |
| postgres | 188ms | 124 | 5.91ms | 11.8ms | 16.86ms | 174 | 5.24ms |

## WRITES during JSON-update HOL

| Backend | slow-op | during ops | during p50 | during p99 | during max | after ops | after p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| better-sqlite3+WAL (direct, dev-chunked) | 7ms | 44 | 0.05ms | 0.26ms | 0.26ms | 2256 | 0.17ms |
| better-sqlite3+WAL+Coordinator | 5ms | 12 | 1.23ms | 1.66ms | 1.66ms | 3188 | 1.49ms |
| postgres | 10ms | 7 | 5.16ms | 13.61ms | 13.61ms | 189 | 4.95ms |

## WRITES during incremental_vacuum HOL

| Backend | slow-op | during ops | during p50 | during p99 | during max | after ops | after p99 |
|---|---:|---:|---:|---:|---:|---:|---:|
| better-sqlite3+WAL (direct, dev-chunked) | 0ms | 8 | 0.06ms | 0.21ms | 0.21ms | 2260 | 0.17ms |
| better-sqlite3+WAL+Coordinator | 0ms | 8 | 0.13ms | 0.17ms | 0.17ms | 3424 | 1.37ms |
| postgres | 113ms | 105 | 4.04ms | 8.88ms | 11.47ms | 200 | 4.28ms |

## READS during FTS-rewrite

| Backend | slow-op | during ops | during p50 | during p99 | after p99 |
|---|---:|---:|---:|---:|---:|
| better-sqlite3+WAL (direct, dev-chunked) | 662ms | 524 | 0.01ms | 0.06ms | 0.02ms |
| better-sqlite3+WAL+Coordinator | 1354ms | 1000 | 0.01ms | 0.07ms | 0.03ms |
| postgres | 251ms | 353 | 2.75ms | 5.01ms | 4.16ms |

## Multi-writer burst (50 concurrent in-process writes)

CAVEAT: in-process burst, not cross-process IPC. Real Codex Meta-Agent case requires cross-process bench.

| Backend | total ms | avg/write | p50 | p99 | max |
|---|---:|---:|---:|---:|---:|
| better-sqlite3+WAL (direct, dev-chunked) | 3 | 0.07ms | 1.45ms | 3.26ms | 3.26ms |
| better-sqlite3+WAL+Coordinator | 2 | 0.03ms | 1.16ms | 1.52ms | 1.52ms |
| postgres | 32 | 0.64ms | 27.45ms | 31.85ms | 31.85ms |
