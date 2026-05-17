/**
 * KimiClawRawParser -- maps KCS SSE events to nimbalyst canonical events.
 *
 * Handles BOTH event vocabularies that ship under the KCS umbrella:
 *
 *  (A) MASTER (production, flat-layout, k2_6_swarm_engine.py Flask):
 *      Envelope: {type, swarm_id, timestamp, payload: {...}, seq}
 *      Vocabulary: swarm.created, state.changed, decompose.started/completed,
 *      brain.tier, orchestrator.plan_summary, spawn.completed, wave.started/
 *      completed/created, agent.started/action/activity_changed/phase_changed/
 *      completed/degraded/failed, budget.update/exhausted, synthesize.completed,
 *      coordinate.started/completed/cancelled/error/resume,
 *      orchestrator.deliverable/intermediate_synthesis/nested_action,
 *      decompose.synthetic, swarm.cancelled, swarm.reaped
 *
 *  (B) MAIN (experimental subpackage, FastAPI bridge in kimi_claw_swarm/):
 *      Envelope: {type, data: {...}}
 *      Vocabulary: orchestrator.started, swarm.configured,
 *      cascade.tier_attempt/heartbeat/succeeded/failed, task.created,
 *      decompose.completed (different payload shape), spawn.completed,
 *      wave.started/completed, agent.started/phase_changed/completed/failed,
 *      orchestrator.deliverable, orchestrator.error/failed,
 *      coordinate.completed/cancelled/error
 *
 * Discriminator: master events have `payload` field; main events have `data`.
 * The parser tries both and dispatches on `type`.
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

const DOMAIN_GLYPHS: Record<string, string> = {
  coding: '⚙',
  research: '🔍',
  writing: '✎',
  analysis: '◇',
  design: '◈',
  communication: '✉',
};

// Cascade tier → human name. Master uses 1=kimi 2=qwq 3=synthetic (collapsed
// metric); main uses 1=kimi 2=codex 3=claude-cli 4=qwq 5=synthetic (granular).
// We render whichever the event carries — if master collapses kimi/codex/
// claude-cli into tier 1, we trust the `reason` field instead.
const TIER_NAME_MAIN: Record<number, string> = {
  1: 'kimi', 2: 'codex', 3: 'claude-cli', 4: 'qwq', 5: 'synth',
};

function reasonToCascadeName(reason: string | undefined): string {
  if (!reason) return '';
  // Master's brain.tier reasons: kimi_ok, codex_ok, claude_cli_ok, qwq_ok,
  // no_kimi_auth, correlated_fail, etc.
  if (reason.startsWith('kimi')) return 'kimi';
  if (reason.startsWith('codex')) return 'codex';
  if (reason.startsWith('claude')) return 'claude-cli';
  if (reason.startsWith('qwq')) return 'qwq';
  if (reason === 'no_kimi_auth') return 'kimi (no auth)';
  return reason;
}

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

    // The raw content can be EITHER:
    //   master envelope:  {type, swarm_id, timestamp, payload: {...}, seq}
    //   main envelope:    {type, data: {...}}
    // We accept both. The "d" alias below is the merged payload — fields are
    // looked up there regardless of which envelope produced them.
    let raw: { type: string; payload?: Record<string, unknown>; data?: Record<string, unknown> } | null = null;
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed.type === 'string') {
        raw = parsed;
      }
    } catch {
      return events;
    }
    if (!raw) return events;

    // Prefer master's `payload`, fall back to main's `data`, fall back to root
    // (some older test fixtures put fields at the root next to `type`).
    const d: Record<string, unknown> =
      (raw.payload as Record<string, unknown>) ||
      (raw.data as Record<string, unknown>) ||
      (raw as unknown as Record<string, unknown>) ||
      {};

    switch (raw.type) {
      // =====================================================================
      // Swarm lifecycle (start / configure / state)
      // =====================================================================

      // MASTER: swarm.created carries swarm_id + task + full config.
      // MAIN:   orchestrator.started carries just swarm_id + task.
      // Treat both as the swarm-start banner.
      case 'swarm.created':
      case 'orchestrator.started': {
        const sid = (d.swarm_id as string) || '';
        const task = (d.task as string) || '';
        const cfg = (d.config as Record<string, unknown> | undefined);
        const maxAgents = cfg?.max_agents ?? d.max_agents;
        const maxSteps = cfg?.max_steps ?? d.max_steps;
        let text = `Swarm ${sid.slice(0, 16)} started`;
        if (maxAgents !== undefined && maxSteps !== undefined) {
          text += ` — up to ${maxAgents} agent${maxAgents === 1 ? '' : 's'}, ${maxSteps} steps`;
        }
        if (task && task.length < 200) {
          text += `\nTask: ${task}`;
        }
        events.push({
          type: 'system_message',
          text,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // MAIN-only: legacy configured event (master folds config into swarm.created)
      case 'swarm.configured':
        events.push({
          type: 'system_message',
          text: `Swarm configured — max ${d.max_agents} agents, ${d.max_steps} steps${d.parallel ? ' (parallel)' : ''}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      // MASTER: state.changed fires for every transition (queued → decomposing
      // → executing → synthesizing → completed). Most are noise; the
      // synthesizing one is informative because that's the long-tail final
      // step. Show it; suppress the others.
      case 'state.changed': {
        const state = (d.state as string) || '';
        if (state === 'synthesizing') {
          events.push({
            type: 'system_message',
            text: 'Synthesizing final answer...',
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        // queued / executing / decomposing / completed are inferable from
        // adjacent events; skip to keep the ticker readable.
        break;
      }

      // =====================================================================
      // Decompose phase (planning)
      // =====================================================================

      // MASTER: decompose.started carries complexity + recommendation.
      case 'decompose.started': {
        const score = (d.complexity_score as number) ?? 0;
        const recAgents = (d.recommended_agents as number) ?? 0;
        const recSteps = (d.recommended_steps as number) ?? 0;
        events.push({
          type: 'system_message',
          text: `Decomposing task (complexity ${score.toFixed(2)}, ~${recAgents} agent${recAgents === 1 ? '' : 's'} × ~${recSteps} steps)`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // MASTER: decompose.completed carries agent_count + domains list.
      // MAIN:   decompose.completed carries subtask_count + estimated_steps.
      // Handle both shapes.
      case 'decompose.completed': {
        const agentCount = (d.agent_count as number) ?? (d.subtask_count as number) ?? 0;
        const domains = Array.isArray(d.domains) ? (d.domains as string[]) : null;
        const estSteps = (d.estimated_steps as number) ?? 0;
        if (agentCount > 0) {
          let text = `[Plan] ${agentCount} agent${agentCount === 1 ? '' : 's'}`;
          if (domains && domains.length > 0) {
            text += ` across ${domains.join(' / ')}`;
          } else if (estSteps > 0) {
            text += ` (~${estSteps} steps)`;
          }
          events.push({
            type: 'system_message',
            text,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // MASTER: decompose.synthetic fires when even the decompose cascade
      // floored out. Worth surfacing because it signals the whole plan came
      // from canned fallback content.
      case 'decompose.synthetic':
        events.push({
          type: 'system_message',
          text: `⚠ Plan generated by synthetic fallback (cascade exhausted: ${d.fallback_reason || 'unknown'})`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      // MASTER: orchestrator.plan_summary lists the actual subtask headlines.
      // This IS user-facing content — render as a bulleted list.
      case 'orchestrator.plan_summary': {
        const tasks = Array.isArray(d.tasks) ? (d.tasks as string[]) : [];
        const agentCount = (d.agent_count as number) ?? tasks.length;
        if (tasks.length > 0) {
          const lines = tasks.map((t) => `• ${t}`).join('\n');
          events.push({
            type: 'system_message',
            text: `Plan (${agentCount} agent${agentCount === 1 ? '' : 's'}):\n${lines}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // MAIN-only: per-subtask cards emitted between decompose and spawn.
      // Master surfaces the same info via orchestrator.plan_summary above.
      case 'task.created': {
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

      // BOTH: spawn.completed signals agents ready to execute.
      // Master shape:  {agents_spawned, waves, wave_breakdown}
      // Main shape:    {agent_count}
      case 'spawn.completed': {
        const count = (d.agents_spawned as number) ?? (d.agent_count as number) ?? 0;
        const waves = (d.waves as number) ?? 0;
        if (count > 0) {
          const waveStr = waves > 1 ? ` (${waves} waves)` : '';
          events.push({
            type: 'system_message',
            text: `[Spawn] ${count} agent${count === 1 ? '' : 's'} ready${waveStr}, executing...`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // =====================================================================
      // Brain tier (cascade visibility — master collapses to 1=primary/2=qwq/3=synth)
      // =====================================================================

      // MASTER: brain.tier fires after each cascade decision with the winner.
      // Reason tells us which adapter served the call. This is the closest
      // master comes to per-tier visibility — collapsed but informative.
      case 'brain.tier': {
        const kind = (d.kind as string) || 'unknown';
        const tier = typeof d.tier === 'number' ? (d.tier as number) : undefined;
        const reason = (d.reason as string) || '';
        const synthetic = d.synthetic_output_used === true;
        const cascadeName = reasonToCascadeName(reason);
        let text = `[${kind}] `;
        if (synthetic) {
          text += `⚠ synthetic fallback (tier ${tier ?? '?'})`;
        } else if (cascadeName) {
          text += `via ${cascadeName}`;
        } else {
          text += `tier ${tier ?? '?'} (${reason || 'no reason'})`;
        }
        events.push({
          type: 'system_message',
          text,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // =====================================================================
      // Wave coordination
      // =====================================================================

      // BOTH: wave.started. Master shape: {wave_number, agent_count}.
      // Main shape: {wave_number, wave_total, agent_count, agent_ids}.
      case 'wave.started': {
        const num = (d.wave_number as number) ?? 0;
        const total = (d.wave_total as number);
        const count = (d.agent_count as number) ?? 0;
        const totalStr = total !== undefined ? `/${total}` : '';
        events.push({
          type: 'system_message',
          text: `[Wave ${num + 1}${totalStr}] starting with ${count} agent${count === 1 ? '' : 's'}...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // BOTH: wave.completed.
      // Master: {wave_number, completed, failed, steps_used, budget_remaining, duration_ms, parallel_efficiency}
      // Main:   {wave_number, wave_total, succeeded, failed, elapsed_s}
      case 'wave.completed': {
        const num = (d.wave_number as number) ?? 0;
        const total = (d.wave_total as number);
        const succeeded = (d.completed as number) ?? (d.succeeded as number) ?? 0;
        const failed = (d.failed as number) ?? 0;
        const elapsedMs = (d.duration_ms as number);
        const elapsedS = elapsedMs !== undefined ? elapsedMs / 1000 : (d.elapsed_s as number) ?? 0;
        const totalStr = total !== undefined ? `/${total}` : '';
        const failStr = failed > 0 ? `, ${failed} failed` : '';
        events.push({
          type: 'system_message',
          text: `[Wave ${num + 1}${totalStr}] completed in ${elapsedS.toFixed(1)}s (${succeeded} succeeded${failStr})`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // MASTER-only reentrant path: wave.created lists subtask manifest before
      // wave.started. Compact summary if subtasks present.
      case 'wave.created': {
        const reason = (d.reason as string) || '';
        const count = (d.agent_count as number) ?? 0;
        if (reason === 'orchestrator_followup' && count > 0) {
          events.push({
            type: 'system_message',
            text: `Orchestrator queued ${count} follow-up agent${count === 1 ? '' : 's'}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // =====================================================================
      // Agent lifecycle
      // =====================================================================

      // MASTER persona-mode: persona.selected fires per agent BEFORE
      // agent.started. Carries persona_id, persona_name, role, tagline,
      // avatar (emoji), color. Render as a compact selection ticker line
      // so the operator sees the persona assignments before the agents
      // start working.
      case 'persona.selected': {
        const agentShort = (d.agent_id as string)?.slice(0, 8) || 'agent';
        const personaName = (d.persona_name as string) || (d.persona_id as string) || '?';
        const role = (d.role as string) || '';
        const avatar = (d.avatar as string) || '';
        const roleStr = role ? ` · ${role}` : '';
        events.push({
          type: 'system_message',
          text: `${avatar} ${personaName}${roleStr} → ${agentShort}`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // BOTH: agent.started. Master adds persona fields when persona_mode on.
      case 'agent.started': {
        const agentName = (d.name as string) || (d.agent_id as string)?.slice(0, 8) || 'agent';
        const personaName = (d.persona_name as string);
        const role = (d.role as string);
        const label = personaName ? `${personaName} (${role || agentName})` : agentName;
        events.push({
          type: 'system_message',
          text: `[Agent ${label}] Starting...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // MASTER: agent.action fires per LLM call within an agent (think / search
      // / write_file / browse / python / create_subagent). Only render the
      // status=in_progress for "think" actions as a thinking indicator;
      // completed/failed are confirmation that adds noise. Render search and
      // write_file regardless because they're meaningful side effects.
      case 'agent.action': {
        const agentId = (d.agent_id as string) || '';
        const kind = (d.kind as string) || '';
        const status = (d.status as string) || '';
        const args = (d.args as Record<string, unknown>) || {};
        const agentShort = agentId.slice(0, 8);
        if (status === 'in_progress' && kind === 'think') {
          // Suppress — the activity_changed=Running event covers this
          break;
        }
        if (kind === 'search' && status === 'in_progress') {
          const query = (args.query as string) || '';
          events.push({
            type: 'system_message',
            text: `[Agent ${agentShort}] 🔍 searching: ${query.slice(0, 100)}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        } else if (kind === 'write_file' && status === 'completed') {
          const path = (args.path as string) || '?';
          events.push({
            type: 'system_message',
            text: `[Agent ${agentShort}] ✎ wrote ${path}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        } else if (kind === 'create_subagent' && status === 'in_progress') {
          const sub = (args.agent_type as string) || 'subagent';
          events.push({
            type: 'system_message',
            text: `[Agent ${agentShort}] spawning ${sub}...`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        // Other (kind, status) combos are suppressed — too chatty.
        break;
      }

      // MASTER: agent.activity_changed is a freeform string ("Running",
      // "Completed", "Failed", "Self-critique recorded"). Show only the
      // non-trivial ones — Running/Completed are inferable from other events.
      case 'agent.activity_changed': {
        const activity = (d.activity as string) || '';
        const agentShort = (d.agent_id as string)?.slice(0, 8) || 'agent';
        const noisy = ['Running', 'Completed', ''];
        if (!noisy.includes(activity)) {
          events.push({
            type: 'system_message',
            text: `[Agent ${agentShort}] ${activity}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // MASTER: agent.phase_changed only in persona_mode. Compact form.
      // MAIN: agent.phase_changed uses {phase} not {to_phase}.
      case 'agent.phase_changed': {
        const agentName2 = (d.persona_name as string) || (d.name as string) || (d.agent_id as string)?.slice(0, 8) || 'agent';
        const phase = (d.to_phase as string) || (d.phase as string) || '';
        // Skip the most-common phases that add noise; surface the meaningful ones.
        const noisyPhases = ['identifying', 'iterating'];
        if (phase && !noisyPhases.includes(phase)) {
          events.push({
            type: 'system_message',
            text: `[${agentName2}] ${phase}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // BOTH: agent.completed carries the FULL LLM output text.
      // Master:  {agent_id, name, output, output_length, +persona fields, degraded?}
      // Main:    {agent_id, name, output, synthetic_output_used, tier, domain}
      // This is the most important event — it's the actual content.
      case 'agent.completed': {
        const output = typeof d.output === 'string' ? d.output : JSON.stringify(d.output ?? '');
        const synthetic = d.synthetic_output_used === true;
        const tier = typeof d.tier === 'number' ? (d.tier as number) : undefined;
        const degraded = d.degraded === true;
        const agentName = (d.persona_name as string) || (d.name as string) || (d.agent_id as string)?.slice(0, 8) || 'agent';
        const domain = (d.role as string) || (d.domain as string) || 'general';
        const glyph = DOMAIN_GLYPHS[domain] || '●';

        // Tier/degradation badge.
        let tierLabel = '';
        if (synthetic) {
          tierLabel = ' · ⚠ SYNTH fallback (no real LLM)';
        } else if (degraded) {
          tierLabel = ' · ⚠ degraded (kimi transient → cascade)';
        } else if (tier !== undefined && tier > 1 && TIER_NAME_MAIN[tier]) {
          tierLabel = ` · via ${TIER_NAME_MAIN[tier]}`;
        } else if (tier === 1) {
          tierLabel = ' · kimi';
        }

        // Per-agent divider header.
        events.push({
          type: 'system_message',
          text: `${glyph} ${agentName} · ${domain}${tierLabel}`,
          systemType: 'status',
          createdAt: new Date(),
        });

        // Synthetic outputs get an extra inline marker — users absolutely
        // shouldn't mistake canned content for a real LLM answer when the
        // divider scrolls off-screen above a long blob.
        const prefix = synthetic ? '[SYNTH fallback - no real LLM]\n\n' : '';
        if (output.trim()) {
          events.push({
            type: 'assistant_message',
            text: prefix + output,
            createdAt: new Date(),
          });
        }
        break;
      }

      // MASTER-only: agent.degraded fires before the cascade fallback completes.
      // Render as a status warning; the eventual agent.completed will carry
      // degraded:true so the divider also shows the warning.
      case 'agent.degraded': {
        const agentShort = (d.agent_id as string)?.slice(0, 8) || 'agent';
        const reason = (d.reason as string) || 'unknown';
        events.push({
          type: 'system_message',
          text: `[Agent ${agentShort}] ⚠ degraded: ${reason} — falling back through cascade...`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // BOTH: agent.failed.
      case 'agent.failed': {
        const agentShort = (d.agent_id as string)?.slice(0, 8) || 'agent';
        const agentName = (d.name as string) || agentShort;
        events.push({
          type: 'system_message',
          text: `Agent ${agentName} failed: ${d.error}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;
      }

      // =====================================================================
      // Budget / progress (mostly noisy — compact-only)
      // =====================================================================

      case 'budget.update':
        // Suppress — wave.completed carries enough budget info
        break;

      case 'budget.exhausted': {
        const wave = (d.wave_reached as number);
        const strict = d.strict_mode === true;
        let text = 'Budget exhausted';
        if (wave !== undefined) text += ` at wave ${wave + 1}`;
        if (strict) text += ' (strict mode)';
        events.push({
          type: 'system_message',
          text,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;
      }

      // =====================================================================
      // Synthesis phase
      // =====================================================================

      // MASTER: synthesize.completed reports metadata only; the actual
      // synthesized text rides on coordinate.completed.final_output.
      case 'synthesize.completed': {
        const tier = (d.fallback_tier as number);
        const synthetic = d.synthetic_output_used === true;
        const sources = (d.sources as number) ?? 0;
        let text = `Synthesized from ${sources} source${sources === 1 ? '' : 's'}`;
        if (synthetic) {
          text += ` — ⚠ synthetic fallback (tier ${tier})`;
        } else if (tier && tier > 1) {
          text += ` via ${TIER_NAME_MAIN[tier] || `tier ${tier}`}`;
        }
        events.push({
          type: 'system_message',
          text,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;
      }

      // =====================================================================
      // Orchestrator-level outputs
      // =====================================================================

      // MASTER: orchestrator.intermediate_synthesis fires between waves to
      // share the orchestrator's reasoning. text-bearing — render verbatim.
      case 'orchestrator.intermediate_synthesis': {
        const synthesis = (d.synthesis as string) || '';
        const waveIndex = (d.wave_index as number) ?? 0;
        const done = d.done === true;
        if (synthesis.trim()) {
          const header = done
            ? `Orchestrator after wave ${waveIndex + 1} (final):`
            : `Orchestrator after wave ${waveIndex + 1}:`;
          events.push({
            type: 'system_message',
            text: header,
            systemType: 'status',
            createdAt: new Date(),
          });
          events.push({
            type: 'assistant_message',
            text: synthesis,
            createdAt: new Date(),
          });
        }
        break;
      }

      // MASTER: orchestrator.nested_action is the orchestrator's "thinking"
      // narration when deciding whether to spawn a follow-up wave. Compact.
      case 'orchestrator.nested_action': {
        const kind = (d.kind as string) || '';
        const text = (d.text as string) || '';
        if (text) {
          events.push({
            type: 'system_message',
            text: `Orchestrator ${kind}: ${text.slice(0, 200)}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // BOTH: orchestrator.deliverable.
      // Master: {file_name, file_size, file_type, download_url, agent_id} — file-bearing
      // Main:   {content} — inline text
      case 'orchestrator.deliverable': {
        const content = (d.content as string);
        const fileName = (d.file_name as string);
        if (content && content.trim()) {
          events.push({
            type: 'assistant_message',
            text: content,
            createdAt: new Date(),
          });
        } else if (fileName) {
          const fileSize = (d.file_size as number);
          const sizeStr = typeof fileSize === 'number' ? ` (${fileSize} bytes)` : '';
          events.push({
            type: 'system_message',
            text: `📎 Artifact: ${fileName}${sizeStr}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      // MAIN-only: orchestrator.error / orchestrator.failed
      case 'orchestrator.error':
      case 'orchestrator.failed':
        events.push({
          type: 'system_message',
          text: `Swarm error: ${d.error}`,
          systemType: 'error',
          createdAt: new Date(),
        });
        break;

      // =====================================================================
      // Coordinate-level terminal events
      // =====================================================================

      // MASTER: coordinate.completed carries full SwarmResult.to_dict() —
      // including final_output which IS the deliverable.
      // MAIN:   coordinate.completed is a sentinel; deliverable comes via
      //         orchestrator.deliverable instead.
      case 'coordinate.completed': {
        // Render final_output as assistant content if present (master path).
        const finalOutput = (d.final_output as string);
        if (finalOutput && finalOutput.trim()) {
          events.push({
            type: 'assistant_message',
            text: finalOutput,
            createdAt: new Date(),
          });
        }
        // Always emit turn_ended so the UI knows the turn is done.
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
      }

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

      // MASTER: coordinate.started / coordinate.resume — silent (the lifecycle
      // is already shown via swarm.created + state.changed=executing).
      case 'coordinate.started':
      case 'coordinate.resume':
        break;

      // MASTER: swarm.cancelled / swarm.reaped — cancellation lifecycle.
      case 'swarm.cancelled': {
        const reason = (d.reason as string) || 'cancelled';
        const already = d.already_terminal === true;
        if (!already) {
          events.push({
            type: 'system_message',
            text: `Swarm cancelled: ${reason}`,
            systemType: 'status',
            createdAt: new Date(),
          });
        }
        break;
      }

      case 'swarm.reaped':
        events.push({
          type: 'system_message',
          text: `Swarm reaped (wedged in cancelling state)`,
          systemType: 'status',
          createdAt: new Date(),
        });
        break;

      // =====================================================================
      // Cascade-tier visibility (MAIN-only — master uses brain.tier instead)
      // =====================================================================

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

      // Unknown event types - no-op (extensibility hook for future KCS versions)
      default:
        break;
    }

    return events;
  }
}
