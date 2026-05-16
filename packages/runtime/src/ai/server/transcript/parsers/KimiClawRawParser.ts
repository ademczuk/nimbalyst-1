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
        // Prefix synthetic-tier-5 fallbacks visibly so the user knows
        // this response did NOT come from a real LLM. The cascade emits
        // this synthetic content when all upstream tiers fail; the user
        // shouldn't trust it as a genuine model answer. Also surface
        // tier 2-4 in a short prefix so power users can see which
        // cascade tier produced each agent's output.
        let prefix = '';
        if (synthetic) {
          prefix = '[SYNTH tier-5 fallback - no real LLM]\n\n';
        } else if (tier !== undefined && tier > 1) {
          const tierName = { 2: 'codex', 3: 'claude-cli', 4: 'qwq' }[tier] || `tier-${tier}`;
          prefix = `[via ${tierName}]\n\n`;
        }
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
      case 'wave.started':
      case 'wave.completed':
      case 'decompose.started':
        // Silently ignore - bridge doesn't emit these
        break;

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

      // Unknown event types - no-op (extensibility hook for future KCS versions)
      default:
        break;
    }

    return events;
  }
}
