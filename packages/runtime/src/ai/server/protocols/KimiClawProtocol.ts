/**
 * KimiClaw Protocol Adapter
 *
 * Communicates with KimiClawSwarm (KCS) — a local Flask HTTP server
 * in a Docker container on 127.0.0.1:9643.
 *
 * Transport: HTTP + SSE
 * Auth: Flask session cookie (admin/admin) OR Bearer token (ak_<hex>)
 *
 * Each user message dispatches a swarm via POST /api/v2/swarm,
 * then streams events via GET /api/v2/swarm/<id>/events (SSE).
 */

import { randomUUID } from 'crypto';
import type { ChatAttachment } from '../types';
import {
  AgentProtocol,
  ProtocolSession,
  SessionOptions,
  ProtocolMessage,
  ProtocolEvent,
  ProtocolEventType,
  ToolResult,
} from './ProtocolInterface';

// ---------------------------------------------------------------------------
// Raw event types from KCS SSE stream
// ---------------------------------------------------------------------------

export interface RawKimiClawEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface KimiClawSwarmOptions {
  persona_mode?: boolean;
  max_agents?: number;
  max_steps?: number;
  max_parallel?: number;
}

export interface KimiClawSessionData {
  endpoint: string;
  authMode: 'cookie' | 'bearer';
  username?: string;
  password?: string;
  bearerToken?: string;
  swarmDefaults: KimiClawSwarmOptions;
}

// ---------------------------------------------------------------------------
// Transport interface + HTTP implementation
// ---------------------------------------------------------------------------

export interface KimiClawTransport {
  open(options: SessionOptions): Promise<void>;
  close(): Promise<void>;
  dispatchSwarm(task: string, swarmOpts: KimiClawSwarmOptions): Promise<{ swarmId: string }>;
  streamEvents(swarmId: string, signal: AbortSignal): AsyncIterable<RawKimiClawEvent>;
  cancelSwarm(swarmId: string, reason: string): Promise<void>;
  getSnapshot(swarmId: string): Promise<Record<string, unknown>>;
  getAgents(swarmId: string): Promise<Record<string, unknown>>;
  getArtifact(swarmId: string, name: string): Promise<Buffer>;
  healthCheck(): Promise<boolean>;
}

export class KimiClawHttpTransport implements KimiClawTransport {
  private cookie: string | null = null;

  constructor(
    private endpoint: string,
    private auth: {
      mode: 'cookie' | 'bearer';
      username?: string;
      password?: string;
      bearerToken?: string;
    },
  ) {}

  async open(_options: SessionOptions): Promise<void> {
    if (this.auth.mode === 'cookie') {
      await this.login();
    }
  }

  async close(): Promise<void> {
    this.cookie = null;
  }

  private async login(): Promise<void> {
    const r = await this.fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.auth.username || 'admin',
        password: this.auth.password || 'admin',
      }),
    });
    if (!r.ok) throw new KimiClawError(`login failed: ${r.status} ${await r.text()}`);
    // Extract cookie from Set-Cookie header
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
  }

  async dispatchSwarm(task: string, swarmOpts: KimiClawSwarmOptions): Promise<{ swarmId: string }> {
    const r = await this.fetch('/api/v2/swarm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, options: swarmOpts }),
    });
    if (!r.ok) throw new KimiClawError(`dispatch failed: ${r.status} ${await r.text()}`);
    const body = await r.json();
    return { swarmId: body.swarm_id as string };
  }

  async *streamEvents(swarmId: string, signal: AbortSignal): AsyncIterable<RawKimiClawEvent> {
    const r = await this.fetch(`/api/v2/swarm/${swarmId}/events`, { signal });
    if (!r.ok) throw new KimiClawError(`events failed: ${r.status}`);
    if (!r.body) return;

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) break;

        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          if (frame.startsWith(':')) continue; // keepalive

          const lines = frame.split('\n');
          const evType = lines.find(l => l.startsWith('event: '))?.slice(7);
          const dataLine = lines.find(l => l.startsWith('data: '))?.slice(6);
          if (!evType || !dataLine) continue;

          try {
            yield { type: evType, data: JSON.parse(dataLine) };
          } catch {
            // skip malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async cancelSwarm(swarmId: string, reason: string): Promise<void> {
    const r = await this.fetch(`/api/v2/swarm/${swarmId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!r.ok) throw new KimiClawError(`cancel failed: ${r.status}`);
  }

  async getSnapshot(swarmId: string): Promise<Record<string, unknown>> {
    const r = await this.fetch(`/api/v2/swarm/${swarmId}`);
    if (!r.ok) throw new KimiClawError(`snapshot failed: ${r.status}`);
    return r.json();
  }

  async getAgents(swarmId: string): Promise<Record<string, unknown>> {
    const r = await this.fetch(`/api/v2/swarm/${swarmId}/agents`);
    if (!r.ok) throw new KimiClawError(`agents failed: ${r.status}`);
    return r.json();
  }

  async getArtifact(swarmId: string, name: string): Promise<Buffer> {
    const r = await this.fetch(`/api/v2/swarm/${swarmId}/artifact/${name}`);
    if (!r.ok) throw new KimiClawError(`artifact failed: ${r.status}`);
    const blob = await r.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const r = await this.fetch('/api/auth-check');
      return r.status === 200 || r.status === 401; // 401 means engine is alive
    } catch {
      return false;
    }
  }

  private async fetch(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<Response> {
    const url = `${this.endpoint}${path}`;
    const headers: Record<string, string> = {};

    if (this.auth.mode === 'bearer' && this.auth.bearerToken) {
      headers['Authorization'] = `Bearer ${this.auth.bearerToken}`;
    } else if (this.auth.mode === 'cookie' && this.cookie) {
      headers['Cookie'] = this.cookie;
    }

    if (init?.headers) {
      const initHeaders = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(initHeaders)) {
        headers[k] = v;
      }
    }

    return fetch(url, { ...init, headers });
  }
}

// ---------------------------------------------------------------------------
// KimiClaw error
// ---------------------------------------------------------------------------

export class KimiClawError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KimiClawError';
  }
}

// ---------------------------------------------------------------------------
// Event parser: KCS SSE event -> nimbalyst canonical events
// ---------------------------------------------------------------------------

const CANONICAL_EVENT_OVERRIDES: Partial<Record<string, ProtocolEventType>> = {
  // Core mapping overrides - most events default to 'raw_event'
};

export function parseSwarmEvent(raw: RawKimiClawEvent): ProtocolEvent[] {
  const events: ProtocolEvent[] = [];

  // Always emit raw_event for persistence/audit
  events.push({
    type: 'raw_event',
    metadata: { rawEvent: raw },
  });

  // Map known event types to canonical events
  switch (raw.type) {
    case 'swarm.created':
      events.push({
        type: 'text',
        content: `Swarm ${raw.data.swarm_id} created`,
        metadata: { providerSessionId: raw.data.swarm_id },
      });
      break;

    case 'coordinate.started':
      events.push({
        type: 'text',
        content: 'Coordinating swarm...',
        metadata: { swarmId: raw.data.swarm_id },
      });
      break;

    case 'decompose.started':
      events.push({
        type: 'tool_call',
        toolCall: {
          name: 'decompose_task',
          arguments: { task: raw.data.task },
        },
        metadata: { swarmId: raw.data.swarm_id },
      });
      break;

    case 'decompose.completed':
      events.push({
        type: 'tool_result',
        toolResult: {
          name: 'decompose_task',
          result: { subtaskCount: raw.data.subtask_count, subtasks: raw.data.subtasks },
        },
        metadata: { swarmId: raw.data.swarm_id },
      });
      break;

    case 'decompose.synthetic':
      events.push({
        type: 'tool_result',
        toolResult: {
          name: 'decompose_task',
          result: { synthetic: true, reason: raw.data.reason },
        },
        metadata: { swarmId: raw.data.swarm_id },
      });
      break;

    case 'spawn.completed':
      events.push({
        type: 'tool_call',
        toolCall: {
          name: 'agent_spawn',
          arguments: { agents: raw.data.agents },
        },
        metadata: {
          swarmId: raw.data.swarm_id,
          agents: raw.data.agents,
        },
      });
      break;

    case 'wave.created':
    case 'wave.started':
    case 'wave.completed':
      events.push({
        type: 'text',
        content: `Wave ${raw.data.wave_number || ''} ${raw.type.split('.')[1]}`,
        metadata: {
          waveNumber: raw.data.wave_number,
          swarmId: raw.data.swarm_id,
        },
      });
      break;

    case 'agent.started':
      events.push({
        type: 'tool_call',
        toolCall: {
          name: 'agent_run',
          arguments: { agent: raw.data.name, role: raw.data.role },
        },
        metadata: {
          agentId: raw.data.agent_id,
          wave: raw.data.wave,
        },
      });
      break;

    case 'agent.action':
      events.push({
        type: 'tool_call',
        toolCall: {
          name: (raw.data.tool_name as string) || 'agent_action',
          arguments: (raw.data.args as Record<string, unknown>) || {},
        },
        metadata: {
          agentId: raw.data.agent_id,
          action: raw.data.action,
        },
      });
      break;

    case 'agent.activity_changed':
      events.push({
        type: 'text',
        content: `[Agent ${(raw.data.agent_id as string).slice(0, 8)}] Activity: ${raw.data.activity}`,
        metadata: {
          agentId: raw.data.agent_id,
          activity: raw.data.activity,
        },
      });
      break;

    case 'agent.phase_changed':
      events.push({
        type: 'text',
        content: `[Agent ${(raw.data.agent_id as string).slice(0, 8)}] Phase: ${raw.data.phase}`,
        metadata: {
          agentId: raw.data.agent_id,
          phase: raw.data.phase,
        },
      });
      break;

    case 'agent.completed':
      events.push({
        type: 'tool_result',
        toolResult: {
          name: 'agent_run',
          result: {
            output: raw.data.output,
            synthetic_output_used: raw.data.synthetic_output_used,
            duration_ms: raw.data.duration_ms,
          },
        },
        metadata: {
          agentId: raw.data.agent_id,
          synthetic: raw.data.synthetic_output_used,
        },
      });
      break;

    case 'agent.failed':
      events.push({
        type: 'error',
        error: `Agent ${raw.data.agent_id} failed: ${raw.data.error}`,
        metadata: { agentId: raw.data.agent_id },
      });
      break;

    case 'agent.degraded':
      events.push({
        type: 'text',
        content: `[Agent ${(raw.data.agent_id as string).slice(0, 8)}] Degraded (tier ${raw.data.tier}): ${raw.data.reason}`,
        metadata: {
          agentId: raw.data.agent_id,
          tier: raw.data.tier,
          reason: raw.data.reason,
        },
      });
      break;

    case 'brain.tier':
      events.push({
        type: 'text',
        content: `[Agent ${(raw.data.agent_id as string).slice(0, 8)}] Using tier ${raw.data.tier}`,
        metadata: {
          agentId: raw.data.agent_id,
          tier: raw.data.tier,
        },
      });
      break;

    case 'budget.update':
      events.push({
        type: 'text',
        content: `Budget: ${raw.data.consumed}/${raw.data.total} steps`,
        metadata: {
          stepsConsumed: raw.data.consumed,
          stepsRemaining: raw.data.remaining,
        },
      });
      break;

    case 'budget.exhausted':
      events.push({
        type: 'error',
        error: `Budget exhausted: ${raw.data.reason}`,
        metadata: {},
      });
      break;

    case 'orchestrator.plan_summary':
      events.push({
        type: 'text',
        content: raw.data.summary as string,
        metadata: { kind: 'plan_summary' },
      });
      break;

    case 'orchestrator.intermediate_synthesis':
      events.push({
        type: 'text',
        content: (raw.data.text as string) || String(raw.data),
        metadata: { kind: 'intermediate_synthesis' },
      });
      break;

    case 'orchestrator.deliverable':
      // Deliverable from stream - mark as intermediate, final comes from snapshot
      events.push({
        type: 'text',
        content: typeof raw.data.deliverable === 'string'
          ? raw.data.deliverable
          : JSON.stringify(raw.data.deliverable),
        metadata: { kind: 'deliverable', final: false },
      });
      break;

    case 'synthesize.completed':
      events.push({
        type: 'text',
        content: typeof raw.data.result === 'string'
          ? raw.data.result
          : JSON.stringify(raw.data.result),
        metadata: { kind: 'synthesis' },
      });
      break;

    case 'coordinate.completed':
    case 'coordinate.cancelled':
      events.push({
        type: 'complete',
        metadata: {
          swarmId: raw.data.swarm_id,
          cancelled: raw.type === 'coordinate.cancelled',
          reason: raw.data.reason,
        },
      });
      break;

    case 'coordinate.error':
      events.push({
        type: 'error',
        error: `Coordinate error: ${raw.data.error}`,
        metadata: { swarmId: raw.data.swarm_id },
      });
      break;

    case 'swarm.cancelled':
    case 'swarm.reaped':
      events.push({
        type: 'error',
        error: `Swarm ${raw.type.split('.')[1]}: ${raw.data.reason || 'unknown'}`,
        metadata: { swarmId: raw.data.swarm_id },
      });
      break;

    case 'error':
      events.push({
        type: 'error',
        error: (raw.data.error as string) || 'Unknown error',
        metadata: {},
      });
      break;

    default:
      // Default pass-through: raw_event only (already emitted above)
      break;
  }

  // Attach agentId to metadata on all events that have it
  if (raw.data.agent_id) {
    for (const ev of events) {
      if (!ev.metadata) ev.metadata = {};
      (ev.metadata as Record<string, unknown>).agentId = raw.data.agent_id;
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Protocol implementation
// ---------------------------------------------------------------------------

export class KimiClawProtocol implements AgentProtocol {
  readonly platform = 'kimiclaw';

  constructor(private transport: KimiClawTransport) {}

  async createSession(options: SessionOptions): Promise<ProtocolSession> {
    await this.transport.open(options);
    return { id: randomUUID(), platform: this.platform, raw: { options } };
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    await this.transport.open(options);
    return { id: randomUUID(), platform: this.platform, raw: { options, resumedFrom: sessionId } };
  }

  async forkSession(sessionId: string, options: SessionOptions): Promise<ProtocolSession> {
    // KCS does not support forking - create a new session
    return this.createSession(options);
  }

  async *sendMessage(
    session: ProtocolSession,
    message: ProtocolMessage,
  ): AsyncIterable<ProtocolEvent> {
    const sessionData = session.raw?.options as KimiClawSessionData | undefined;
    const swarmOpts: KimiClawSwarmOptions = sessionData?.swarmDefaults || {};

    const { swarmId } = await this.transport.dispatchSwarm(message.content, swarmOpts);

    yield {
      type: 'text',
      content: `Swarm ${swarmId} dispatched`,
      metadata: { providerSessionId: swarmId },
    };

    const ac = new AbortController();
    let terminalReached = false;

    try {
      for await (const raw of this.transport.streamEvents(swarmId, ac.signal)) {
        // Emit mapped canonical events
        for (const ev of parseSwarmEvent(raw)) {
          yield ev;
        }

        if (
          raw.type === 'coordinate.completed' ||
          raw.type === 'coordinate.error' ||
          raw.type === 'coordinate.cancelled'
        ) {
          terminalReached = true;
          break;
        }
      }

      // After SSE ends, fetch final deliverable from snapshot
      if (!terminalReached) {
        try {
          const snap = await this.transport.getSnapshot(swarmId);
          const deliverable = snap.deliverable || snap.result;
          if (deliverable) {
            const text = typeof deliverable === 'string' ? deliverable : JSON.stringify(deliverable);
            yield {
              type: 'text',
              content: text,
              metadata: { final: true },
            };
          }
        } catch {
          // Snapshot may not be available if swarm was cancelled
        }
      }

      yield { type: 'complete', metadata: { swarmId } };
    } finally {
      ac.abort();
    }
  }

  abortSession(_session: ProtocolSession): void {
    // Transport-level abort handled by the sendMessage AbortController
  }

  cleanupSession(_session: ProtocolSession): void {
    // Nothing to clean up for HTTP-only transport
  }
}
