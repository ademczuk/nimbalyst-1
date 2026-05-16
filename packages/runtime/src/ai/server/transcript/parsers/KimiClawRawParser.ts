/**
 * KimiClawRawParser -- maps KCS SSE events to nimbalyst canonical events.
 *
 * KCS (KimiClawSwarm) uses a single-tier orchestration through Moonshot AI.
 * The HTTP bridge (api_server.py) synthesizes SSE events from KCS status.
 *
 * Events emitted by the bridge:
 *   orchestrator.started, swarm.configured,
 *   agent.started, agent.phase_changed, agent.completed, agent.failed,
 *   orchestrator.deliverable, orchestrator.error, orchestrator.failed,
 *   coordinate.completed, coordinate.cancelled
 *
 * Stateless across calls. Per-batch dedup state is internal to each
 * parser instance created per transformMessages() batch.
 */

import type { RawMessage } from '../TranscriptTransformer';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

export class KimiClawRawParser implements IRawMessageParser {
  private processedEventIds = new Set<string>();

  async parseMessage(
    msg: RawMessage,
    _context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    const events: CanonicalEventDescriptor[] = [];

    const eventId = msg.id || `${msg.createdAt.getTime()}-${msg.source}`;
    if (this.processedEventIds.has(String(eventId))) return events;
    this.processedEventIds.add(String(eventId));

    // The raw content is a KCS SSE event { type, data }
    let raw: { type: string; data: Record<string, unknown> } | null = null;
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed.type === 'string') {
        raw = parsed;
      }
    } catch {
      return events;
    }
    if (!raw) return events;

    const d = raw.data;

    switch (raw.type) {
      // -------------------------------------------------------------------
      // Orchestrator lifecycle
      // -------------------------------------------------------------------

      case 'orchestrator.started':
        events.push({
          type: 'system_message',
          text: `Swarm ${(d.swarm_id as string)?.slice(0, 12)} started`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'swarm.configured':
        events.push({
          type: 'system_message',
          text: `Swarm configured — max ${d.max_agents} agents, ${d.max_steps} steps${d.parallel ? ' (parallel)' : ''}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'orchestrator.deliverable': {
        const deliverable = typeof d.content === 'string' ? d.content : JSON.stringify(d.content);
        events.push({
          type: 'assistant_message',
          text: deliverable,
          createdAt: new Date(),
        });
        break;
      }

      case 'orchestrator.error':
        events.push({
          type: 'system_message',
          text: `Swarm error: ${d.error}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;

      case 'orchestrator.failed':
        events.push({
          type: 'system_message',
          text: `Swarm failed: ${d.error}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;

      // -------------------------------------------------------------------
      // Agent lifecycle — lumpy-streaming placeholders (Fix B)
      // KCS emits full blobs not tokens; these placeholders keep UX alive.
      // -------------------------------------------------------------------

      case 'agent.started': {
        const agentName = (d.name as string) || (d.agent_id as string)?.slice(0, 8);
        events.push({
          type: 'system_message',
          text: `[Agent ${agentName}] Starting...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      case 'agent.phase_changed': {
        const agentName2 = (d.name as string) || (d.agent_id as string)?.slice(0, 8);
        events.push({
          type: 'system_message',
          text: `[Agent ${agentName2}] ${d.phase}...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      case 'agent.completed': {
        const output = typeof d.output === 'string' ? d.output : JSON.stringify(d.output);
        const synthetic = d.synthetic_output_used === true;
        const tier = typeof d.tier === 'number' ? d.tier : undefined;
        const agentName = (d.name as string) || (d.agent_id as string)?.slice(0, 8) || 'agent';
        const domain = (d.domain as string) || 'general';

        // Per-agent header rendered as a status system_message so the
        // transcript visually divides between agents. The renderer
        // styles systemType:'status' as a chip / divider, giving each
        // agent its own clearly-bounded section without needing a full
        // collapsible-card component. Domain provides the persona hint
        // (coding / research / writing / analysis / design); an icon
        // glyph encodes the persona visually without depending on
        // theme tokens.
        const DOMAIN_GLYPHS: Record<string, string> = {
          coding: '⚙',
          research: '🔍',
          writing: '✎',
          analysis: '◇',
          design: '◈',
        };
        const glyph = DOMAIN_GLYPHS[domain] || '●';

        // Tier badge: synthetic stays loud because it signals a real
        // failure mode (no LLM behind the output). Tiers 2-4 are
        // labeled compactly so power users can see fallover behaviour
        // without overwhelming the visual rhythm.
        let tierLabel = '';
        if (synthetic) {
          tierLabel = ' · ⚠ SYNTH-tier-5 (no LLM)';
        } else if (tier !== undefined && tier > 1) {
          const tierName = { 2: 'codex', 3: 'claude-cli', 4: 'qwq' }[tier] || `tier-${tier}`;
          tierLabel = ` · via ${tierName}`;
        } else if (tier === 1) {
          tierLabel = ' · kimi';
        }

        events.push({
          type: 'system_message',
          text: `${glyph} ${agentName} · ${domain}${tierLabel}`,
          systemType: 'status',
          createdAt: new Date(),
        });

        // For SYNTHETIC outputs, keep the inline tag in the body too —
        // the divider could scroll off-screen above a long output, and
        // users absolutely should not mistake synthetic content for
        // a real LLM answer.
        const prefix = synthetic
          ? '[SYNTH tier-5 fallback - no real LLM]\n\n'
          : '';

        events.push({
          type: 'assistant_message',
          text: prefix + output,
          createdAt: new Date(),
        });
        break;
      }

      case 'agent.failed':
        events.push({
          type: 'system_message',
          text: `Agent ${(d.agent_id as string)?.slice(0, 8)} failed: ${d.error}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;

      // -------------------------------------------------------------------
      // Coordination / terminal events
      // -------------------------------------------------------------------

      case 'coordinate.completed':
        events.push({
          type: 'turn_ended',
          contextFill: {
            inputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 0,
            totalContextTokens: 0,
          },
          contextWindow: 0,
          cumulativeUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
            webSearchRequests: 0,
          },
          createdAt: new Date(),
        });
        break;

      case 'coordinate.cancelled':
        events.push({
          type: 'system_message',
          text: `Swarm cancelled: ${d.reason || 'user requested'}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'coordinate.error':
        events.push({
          type: 'system_message',
          text: `Swarm error: ${d.error}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;

      // -------------------------------------------------------------------
      // Pass-through — bridge does not emit these, but handle defensively
      // -------------------------------------------------------------------

      case 'agent.activity_changed':
      case 'budget.update':
      case 'decompose.started':
        // Silently ignore - bridge doesn't emit these
        break;

      // -------------------------------------------------------------------
      // Wave coordination - the orchestrator now emits these around the
      // parallel-execution wave loop so the operator sees the wave
      // structure of multi-agent swarms (wave 1 of 3, 4 agents starting).
      // -------------------------------------------------------------------

      case 'wave.started': {
        const num = (d.wave_number as number) ?? 0;
        const total = (d.wave_total as number) ?? 0;
        const count = (d.agent_count as number) ?? 0;
        events.push({
          type: 'system_message',
          text: `[Wave ${num + 1}/${total}] starting with ${count} agent${count === 1 ? '' : 's'}...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      case 'wave.completed': {
        const num = (d.wave_number as number) ?? 0;
        const total = (d.wave_total as number) ?? 0;
        const succeeded = (d.succeeded as number) ?? 0;
        const failed = (d.failed as number) ?? 0;
        const elapsed = (d.elapsed_s as number) ?? 0;
        const failStr = failed > 0 ? `, ${failed} failed` : '';
        events.push({
          type: 'system_message',
          text: `[Wave ${num + 1}/${total}] completed in ${elapsed.toFixed(1)}s (${succeeded} succeeded${failStr})`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // -------------------------------------------------------------------
      // Cascade tier heartbeat - emitted every 5s while a tier call is
      // in flight so the operator sees continuous progress instead of
      // silent windows during 20-60s LLM calls.
      // -------------------------------------------------------------------

      case 'cascade.tier_heartbeat': {
        const name = (d.name as string) || `tier-${d.tier}`;
        const elapsed = (d.elapsed_s as number) ?? 0;
        events.push({
          type: 'system_message',
          text: `[Cascade] ${name} still working... ${elapsed.toFixed(0)}s elapsed`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // -------------------------------------------------------------------
      // Plan visibility - emit per-subtask cards so the user sees the
      // decomposition before agents start running. KCS-side bridge emits
      // task.created per subtask between decompose and spawn.
      // -------------------------------------------------------------------

      case 'decompose.completed': {
        const subCount = (d.subtask_count as number) ?? 0;
        const estSteps = (d.estimated_steps as number) ?? 0;
        if (subCount > 0) {
          events.push({
            type: 'system_message',
            text: `[Plan] Decomposed into ${subCount} subtask${subCount === 1 ? '' : 's'} (~${estSteps} steps)`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      case 'task.created': {
        // One subtask in the plan. Surface as a structured system_message
        // so the transcript shows the plan unfolding. When nimbalyst's
        // session-to-kanban linker lands, this same event can be promoted
        // to a real task card without touching this parser.
        const taskId = (d.task_id as string) || '?';
        const description = (d.description as string) || '(no description)';
        const domain = (d.domain as string) || 'analysis';
        const estSteps = (d.estimated_steps as number) ?? 0;
        const deps = Array.isArray(d.dependencies) ? (d.dependencies as string[]) : [];
        const depStr = deps.length > 0 ? ` after ${deps.join(', ')}` : '';
        events.push({
          type: 'system_message',
          text: `[Task ${taskId}] ${domain}: ${description} (~${estSteps} steps${depStr})`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      case 'spawn.completed': {
        const count = (d.agent_count as number) ?? 0;
        if (count > 0) {
          events.push({
            type: 'system_message',
            text: `[Spawn] ${count} agent${count === 1 ? '' : 's'} ready, executing...`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // -------------------------------------------------------------------
      // Cascade-tier progress events - emitted by KCS cascade.py per
      // tier attempt so the operator sees live progress during the long
      // decompose call. Replaces the silent "Thinking..." pattern with
      // visible "trying codex... codex timeout, trying claude_cli...
      // claude_cli succeeded in 23s" feedback.
      // -------------------------------------------------------------------

      case 'cascade.tier_attempt': {
        const name = (d.name as string) || `tier-${d.tier}`;
        events.push({
          type: 'system_message',
          text: `[Cascade] trying ${name}...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      case 'cascade.tier_succeeded': {
        const name = (d.name as string) || `tier-${d.tier}`;
        const elapsed = (d.elapsed_s as number) ?? 0;
        const len = (d.content_len as number) ?? 0;
        events.push({
          type: 'system_message',
          text: `[Cascade] ${name} succeeded in ${elapsed.toFixed(1)}s (${len} chars)`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      case 'cascade.tier_failed': {
        const name = (d.name as string) || `tier-${d.tier}`;
        const elapsed = (d.elapsed_s as number) ?? 0;
        const reason = (d.reason as string) || 'unknown';
        events.push({
          type: 'system_message',
          text: `[Cascade] ${name} failed after ${elapsed.toFixed(1)}s (${reason}), trying next tier...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // Unknown event types - no-op (extensibility hook for future KCS versions)
      default:
        break;
    }

    return events;
  }
}
