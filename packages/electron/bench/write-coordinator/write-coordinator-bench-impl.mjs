// WriteCoordinator - production-quality pattern for serializing writes
// to a single better-sqlite3+WAL database without head-of-line blocking.
//
// Design (folded in from Pantheon council + Trident consensus):
//   - One coordinator per database file. Use WriteCoordinatorRegistry for multi-db.
//   - Two priority lanes: hot (UI saves, agent transcript) and bg (FTS backfill,
//     sync, VACUUM, incremental_vacuum).
//   - Hot lane coalesces incoming writes into batches of <= maxBatch statements
//     or <= maxBatchWindowMs, whichever first. One transaction per batch.
//   - Each write returns a CommitToken (Promise) that resolves when the batch
//     containing this write has committed. Callers await it for read-your-own-write;
//     fire-and-forget otherwise.
//   - Bg lane: caller submits a flat list of statements or an array-of-arrays
//     of statements (pre-chunked). Adaptive sizing via EMA of measured ms-per-
//     statement. Small workloads (estimated <= minWorkMs) skip chunking entirely.
//   - Bg duty cycle: hot can't starve bg forever. After hotStarvationMs of
//     hot-only activity, bg gets at least one chunk before next hot batch.
//   - Backpressure: hot/bg queue depth caps; over-limit writes reject immediately.
//   - Per-write writeId for batch-error attribution: if a batch rolls back, each
//     caller learns which statement triggered the failure (when identifiable).
//   - Reads bypass entirely - WAL handles read concurrency.
//
// Crash semantics: better-sqlite3 + WAL is per-tx durable. A crash mid-batch
// loses only the batch that was being assembled (none of its callers had been
// told their write committed). Callers must treat unresolved CommitTokens as
// "may or may not have committed" if the process crashes - the only authority
// is what's actually on disk after restart.

let _writeIdCounter = 0;

export class WriteCoordinator {
  /**
   * @param {Database} db - better-sqlite3 Database (must already be in WAL mode)
   * @param {object} [opts]
   * @param {number} [opts.maxBatch=50] - max statements per hot-lane batch tx
   * @param {number} [opts.maxBatchWindowMs=5] - max time to wait for batch to fill
   * @param {number} [opts.minWorkMs=8] - bg ops with estimated cost <= this skip chunking
   * @param {number} [opts.maxChunkStmts=150] - hard cap on chunk size
   * @param {number} [opts.minChunkStmts=8] - smallest chunk worth yielding around
   * @param {number} [opts.hotStarvationMs=300] - if hot dominates this long, bg gets a turn
   * @param {number} [opts.maxQueueDepth=800] - backpressure threshold (hot+bg combined)
   * @param {number} [opts.seedMsPerStmt=0.4] - initial EMA seed for adaptive chunking
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.maxBatch = opts.maxBatch ?? 50;
    this.maxBatchWindowMs = opts.maxBatchWindowMs ?? 5;
    this.minWorkMs = opts.minWorkMs ?? 8;
    this.maxChunkStmts = opts.maxChunkStmts ?? 150;
    this.minChunkStmts = opts.minChunkStmts ?? 8;
    this.hotStarvationMs = opts.hotStarvationMs ?? 300;
    this.maxQueueDepth = opts.maxQueueDepth ?? 800;

    this.hotQueue = [];   // { writeId, stmts, resolve, reject }
    this.bgQueue = [];    // { workId, chunks, resolve, reject }
    this.running = false;
    this._loopPromise = null;

    // EMA of ms per statement, separate for hot and bg
    this.emaHot = opts.seedMsPerStmt ?? 0.4;
    this.emaBg = opts.seedMsPerStmt ?? 0.4;
    this.emaAlpha = 0.2;

    this.lastBgRunAt = performance.now(); // for bg-duty-cycle accounting

    this._stmtCache = new Map(); // sql -> prepared statement (reused across batches)
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loopPromise = this._loop();
  }

  async stop() {
    this.running = false;
    if (this._loopPromise) await this._loopPromise;
    while (this.hotQueue.length) await this._drainHotBatch();
    while (this.bgQueue.length) await this._drainBgItem();
    for (const stmt of this._stmtCache.values()) { /* better-sqlite3 statements auto-finalize */ }
    this._stmtCache.clear();
  }

  /**
   * Submit a hot write. stmts: [{sql, params}, ...]
   * Returns a CommitToken (Promise<{writeId, ok: boolean, error?: Error}>)
   * that resolves when this write's batch has committed (ok=true) or rolled
   * back (ok=false). Throws QueueFullError if backpressure is engaged.
   */
  hotWrite(stmts) {
    if (this.hotQueue.length + this.bgQueue.length >= this.maxQueueDepth) {
      return Promise.reject(new QueueFullError(this.hotQueue.length, this.bgQueue.length));
    }
    const writeId = ++_writeIdCounter;
    return new Promise((resolve, reject) => {
      this.hotQueue.push({ writeId, stmts, resolve, reject });
    });
  }

  /**
   * Submit a bg op. work: array of {sql, params} OR array-of-arrays (pre-chunked).
   * Adaptive: if work is a flat array and estimated cost (count * emaBg) <= minWorkMs,
   * runs as a single chunk with no yields. Otherwise splits into chunks targeting
   * ~minWorkMs each, bounded by [minChunkStmts, maxChunkStmts].
   * Returns Promise<{workId, ok, error?, chunksRun, totalMs}>.
   */
  bgWrite(work) {
    if (this.hotQueue.length + this.bgQueue.length >= this.maxQueueDepth) {
      return Promise.reject(new QueueFullError(this.hotQueue.length, this.bgQueue.length));
    }
    const workId = ++_writeIdCounter;
    let chunks;
    if (Array.isArray(work) && work.length > 0 && Array.isArray(work[0])) {
      // pre-chunked
      chunks = work;
    } else if (Array.isArray(work)) {
      // flat - adaptive chunking
      const estimateMs = work.length * this.emaBg;
      if (estimateMs <= this.minWorkMs) {
        chunks = [work]; // small workload = single chunk, no yields
      } else {
        const targetPerChunk = Math.max(
          this.minChunkStmts,
          Math.min(this.maxChunkStmts, Math.ceil(this.minWorkMs / this.emaBg))
        );
        chunks = [];
        for (let i = 0; i < work.length; i += targetPerChunk) {
          chunks.push(work.slice(i, i + targetPerChunk));
        }
      }
    } else {
      return Promise.reject(new TypeError('bgWrite: work must be array or array-of-arrays'));
    }
    return new Promise((resolve, reject) => {
      this.bgQueue.push({ workId, chunks, resolve, reject });
    });
  }

  /** Read bypass: callers do this directly on db. Exposed for API symmetry. */
  read(sql, params = []) {
    return this._prepare(sql).all(...params);
  }

  /** Stats for observability (per Pantheon recommendation). */
  stats() {
    return {
      hotDepth: this.hotQueue.length,
      bgDepth: this.bgQueue.length,
      emaHotMsPerStmt: +this.emaHot.toFixed(3),
      emaBgMsPerStmt: +this.emaBg.toFixed(3),
      msSinceBgRun: Math.round(performance.now() - this.lastBgRunAt),
    };
  }

  // --- Internal ---

  _prepare(sql) {
    let s = this._stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmtCache.set(sql, s);
    }
    return s;
  }

  async _loop() {
    while (this.running) {
      const now = performance.now();
      const bgStarving = this.bgQueue.length > 0 && (now - this.lastBgRunAt) >= this.hotStarvationMs;

      if (this.hotQueue.length > 0 && !bgStarving) {
        await this._drainHotBatch();
        continue;
      }
      if (this.bgQueue.length > 0) {
        await this._drainBgItem();
        continue;
      }
      if (this.hotQueue.length > 0 && bgStarving) {
        // bg-starving path: serve hot anyway since we just checked bg is empty
        await this._drainHotBatch();
        continue;
      }
      await new Promise(r => setImmediate(r));
    }
  }

  async _drainHotBatch() {
    const start = performance.now();
    const batch = [];
    while (
      this.hotQueue.length > 0 &&
      batch.length < this.maxBatch &&
      (performance.now() - start) < this.maxBatchWindowMs
    ) {
      batch.push(this.hotQueue.shift());
      if (batch.length === 1 && this.hotQueue.length === 0) {
        // Brief yield to let more callers coalesce into this batch
        await new Promise(r => setImmediate(r));
      }
    }
    if (batch.length === 0) return;

    const stmtCount = batch.reduce((a, b) => a + b.stmts.length, 0);
    const t0 = performance.now();
    try {
      const tx = this.db.transaction(() => {
        for (const item of batch) {
          for (const s of item.stmts) {
            this._prepare(s.sql).run(...(s.params || []));
          }
        }
      });
      tx();
      const dt = performance.now() - t0;
      if (stmtCount > 0) this.emaHot = (1 - this.emaAlpha) * this.emaHot + this.emaAlpha * (dt / stmtCount);
      for (const item of batch) item.resolve({ writeId: item.writeId, ok: true });
    } catch (err) {
      // Whole batch rolled back. Surface to each caller with their writeId.
      for (const item of batch) item.resolve({ writeId: item.writeId, ok: false, error: err });
    }
  }

  async _drainBgItem() {
    const item = this.bgQueue.shift();
    if (!item) return;
    const start = performance.now();
    let chunksRun = 0;
    let totalStmts = 0;
    try {
      for (const chunk of item.chunks) {
        if (!chunk || chunk.length === 0) continue;
        const t0 = performance.now();
        const tx = this.db.transaction((items) => {
          for (const s of items) this._prepare(s.sql).run(...(s.params || []));
        });
        tx(chunk);
        const dt = performance.now() - t0;
        if (chunk.length > 0) this.emaBg = (1 - this.emaAlpha) * this.emaBg + this.emaAlpha * (dt / chunk.length);
        chunksRun++;
        totalStmts += chunk.length;
        this.lastBgRunAt = performance.now();
        // Yield between chunks - lets hot lane drain
        await new Promise(r => setImmediate(r));
        // If hot has work, prioritize it before next bg chunk
        if (this.hotQueue.length > 0) await this._drainHotBatch();
      }
      item.resolve({ workId: item.workId, ok: true, chunksRun, totalStmts, totalMs: Math.round(performance.now() - start) });
    } catch (err) {
      item.resolve({ workId: item.workId, ok: false, error: err, chunksRun, totalStmts, totalMs: Math.round(performance.now() - start) });
    }
  }
}

export class QueueFullError extends Error {
  constructor(hotDepth, bgDepth) {
    super(`WriteCoordinator queue full: hot=${hotDepth}, bg=${bgDepth}`);
    this.name = 'QueueFullError';
    this.hotDepth = hotDepth;
    this.bgDepth = bgDepth;
  }
}

/**
 * Registry for multi-db setups. One coordinator per database file.
 * Future-proofing: when nimbalyst shards (transcripts.db, fts.db, etc),
 * the call pattern stays the same; just pass a different dbPath.
 */
export class WriteCoordinatorRegistry {
  constructor() { this.coords = new Map(); }
  for(db, opts) {
    let c = this.coords.get(db);
    if (!c) {
      c = new WriteCoordinator(db, opts);
      c.start();
      this.coords.set(db, c);
    }
    return c;
  }
  async stopAll() {
    for (const c of this.coords.values()) await c.stop();
    this.coords.clear();
  }
}
