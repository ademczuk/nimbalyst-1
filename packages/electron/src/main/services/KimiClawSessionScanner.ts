/**
 * KimiClaw Session Scanner
 *
 * Scans KCS for past swarm sessions that can be imported into Nimbalyst.
 * GET /api/v2/swarms with pagination.
 */

export interface KimiClawSwarmRecord {
  swarm_id: string;
  status: string;
  created_at: string;
  task: string;
  deliverable?: string;
  agents_total: number;
  agents_completed: number;
  agents_failed: number;
}

export interface KimiClawScanResult {
  swarms: KimiClawSwarmRecord[];
  total: number;
}

/**
 * Scan KCS for importable swarms.
 *
 * @param endpoint  KCS endpoint URL (e.g. 'http://127.0.0.1:9643')
 * @param auth      Auth config for KCS
 * @param limit     Max swarms to return
 * @param offset    Pagination offset
 */
export async function scanKimiClawSessions(
  endpoint: string,
  auth: { mode: 'cookie' | 'bearer'; username?: string; password?: string; bearerToken?: string },
  limit: number = 50,
  offset: number = 0,
): Promise<KimiClawScanResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.mode === 'bearer' && auth.bearerToken) {
    headers['Authorization'] = `Bearer ${auth.bearerToken}`;
  }

  const url = `${endpoint}/api/v2/swarms?limit=${limit}&offset=${offset}`;

  try {
    const fetch = (await import('node-fetch')).default;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      console.error('[KIMICLAW-SCANNER] HTTP error:', r.status, await r.text());
      return { swarms: [], total: 0 };
    }
    const body = (await r.json()) as Record<string, unknown>;
    const swarms = Array.isArray(body.swarms) ? (body.swarms as KimiClawSwarmRecord[]) : [];
    const total = typeof body.total === 'number' ? body.total : swarms.length;
    return { swarms, total };
  } catch (error) {
    console.error('[KIMICLAW-SCANNER] Failed to scan sessions:', error);
    return { swarms: [], total: 0 };
  }
}
