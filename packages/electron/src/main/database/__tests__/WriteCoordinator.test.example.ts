// PROPOSAL: this test file is a spec for the WriteCoordinator. It is named
// `.example.ts` instead of `.test.ts` so vitest does not run it before
// better-sqlite3 is installed in the repo. Once the migration to better-sqlite3
// lands and `better-sqlite3` is in packages/electron/package.json, rename this
// file to `WriteCoordinator.test.ts` to enable it.
//
// Empirical performance results live in packages/electron/bench/write-coordinator/.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WriteCoordinator, QueueFullError } from '../WriteCoordinator';

describe('WriteCoordinator', () => {
  let dbPath: string;
  let db: Database.Database;
  let coord: WriteCoordinator;

  beforeEach(() => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-test-'));
    dbPath = path.join(tmpdir, 'test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INTEGER)`);
    coord = new WriteCoordinator(db, { maxBatch: 10, maxBatchWindowMs: 5 });
    coord.start();
  });

  afterEach(async () => {
    await coord.stop();
    db.close();
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('hot write commits and the row is visible after the token resolves', async () => {
    const r = await coord.hotWrite([
      { sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: ['hello', 1] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.writeId).toBeGreaterThan(0);
    const rows = db.prepare('SELECT * FROM t').all() as Array<{ id: number; v: string; n: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].v).toBe('hello');
  });

  it('batches multiple concurrent hot writes into one transaction', async () => {
    // Fire 30 concurrent hot writes. With maxBatch=10 and a 5ms window, these
    // should land in <= 4 batches (probably 3).
    const writes: Promise<{ ok: boolean }>[] = [];
    for (let i = 0; i < 30; i++) {
      writes.push(coord.hotWrite([{ sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: [`v${i}`, i] }]));
    }
    const results = await Promise.all(writes);
    expect(results.every(r => r.ok)).toBe(true);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
    expect(count).toBe(30);
  });

  it('rolls back the whole batch on a constraint violation and surfaces error to each caller', async () => {
    // First successful write so the table has a row with id=1
    await coord.hotWrite([{ sql: 'INSERT INTO t (id, v, n) VALUES (1, ?, ?)', params: ['a', 1] }]);

    // Now fire 3 writes where the middle one will conflict on id=1
    const a = coord.hotWrite([{ sql: 'INSERT INTO t (id, v, n) VALUES (2, ?, ?)', params: ['b', 2] }]);
    const b = coord.hotWrite([{ sql: 'INSERT INTO t (id, v, n) VALUES (1, ?, ?)', params: ['c', 3] }]);
    const c = coord.hotWrite([{ sql: 'INSERT INTO t (id, v, n) VALUES (3, ?, ?)', params: ['d', 4] }]);
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    // All three see ok=false because the batch rolled back as a unit
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    expect(rc.ok).toBe(false);
    // The only row should still be id=1 from the first successful write
    const count = (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('bg write with a small workload runs as a single chunk (no yielding)', async () => {
    const stmts = Array.from({ length: 5 }, (_, i) => ({
      sql: 'INSERT INTO t (v, n) VALUES (?, ?)',
      params: [`bg${i}`, i],
    }));
    const r = await coord.bgWrite(stmts);
    expect(r.ok).toBe(true);
    expect(r.chunksRun).toBe(1);
    expect(r.totalStmts).toBe(5);
  });

  it('bg write with a large workload chunks adaptively', async () => {
    const stmts = Array.from({ length: 200 }, (_, i) => ({
      sql: 'INSERT INTO t (v, n) VALUES (?, ?)',
      params: [`bg${i}`, i],
    }));
    const r = await coord.bgWrite(stmts);
    expect(r.ok).toBe(true);
    expect(r.chunksRun).toBeGreaterThan(1);
    expect(r.totalStmts).toBe(200);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
    expect(count).toBe(200);
  });

  it('honours pre-chunked input', async () => {
    const chunks = [
      [{ sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: ['a', 1] }],
      [{ sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: ['b', 2] }],
      [{ sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: ['c', 3] }],
    ];
    const r = await coord.bgWrite(chunks);
    expect(r.ok).toBe(true);
    expect(r.chunksRun).toBe(3);
  });

  it('interleaves hot writes between bg chunks', async () => {
    // Start a long bg op (50 inserts, will chunk)
    const bgPromise = coord.bgWrite(
      Array.from({ length: 50 }, (_, i) => ({
        sql: 'INSERT INTO t (v, n) VALUES (?, ?)',
        params: [`bg${i}`, i],
      })),
    );
    // Fire some hot writes while bg is running
    const hotResults = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        coord.hotWrite([{ sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: [`hot${i}`, i + 1000] }]),
      ),
    );
    const bgResult = await bgPromise;
    expect(bgResult.ok).toBe(true);
    expect(hotResults.every(r => r.ok)).toBe(true);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
    expect(count).toBe(55);
  });

  it('rejects writes when backpressure threshold is exceeded', async () => {
    const tightCoord = new WriteCoordinator(db, { maxQueueDepth: 5, maxBatch: 1, maxBatchWindowMs: 100 });
    tightCoord.start();
    // Fire 10 writes against a max-depth-5 coordinator with slow batching.
    // Some will land in the queue, others will reject with QueueFullError.
    const promises: Promise<unknown>[] = [];
    let rejections = 0;
    for (let i = 0; i < 10; i++) {
      promises.push(
        tightCoord.hotWrite([{ sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: [`bp${i}`, i] }])
          .catch(e => {
            if (e instanceof QueueFullError) rejections++;
            else throw e;
          }),
      );
    }
    await Promise.all(promises);
    await tightCoord.stop();
    expect(rejections).toBeGreaterThan(0);
  });

  it('read bypass returns committed rows', async () => {
    await coord.hotWrite([{ sql: 'INSERT INTO t (v, n) VALUES (?, ?)', params: ['readtest', 99] }]);
    const rows = coord.read<{ v: string; n: number }>('SELECT v, n FROM t WHERE v = ?', ['readtest']);
    expect(rows).toHaveLength(1);
    expect(rows[0].n).toBe(99);
  });

  it('stats reports queue depth and EMA values', async () => {
    const s = coord.stats();
    expect(s).toHaveProperty('hotDepth');
    expect(s).toHaveProperty('bgDepth');
    expect(s).toHaveProperty('emaHotMsPerStmt');
    expect(s).toHaveProperty('emaBgMsPerStmt');
  });
});
