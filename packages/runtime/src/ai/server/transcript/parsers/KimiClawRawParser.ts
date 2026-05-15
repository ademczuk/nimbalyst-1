/**
 * KimiClawRawParser -- maps KCS SSE events to nimbalyst canonical events.
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
      // Agent lifecycle — lumpy-streaming placeholders (Fix B)
      case 'agent.started':
        events.push({
          type: 'system_message',
          text: `[Agent ${d.name || (d.agent_id as string)?.slice(0, 8)}] Starting...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'agent.phase_changed':
        events.push({
          type: 'system_message',
          text: `[Agent ${d.name || (d.agent_id as string)?.slice(0, 8)}] ${d.phase}...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'agent.activity_changed':
        events.push({
          type: 'system_message',
          text: `[Agent ${(d.agent_id as string)?.slice(0, 8)}] ${d.activity}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'agent.completed': {
        const output = typeof d.output === 'string' ? d.output : JSON.stringify(d.output);
        const synthetic = d.synthetic_output_used === true;
        events.push({
          type: 'assistant_message',
          text: output + (synthetic ? '\n\n**[SYNTH -- tier 5 fallback]**' : ''),
          createdAt: new Date(),
        });
        if (synthetic) {
          events.push({
            type: 'system_message',
            text: `Agent ${(d.agent_id as string)?.slice(0, 8)} used synthetic output (tier 5 fallback)`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
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

      case 'agent.degraded':
        events.push({
          type: 'system_message',
          text: `Agent ${(d.agent_id as string)?.slice(0, 8)} degraded (tier ${d.tier}): ${d.reason}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'brain.tier':
        events.push({
          type: 'system_message',
          text: `Agent ${(d.agent_id as string)?.slice(0, 8)} using tier ${d.tier}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      // Decomposition
      case 'decompose.started':
        events.push({
          type: 'tool_call_started',
          toolName: 'decompose_task',
          toolDisplayName: 'Decompose Task',
          arguments: { task: d.task },
          createdAt: new Date(),
        });
        break;

      case 'decompose.completed':
        events.push({
          type: 'tool_call_completed',
          providerToolCallId: 'decompose_task',
          status: 'completed',
          result: JSON.stringify({ subtaskCount: d.subtask_count, subtasks: d.subtasks }),
        });
        break;

      // Wave events
      case 'wave.started':
        events.push({
          type: 'system_message',
          text: `Wave ${d.wave_number} started`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'wave.completed':
        events.push({
          type: 'system_message',
          text: `Wave ${d.wave_number} completed`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      // Orchestrator
      case 'orchestrator.plan_summary':
        events.push({
          type: 'assistant_message',
          text: typeof d.summary === 'string' ? d.summary : JSON.stringify(d.summary),
          createdAt: new Date(),
        });
        break;

      case 'orchestrator.deliverable':
        events.push({
          type: 'assistant_message',
          text: typeof d.deliverable === 'string' ? d.deliverable : JSON.stringify(d.deliverable),
          createdAt: new Date(),
        });
        break;

      // Budget
      case 'budget.update':
        events.push({
          type: 'system_message',
          text: `Steps: ${d.consumed}/${d.total}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      case 'budget.exhausted':
        events.push({
          type: 'system_message',
          text: `Budget exhausted: ${d.reason}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;

      // Terminal
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

      case 'coordinate.error':
        events.push({
          type: 'system_message',
          text: `Swarm error: ${d.error}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;

      // Default pass-through — unknown types become raw_event only
      default:
        break;
    }

    return events;
  }
}
