// HOL bench v5 - honest fixes per Codex adversarial review:
//   1. EQUAL pacing: both bs3 backends use the same async wrapping for hot writes
//      so we're not measuring "sleep(0) overhead vs no sleep".
//   2. Slow ops are HONESTLY async on BOTH bs3 backends (chunk + yield even on naive)
//      so the "during slow op" bucket gets real samples on both sides.
//   3. The COMPARISON is no longer naive-blocking vs coord-chunking. It's:
//        BG_DIRECT: dev manually chunks the slow op (yields between chunks)
//        BG_COORD: dev uses coord.bgWrite (coord chunks adaptively)
//      Both yield. The diff is who owns the chunking discipline.
//   4. Burst phase is annotated as "best-case in-process" - the IPC case requires
//      cross-process bench (out of scope for this iteration).
//   5. Vacuum: both bs3 do incremental_vacuum(1000) (one-shot). Coord routes via bgWrite.

import Database from 'better-sqlite3';
import pkg from 'pg';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WriteCoordinator } from './write-coordinator-bench-impl.mjs';

const { Pool } = pkg;
const PG_URL = process.env.PG_URL || 'postgres://postgres:bench@127.0.0.1:15555/nimbalyst_bench';
const HOT_WORKERS = 4;
const PHASE_MS = parseInt(process.env.PHASE_MS || '5000', 10);
const BURST_N = 50;
const SEED_SESSIONS = 1000;
const SEED_MESSAGES = 20000;
const SEED_TRACKERS = 2000;
const CONTENT_SIZE = 1024;

function q(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function content(seed) {
  const buf = [];
  for (let i = 0; i < CONTENT_SIZE; i++) buf.push(String.fromCharCode(33 + ((seed + i) * 7) % 90));
  return buf.join('');
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yieldTick = () => new Promise(r => setImmediate(r));

const SCH_PG = [
  `CREATE TABLE IF NOT EXISTS ai_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, updated_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS ai_agent_messages (id BIGSERIAL PRIMARY KEY, session_id TEXT, content TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS tracker_items (id TEXT PRIMARY KEY, data JSONB)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_session ON ai_agent_messages(session_id, id)`,
];
const SCH_LITE = [
  `CREATE TABLE IF NOT EXISTS ai_sessions (id TEXT PRIMARY KEY, workspace_id TEXT, updated_at INTEGER DEFAULT (unixepoch()*1000))`,
  `CREATE TABLE IF NOT EXISTS ai_agent_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, content TEXT, created_at INTEGER DEFAULT (unixepoch()*1000))`,
  `CREATE TABLE IF NOT EXISTS tracker_items (id TEXT PRIMARY KEY, data TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_session ON ai_agent_messages(session_id, id)`,
];

// ============ Bs3 Direct (no coord; dev manually chunks slow ops) ============
class Bs3Direct {
  name = 'better-sqlite3+WAL (direct, dev-chunked)';
  isSync = true; isPg = false;
  init() {
    for (const f of ['./bs3a.db', './bs3a.db-wal', './bs3a.db-shm']) fs.rmSync(f, { force: true });
    this.db = new Database('./bs3a.db');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('auto_vacuum = INCREMENTAL');
    for (const s of SCH_LITE) this.db.exec(s);
    this.stmtHotInsert = this.db.prepare("INSERT INTO ai_agent_messages (session_id, content) VALUES (?, ?)");
    this.stmtHotUpdate = this.db.prepare("UPDATE ai_sessions SET updated_at = ? WHERE id = ?");
    this.stmtReadMsg = this.db.prepare("SELECT id, content FROM ai_agent_messages WHERE session_id = ? LIMIT 10");
  }
  seed() {
    const ins = (sql) => this.db.prepare(sql);
    const tx = this.db.transaction(() => {
      for (let i = 0; i < SEED_SESSIONS; i++) ins("INSERT INTO ai_sessions (id, workspace_id) VALUES (?, 'bench')").run(`s${i}`);
      const m = ins("INSERT INTO ai_agent_messages (session_id, content) VALUES (?, ?)");
      for (let i = 0; i < SEED_MESSAGES; i++) m.run(`s${i % SEED_SESSIONS}`, content(i));
      const t = ins("INSERT INTO tracker_items (id, data) VALUES (?, ?)");
      for (let i = 0; i < SEED_TRACKERS; i++) t.run(`t${i}`, JSON.stringify({ title: `T${i}`, status: 'open' }));
    });
    tx();
  }
  // Hot path: sync call wrapped to look async (no internal sleep added).
  async hotWrite(seed) {
    const sid = `s${seed % SEED_SESSIONS}`;
    const tx = this.db.transaction(() => {
      this.stmtHotInsert.run(sid, content(seed));
      this.stmtHotUpdate.run(Date.now(), sid);
    });
    tx();
  }
  hotRead(seed) {
    const sid = `s${seed % SEED_SESSIONS}`;
    return this.stmtReadMsg.all(sid);
  }
  // Slow ops: DEV manually chunks + yields. Same shape as coord's bg lane,
  // just hand-rolled. This is what a careful dev would write following Greg's
  // "continued write coalescing" plan.
  async slowFTS() {
    const rows = this.db.prepare("SELECT id FROM ai_agent_messages").all();
    const stmt = this.db.prepare("UPDATE ai_agent_messages SET content = content || ' ' WHERE id = ?");
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const tx = this.db.transaction((items) => { for (const r of items) stmt.run(r.id); });
      tx(chunk);
      await yieldTick();
    }
    return rows.length;
  }
  async slowJson() {
    const ids = this.db.prepare("SELECT id FROM tracker_items").all();
    const stmt = this.db.prepare("UPDATE tracker_items SET data = json_patch(data, ?) WHERE id = ?");
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const tx = this.db.transaction((items) => { for (const r of items) stmt.run('{"touched":1}', r.id); });
      tx(chunk);
      await yieldTick();
    }
  }
  async slowVacuum() {
    this.db.exec("PRAGMA incremental_vacuum(1000)");
    await yieldTick();
  }
  close() { this.db.close(); }
}

// ============ Bs3 + Coord (coord owns chunking/batching discipline) ============
class Bs3Coord {
  name = 'better-sqlite3+WAL+Coordinator';
  isSync = true; isPg = false;
  init() {
    for (const f of ['./bs3b.db', './bs3b.db-wal', './bs3b.db-shm']) fs.rmSync(f, { force: true });
    this.db = new Database('./bs3b.db');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('auto_vacuum = INCREMENTAL');
    for (const s of SCH_LITE) this.db.exec(s);
    this.stmtReadMsg = this.db.prepare("SELECT id, content FROM ai_agent_messages WHERE session_id = ? LIMIT 10");
    this.coord = new WriteCoordinator(this.db, {
      maxBatch: 50,
      maxBatchWindowMs: 5,
      minWorkMs: 8,
      maxChunkStmts: 500, // larger ceiling - small chunks were overkill in v4
    });
    this.coord.start();
  }
  seed() {
    const ins = (sql) => this.db.prepare(sql);
    const tx = this.db.transaction(() => {
      for (let i = 0; i < SEED_SESSIONS; i++) ins("INSERT INTO ai_sessions (id, workspace_id) VALUES (?, 'bench')").run(`s${i}`);
      const m = ins("INSERT INTO ai_agent_messages (session_id, content) VALUES (?, ?)");
      for (let i = 0; i < SEED_MESSAGES; i++) m.run(`s${i % SEED_SESSIONS}`, content(i));
      const t = ins("INSERT INTO tracker_items (id, data) VALUES (?, ?)");
      for (let i = 0; i < SEED_TRACKERS; i++) t.run(`t${i}`, JSON.stringify({ title: `T${i}`, status: 'open' }));
    });
    tx();
  }
  async hotWrite(seed) {
    const sid = `s${seed % SEED_SESSIONS}`;
    const r = await this.coord.hotWrite([
      { sql: "INSERT INTO ai_agent_messages (session_id, content) VALUES (?, ?)", params: [sid, content(seed)] },
      { sql: "UPDATE ai_sessions SET updated_at = ? WHERE id = ?", params: [Date.now(), sid] },
    ]);
    if (!r.ok) throw r.error;
  }
  hotRead(seed) {
    const sid = `s${seed % SEED_SESSIONS}`;
    return this.stmtReadMsg.all(sid);
  }
  async slowFTS() {
    const rows = this.db.prepare("SELECT id FROM ai_agent_messages").all();
    const work = rows.map(r => ({ sql: "UPDATE ai_agent_messages SET content = content || ' ' WHERE id = ?", params: [r.id] }));
    const r = await this.coord.bgWrite(work);
    if (!r.ok) throw r.error;
    return work.length;
  }
  async slowJson() {
    const ids = this.db.prepare("SELECT id FROM tracker_items").all();
    const work = ids.map(r => ({ sql: "UPDATE tracker_items SET data = json_patch(data, ?) WHERE id = ?", params: ['{"touched":1}', r.id] }));
    const r = await this.coord.bgWrite(work);
    if (!r.ok) throw r.error;
  }
  async slowVacuum() {
    const r = await this.coord.bgWrite([{ sql: "PRAGMA incremental_vacuum(1000)", params: [] }]);
    if (!r.ok) throw r.error;
  }
  async close() { await this.coord.stop(); this.db.close(); }
}

// ============ Postgres ============
class PG {
  name = 'postgres';
  isSync = false; isPg = true;
  async init() {
    this.pool = new Pool({ connectionString: PG_URL, max: HOT_WORKERS + 4 });
    const c = await this.pool.connect();
    try {
      for (const s of SCH_PG) await c.query(s);
      await c.query('TRUNCATE ai_agent_messages, ai_sessions, tracker_items RESTART IDENTITY');
    } finally { c.release(); }
    this.workerClients = [];
    for (let i = 0; i < HOT_WORKERS; i++) this.workerClients.push(await this.pool.connect());
    this.readerClient = await this.pool.connect();
  }
  async seed() {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < SEED_SESSIONS; i++) await c.query("INSERT INTO ai_sessions (id, workspace_id) VALUES ($1, 'bench')", [`s${i}`]);
      for (let i = 0; i < SEED_MESSAGES; i++) await c.query("INSERT INTO ai_agent_messages (session_id, content) VALUES ($1, $2)", [`s${i % SEED_SESSIONS}`, content(i)]);
      for (let i = 0; i < SEED_TRACKERS; i++) await c.query("INSERT INTO tracker_items (id, data) VALUES ($1, $2::jsonb)", [`t${i}`, JSON.stringify({ title: `T${i}`, status: 'open' })]);
      await c.query('COMMIT');
    } finally { c.release(); }
  }
  async hotWrite(workerId, seed) {
    const c = this.workerClients[workerId];
    const sid = `s${seed % SEED_SESSIONS}`;
    await c.query('BEGIN');
    try {
      await c.query("INSERT INTO ai_agent_messages (session_id, content) VALUES ($1, $2)", [sid, content(seed)]);
      await c.query("UPDATE ai_sessions SET updated_at = NOW() WHERE id = $1", [sid]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  }
  async hotRead(seed) {
    const sid = `s${seed % SEED_SESSIONS}`;
    return (await this.readerClient.query("SELECT id, content FROM ai_agent_messages WHERE session_id = $1 LIMIT 10", [sid])).rows;
  }
  async slowFTS() {
    const c = await this.pool.connect();
    try { return (await c.query("UPDATE ai_agent_messages SET content = content || ' '")).rowCount; } finally { c.release(); }
  }
  async slowJson() { await this.pool.query("UPDATE tracker_items SET data = jsonb_set(data, '{touched}', '1')"); }
  async slowVacuum() {
    const c = await this.pool.connect();
    try { await c.query('VACUUM ANALYZE ai_agent_messages'); } finally { c.release(); }
  }
  async close() {
    for (const c of this.workerClients) c.release();
    this.readerClient.release();
    await this.pool.end();
  }
}

// ============ Phase runners (uniform pacing) ============
// All hot workers are async functions that loop calling the backend's hotWrite.
// No backend-specific sleep insertion - pacing comes from the backend's own
// hotWrite() return time.

// EVERY iteration of every worker yields one setImmediate macrotask. This is the
// honest minimum to let setTimeout(stop=true) fire and to allow the slow op to
// interleave. The yield itself is microsecond-scale; it does not artificially
// penalize the direct backend. Coord workers already yield implicitly via the
// coord's internal _drainHotBatch (which awaits a setImmediate when batching),
// so an extra explicit yield is a no-op for coord workers. Both backends pay the
// same per-iteration scheduling cost.
async function phaseBaseline(b) {
  const lats = []; let ops = 0; let stop = false;
  setTimeout(() => { stop = true; }, PHASE_MS);
  const start = performance.now();
  const workers = [];
  for (let w = 0; w < HOT_WORKERS; w++) {
    workers.push((async () => {
      let seed = w * 100000;
      while (!stop) {
        const t0 = performance.now();
        try {
          if (b.isPg) await b.hotWrite(w, seed++);
          else await b.hotWrite(seed++);
          lats.push(performance.now() - t0); ops++;
        } catch (e) { lats.push(performance.now() - t0); }
        await yieldTick(); // setImmediate-based macrotask yield, same on both backends
      }
    })());
  }
  await Promise.all(workers);
  const elapsed = (performance.now() - start) / 1000;
  return { ops, opsPerSec: Math.round(ops / elapsed), p50: +q(lats, 0.5).toFixed(2), p99: +q(lats, 0.99).toFixed(2), max: +Math.max(...lats, 0).toFixed(2) };
}

async function phaseHol(b, slowOp, mode = 'write') {
  const duringLats = []; let duringOps = 0;
  const afterLats = []; let afterOps = 0;
  let stop = false; let slowDone = false; let slowMs = null;
  // CRITICAL FIX (Codex finding #1): start workers BEFORE the slow op so they're
  // actively running when slowOp begins. Their first iteration races slowOp's
  // first yield.
  const workers = [];
  for (let w = 0; w < HOT_WORKERS; w++) {
    workers.push((async () => {
      let seed = w * 100000 + 50000;
      while (!stop) {
        const t0 = performance.now();
        const wasDuring = !slowDone;
        try {
          if (mode === 'write') {
            if (b.isPg) await b.hotWrite(w, seed++);
            else await b.hotWrite(seed++);
          } else {
            if (b.isPg) await b.hotRead(seed++);
            else b.hotRead(seed++);
          }
          const dt = performance.now() - t0;
          if (wasDuring) { duringLats.push(dt); duringOps++; }
          else { afterLats.push(dt); afterOps++; }
        } catch (e) {
          const dt = performance.now() - t0;
          if (wasDuring) { duringLats.push(dt); duringOps++; }
          else { afterLats.push(dt); afterOps++; }
        }
        await yieldTick(); // uniform pacing across backends
      }
    })());
  }
  // Give workers a tick to start their loops
  await yieldTick();
  // Now start the slow op
  const slowStart = performance.now();
  await slowOp();
  slowMs = performance.now() - slowStart;
  slowDone = true;
  // Drain window
  await sleep(200);
  stop = true;
  await Promise.all(workers);
  return {
    slowMs: Math.round(slowMs),
    during: { ops: duringOps, p50: +q(duringLats, 0.5).toFixed(2), p99: +q(duringLats, 0.99).toFixed(2), max: +Math.max(...duringLats, 0).toFixed(2) },
    after: { ops: afterOps, p50: +q(afterLats, 0.5).toFixed(2), p99: +q(afterLats, 0.99).toFixed(2), max: +Math.max(...afterLats, 0).toFixed(2) },
  };
}

async function phaseBurst(b) {
  // CAVEAT: in-process burst. Real Codex Meta-Agent case is cross-process via IPC
  // which would have very different latency profile. This measures best-case
  // batching opportunity, not realistic agent contention.
  const lats = [];
  const burstStart = performance.now();
  const writes = [];
  for (let i = 0; i < BURST_N; i++) {
    writes.push((async () => {
      const t0 = performance.now();
      try {
        if (b.isPg) await b.hotWrite(i % HOT_WORKERS, i * 999);
        else await b.hotWrite(i * 999);
        lats.push(performance.now() - t0);
      } catch (e) { lats.push(performance.now() - t0); }
    })());
  }
  await Promise.all(writes);
  return {
    burstSize: BURST_N,
    totalMs: Math.round(performance.now() - burstStart),
    p50: +q(lats, 0.5).toFixed(2), p99: +q(lats, 0.99).toFixed(2), max: +Math.max(...lats, 0).toFixed(2),
    avgPerWrite: +((performance.now() - burstStart) / BURST_N).toFixed(2),
  };
}

async function runBackend(b) {
  console.log(`\n=== ${b.name} ===`);
  const t0 = performance.now();
  if (b.isPg) { await b.init(); await b.seed(); } else { b.init(); b.seed(); }
  console.log(`  ready in ${Math.round(performance.now() - t0)}ms`);
  const out = { backend: b.name, phases: {} };
  out.phases.baseline = await phaseBaseline(b);
  console.log(`  baseline: ${JSON.stringify(out.phases.baseline)}`);
  out.phases.fts_write = await phaseHol(b, () => b.slowFTS(), 'write');
  console.log(`  WRITE during FTS: ${JSON.stringify(out.phases.fts_write)}`);
  out.phases.fts_read = await phaseHol(b, () => b.slowFTS(), 'read');
  console.log(`  READ during FTS: ${JSON.stringify(out.phases.fts_read)}`);
  out.phases.json_write = await phaseHol(b, () => b.slowJson(), 'write');
  console.log(`  WRITE during JSON: ${JSON.stringify(out.phases.json_write)}`);
  out.phases.vacuum_write = await phaseHol(b, () => b.slowVacuum(), 'write');
  console.log(`  WRITE during VACUUM: ${JSON.stringify(out.phases.vacuum_write)}`);
  out.phases.burst = await phaseBurst(b);
  console.log(`  burst: ${JSON.stringify(out.phases.burst)}`);
  if (b.isPg) await b.close(); else await (b.close?.() ?? b.close());
  return out;
}

async function main() {
  const results = [];
  results.push(await runBackend(new Bs3Direct()));
  results.push(await runBackend(new Bs3Coord()));
  results.push(await runBackend(new PG()));
  fs.writeFileSync('./hol-v5-results.json', JSON.stringify(results, null, 2));

  let md = '# HOL bench v5 results (Codex-review fixes applied)\n\n';
  md += `Methodology:\n`;
  md += `- Hot workers use IDENTICAL async pacing across all backends (no sleep(0) penalty)\n`;
  md += `- Slow ops on bs3 backends are ALL chunked + yielding (direct uses hand-rolled chunk loop; coord uses bgWrite). The diff is who owns the discipline.\n`;
  md += `- Workers start BEFORE slow op so during/after classification is honest\n`;
  md += `- VACUUM uses incremental_vacuum(1000) on both bs3 backends\n`;
  md += `- Burst phase is in-process; cross-process IPC case unmeasured.\n\n`;
  md += `Seed: ${SEED_SESSIONS} sessions, ${SEED_MESSAGES} messages, ${SEED_TRACKERS} trackers. Hot workers: ${HOT_WORKERS}. Baseline phase: ${PHASE_MS}ms.\n\n`;

  md += '## Baseline\n\n';
  md += '| Backend | ops/s | p50 | p99 | max |\n|---|---:|---:|---:|---:|\n';
  for (const r of results) {
    const b = r.phases.baseline;
    md += `| ${r.backend} | ${b.opsPerSec} | ${b.p50}ms | ${b.p99}ms | ${b.max}ms |\n`;
  }

  const writeHolPhases = [
    ['fts_write', 'WRITES during FTS-rewrite HOL'],
    ['json_write', 'WRITES during JSON-update HOL'],
    ['vacuum_write', 'WRITES during incremental_vacuum HOL'],
  ];
  for (const [key, title] of writeHolPhases) {
    md += `\n## ${title}\n\n`;
    md += '| Backend | slow-op | during ops | during p50 | during p99 | during max | after ops | after p99 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n';
    for (const r of results) {
      const p = r.phases[key];
      md += `| ${r.backend} | ${p.slowMs}ms | ${p.during.ops} | ${p.during.p50}ms | ${p.during.p99}ms | ${p.during.max}ms | ${p.after.ops} | ${p.after.p99}ms |\n`;
    }
  }

  md += `\n## READS during FTS-rewrite\n\n`;
  md += '| Backend | slow-op | during ops | during p50 | during p99 | after p99 |\n|---|---:|---:|---:|---:|---:|\n';
  for (const r of results) {
    const p = r.phases.fts_read;
    md += `| ${r.backend} | ${p.slowMs}ms | ${p.during.ops} | ${p.during.p50}ms | ${p.during.p99}ms | ${p.after.p99}ms |\n`;
  }

  md += `\n## Multi-writer burst (${BURST_N} concurrent in-process writes)\n\n`;
  md += 'CAVEAT: in-process burst, not cross-process IPC. Real Codex Meta-Agent case requires cross-process bench.\n\n';
  md += '| Backend | total ms | avg/write | p50 | p99 | max |\n|---|---:|---:|---:|---:|---:|\n';
  for (const r of results) {
    const p = r.phases.burst;
    md += `| ${r.backend} | ${p.totalMs} | ${p.avgPerWrite}ms | ${p.p50}ms | ${p.p99}ms | ${p.max}ms |\n`;
  }
  fs.writeFileSync('./hol-v5-results.md', md);
  console.log('\n========= DONE =========\n');
  console.log(md);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
