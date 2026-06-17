/**
 * WriteCoordinator - serialise writes to a single better-sqlite3+WAL database
 * without head-of-line blocking from slow ops.
 *
 * Two priority lanes:
 *   - hot: UI saves, agent transcript writes. Coalesces incoming writes into
 *     batches of <= maxBatch statements or <= maxBatchWindowMs, whichever first.
 *     One transaction per batch. Amortises fsync cost across many callers.
 *   - bg: FTS backfill, sync, incremental_vacuum. Caller submits a list of
 *     statements; the coordinator adaptively chunks based on an EMA of measured
 *     ms-per-statement. Small workloads (estimated <= minWorkMs) run as one
 *     chunk with no yields. Larger workloads chunk and yield between chunks so
 *     the hot lane can interleave.
 *
 * Reads bypass entirely - WAL handles read concurrency natively.
 *
 * Each write returns a CommitToken (Promise<CommitResult>) that resolves when
 * the batch containing this write has committed. Callers needing
 * read-your-own-write semantics await the token; fire-and-forget otherwise.
 *
 * Crash semantics: better-sqlite3 + WAL is per-tx durable. A crash mid-batch
 * loses only the in-flight batch (whose callers had not yet been told their
 * write committed). Callers must treat unresolved CommitTokens as "may or may
 * not have committed" if the process crashes - the only authority is what is
 * on disk after restart.
 *
 * Design contributors: Pantheon council deliberation + Trident multi-model
 * consensus + Codex adversarial review of bench methodology. Empirical data
 * available in `packages/electron/bench/write-coordinator/`.
 */

import type Database from 'better-sqlite3';

let _writeIdCounter = 0;

export interface Statement {
  sql: string;
  params?: ReadonlyArray<unknown>;
}

export interface CommitResult {
  writeId: number;
  ok: boolean;
  error?: Error;
}

export interface BgWriteResult {
  workId: number;
  ok: boolean;
  error?: Error;
  chunksRun: number;
  totalStmts: number;
  totalMs: number;
}

export interface CoordinatorStats {
  hotDepth: number;
  bgDepth: number;
  emaHotMsPerStmt: number;
  emaBgMsPerStmt: number;
  msSinceBgRun: number;
}

export interface WriteCoordinatorOptions {
  /** Max statements per hot-lane batch transaction. Default 50. */
  maxBatch?: number;
  /** Max time (ms) to wait for a hot batch to fill. Default 5. */
  maxBatchWindowMs?: number;
  /** Bg ops with estimated cost <= this (ms) skip chunking. Default 8. */
  minWorkMs?: number;
  /** Hard upper bound on chunk size. Default 500. */
  maxChunkStmts?: number;
  /** Lower bound below which chunking is not worth the yield cost. Default 8. */
  minChunkStmts?: number;
  /** If hot dominates this long (ms) bg gets at least one chunk. Default 300. */
  hotStarvationMs?: number;
  /** Backpressure threshold on combined queue depth. Default 800. */
  maxQueueDepth?: number;
  /** Initial EMA seed (ms per statement). Default 0.4. */
  seedMsPerStmt?: number;
}

export class QueueFullError extends Error {
  constructor(public readonly hotDepth: number, public readonly bgDepth: number) {
    super(`WriteCoordinator queue full: hot=${hotDepth}, bg=${bgDepth}`);
    this.name = 'QueueFullError';
  }
}

interface HotItem {
  writeId: number;
  stmts: ReadonlyArray<Statement>;
  resolve: (r: CommitResult) => void;
  reject: (e: Error) => void;
}

interface BgItem {
  workId: number;
  chunks: ReadonlyArray<ReadonlyArray<Statement>>;
  resolve: (r: BgWriteResult) => void;
  reject: (e: Error) => void;
}

export class WriteCoordinator {
  private readonly maxBatch: number;
  private readonly maxBatchWindowMs: number;
  private readonly minWorkMs: number;
  private readonly maxChunkStmts: number;
  private readonly minChunkStmts: number;
  private readonly hotStarvationMs: number;
  private readonly maxQueueDepth: number;

  private hotQueue: HotItem[] = [];
  private bgQueue: BgItem[] = [];
  private running = false;
  private loopPromise: Promise<void> | null = null;

  // EMA of ms per statement, separate for hot and bg
  private emaHot: number;
  private emaBg: number;
  private readonly emaAlpha = 0.2;

  private lastBgRunAt: number;

  // Prepared statement cache - reused across batches.
  private readonly stmtCache = new Map<string, Database.Statement>();

  constructor(private readonly db: Database.Database, opts: WriteCoordinatorOptions = {}) {
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxBatchWindowMs = opts.maxBatchWindowMs ?? 5;
    this.minWorkMs = opts.minWorkMs ?? 8;
    this.maxChunkStmts = opts.maxChunkStmts ?? 500;
    this.minChunkStmts = opts.minChunkStmts ?? 8;
    this.hotStarvationMs = opts.hotStarvationMs ?? 300;
    this.maxQueueDepth = opts.maxQueueDepth ?? 800;
    this.emaHot = opts.seedMsPerStmt ?? 0.4;
    this.emaBg = opts.seedMsPerStmt ?? 0.4;
    this.lastBgRunAt = performance.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) await this.loopPromise;
    // Drain anything still queued so callers do not hang on unresolved tokens.
    while (this.hotQueue.length) await this.drainHotBatch();
    while (this.bgQueue.length) await this.drainBgItem();
    this.stmtCache.clear();
  }

  /**
   * Submit a hot write. Returns a CommitToken (Promise<CommitResult>) that
   * resolves when this write's batch has committed (ok: true) or rolled back
   * (ok: false, error populated). Throws QueueFullError if backpressure is engaged.
   */
  hotWrite(stmts: ReadonlyArray<Statement>): Promise<CommitResult> {
    if (this.hotQueue.length + this.bgQueue.length >= this.maxQueueDepth) {
      return Promise.reject(new QueueFullError(this.hotQueue.length, this.bgQueue.length));
    }
    const writeId = ++_writeIdCounter;
    return new Promise<CommitResult>((resolve, reject) => {
      this.hotQueue.push({ writeId, stmts, resolve, reject });
    });
  }

  /**
   * Submit a bg op. Pass:
   *   - a flat list of statements (auto-chunked via EMA)
   *   - or a pre-chunked array of arrays (used as-is)
   */
  bgWrite(work: ReadonlyArray<Statement> | ReadonlyArray<ReadonlyArray<Statement>>): Promise<BgWriteResult> {
    if (this.hotQueue.length + this.bgQueue.length >= this.maxQueueDepth) {
      return Promise.reject(new QueueFullError(this.hotQueue.length, this.bgQueue.length));
    }
    const workId = ++_writeIdCounter;

    let chunks: ReadonlyArray<ReadonlyArray<Statement>>;
    if (Array.isArray(work) && work.length > 0 && Array.isArray((work as unknown[])[0])) {
      // Pre-chunked.
      chunks = work as ReadonlyArray<ReadonlyArray<Statement>>;
    } else {
      // Flat list - adaptive chunking via EMA.
      const flat = work as ReadonlyArray<Statement>;
      const estimateMs = flat.length * this.emaBg;
      if (estimateMs <= this.minWorkMs) {
        chunks = [flat];
      } else {
        const targetPerChunk = Math.max(
          this.minChunkStmts,
          Math.min(this.maxChunkStmts, Math.ceil(this.minWorkMs / this.emaBg))
        );
        const out: Statement[][] = [];
        for (let i = 0; i < flat.length; i += targetPerChunk) {
          out.push(flat.slice(i, i + targetPerChunk));
        }
        chunks = out;
      }
    }

    return new Promise<BgWriteResult>((resolve, reject) => {
      this.bgQueue.push({ workId, chunks, resolve, reject });
    });
  }

  /** Read bypass - exposed for API symmetry. Callers can also use db directly. */
  read<R = unknown>(sql: string, params: ReadonlyArray<unknown> = []): R[] {
    return this.prepareCached(sql).all(...(params as unknown[])) as R[];
  }

  stats(): CoordinatorStats {
    return {
      hotDepth: this.hotQueue.length,
      bgDepth: this.bgQueue.length,
      emaHotMsPerStmt: +this.emaHot.toFixed(3),
      emaBgMsPerStmt: +this.emaBg.toFixed(3),
      msSinceBgRun: Math.round(performance.now() - this.lastBgRunAt),
    };
  }

  /**
   * Force a WAL checkpoint. Call periodically (e.g. after large bg ops) to
   * keep the WAL file bounded. Long-lived readers can prevent automatic
   * checkpointing under `wal_autocheckpoint`, so an explicit call is the
   * standard mitigation for the WAL-bloat failure mode documented at
   * sqlite.org/wal.html (the "checkpoint starvation" section).
   *
   * Mode: 'PASSIVE' (default, no blocking), 'FULL' (waits for writers),
   * 'RESTART' (FULL + restarts the WAL after), 'TRUNCATE' (RESTART + truncates).
   * Use TRUNCATE after a known-large bg op to reclaim disk.
   */
  checkpoint(mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE'): {
    busy: number; log: number; checkpointed: number;
  } {
    const row = this.db.pragma(`wal_checkpoint(${mode})`, { simple: false }) as Array<{
      busy: number; log: number; checkpointed: number;
    }>;
    return row[0] ?? { busy: -1, log: -1, checkpointed: -1 };
  }

  // ----- internal -----

  private prepareCached(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      const bgStarving = this.bgQueue.length > 0 && (performance.now() - this.lastBgRunAt) >= this.hotStarvationMs;
      if (this.hotQueue.length > 0 && !bgStarving) {
        await this.drainHotBatch();
        continue;
      }
      if (this.bgQueue.length > 0) {
        await this.drainBgItem();
        continue;
      }
      if (this.hotQueue.length > 0 && bgStarving) {
        await this.drainHotBatch();
        continue;
      }
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  private async drainHotBatch(): Promise<void> {
    const start = performance.now();
    const batch: HotItem[] = [];
    while (
      this.hotQueue.length > 0 &&
      batch.length < this.maxBatch &&
      (performance.now() - start) < this.maxBatchWindowMs
    ) {
      batch.push(this.hotQueue.shift()!);
      if (batch.length === 1 && this.hotQueue.length === 0) {
        // Tiny coalesce window - let more callers arrive before committing.
        await new Promise<void>((r) => setImmediate(r));
      }
    }
    if (batch.length === 0) return;

    const stmtCount = batch.reduce((a, b) => a + b.stmts.length, 0);
    const t0 = performance.now();
    const runBatch = () => {
      const tx = this.db.transaction(() => {
        for (const item of batch) {
          for (const s of item.stmts) {
            this.prepareCached(s.sql).run(...((s.params ?? []) as unknown[]));
          }
        }
      });
      tx();
    };
    try {
      // Retry on SQLITE_BUSY / SQLITE_LOCKED with small backoff. better-sqlite3's
      // built-in busy_timeout handles short waits; this is a belt-and-braces
      // retry for the rare case where the timeout itself elapses (long-lived
      // reader holding a snapshot, etc.).
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try { runBatch(); break; }
        catch (err) {
          const code = (err as { code?: string }).code;
          if ((code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') && attempt < 3) {
            attempt++;
            await new Promise<void>((r) => setTimeout(r, 5 * Math.pow(2, attempt))); // 10, 20, 40 ms
            continue;
          }
          throw err;
        }
      }
      const dt = performance.now() - t0;
      if (stmtCount > 0) this.emaHot = (1 - this.emaAlpha) * this.emaHot + this.emaAlpha * (dt / stmtCount);
      for (const item of batch) item.resolve({ writeId: item.writeId, ok: true });
    } catch (err) {
      // Batch rolled back. Surface error to every caller; idempotent retry is theirs.
      const e = err instanceof Error ? err : new Error(String(err));
      for (const item of batch) item.resolve({ writeId: item.writeId, ok: false, error: e });
    }
  }

  private async drainBgItem(): Promise<void> {
    const item = this.bgQueue.shift();
    if (!item) return;
    const start = performance.now();
    let chunksRun = 0;
    let totalStmts = 0;
    try {
      for (const chunk of item.chunks) {
        if (!chunk || chunk.length === 0) continue;
        const t0 = performance.now();
        const tx = this.db.transaction((items: ReadonlyArray<Statement>) => {
          for (const s of items) this.prepareCached(s.sql).run(...((s.params ?? []) as unknown[]));
        });
        tx(chunk);
        const dt = performance.now() - t0;
        if (chunk.length > 0) this.emaBg = (1 - this.emaAlpha) * this.emaBg + this.emaAlpha * (dt / chunk.length);
        chunksRun++;
        totalStmts += chunk.length;
        this.lastBgRunAt = performance.now();
        // Yield between chunks so hot lane can interleave.
        await new Promise<void>((r) => setImmediate(r));
        if (this.hotQueue.length > 0) await this.drainHotBatch();
      }
      item.resolve({
        workId: item.workId, ok: true,
        chunksRun, totalStmts, totalMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      item.resolve({
        workId: item.workId, ok: false, error: e,
        chunksRun, totalStmts, totalMs: Math.round(performance.now() - start),
      });
    }
  }
}

/**
 * Registry for multi-db setups. One coordinator per database file. The pattern
 * composes cleanly with future sharding (transcripts.db, fts.db, etc.) - just
 * pass a different Database instance.
 */
export class WriteCoordinatorRegistry {
  private readonly coords = new Map<Database.Database, WriteCoordinator>();

  for(db: Database.Database, opts?: WriteCoordinatorOptions): WriteCoordinator {
    let c = this.coords.get(db);
    if (!c) {
      c = new WriteCoordinator(db, opts);
      c.start();
      this.coords.set(db, c);
    }
    return c;
  }

  async stopAll(): Promise<void> {
    for (const c of this.coords.values()) await c.stop();
    this.coords.clear();
  }
}
