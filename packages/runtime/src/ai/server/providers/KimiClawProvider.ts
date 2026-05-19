/**
 * KimiClaw Provider
 *
 * HTTP+SSE provider for KimiClawSwarm (KCS) — local FastAPI server at 127.0.0.1:9643.
 * Follows the same pattern as OpenCodeProvider.
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import { buildUserMessageAddition } from './documentContextUtils';
import {
  ProviderConfig,
  DocumentContext,
  StreamChunk,
  ProviderCapabilities,
  AIModel,
  AIProviderType,
  ChatAttachment,
} from '../types';
import { KimiClawProtocol, KimiClawHttpTransport } from '../protocols/KimiClawProtocol';
import { ProviderSessionManager } from './ProviderSessionManager';
import { McpConfigService } from '../services/McpConfigService';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { safeJSONSerialize } from '../../../utils/serialization';
import { TranscriptMigrationRepository } from '../../../storage/repositories/TranscriptMigrationRepository';

interface KimiClawProviderDeps {
  protocol?: KimiClawProtocol;
}

export class KimiClawProvider extends BaseAgentProvider {
  private readonly protocol: KimiClawProtocol;
  private readonly mcpConfigService: McpConfigService;

  constructor(deps?: KimiClawProviderDeps) {
    super();
    this.protocol = deps?.protocol || new KimiClawProtocol();
    this.mcpConfigService = new McpConfigService({
      mcpServerPort: null,
      sessionNamingServerPort: null,
      extensionDevServerPort: null,
      superLoopProgressServerPort: null,
      sessionContextServerPort: null,
      mcpAuthToken: null,
      mcpConfigLoader: null,
      extensionPluginsLoader: null,
      claudeSettingsEnvLoader: null,
      shellEnvironmentLoader: null,
    });
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  getProviderName(): string {
    return 'kimiclaw';
  }

  getDisplayName(): string {
    return 'KimiClaw';
  }

  getDescription(): string {
    return 'KimiClawSwarm local multi-agent orchestration';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: false,
      mcpSupport: false,
      edits: false,
      resumeSession: true,
      supportsFileTools: false,
    };
  }

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: 'kimiclaw:kimi-code/kimi-for-coding',
        name: 'Kimi K2 Coding',
        provider: 'kimiclaw' as AIProviderType,
      },
    ];
  }

  static getDefaultModel(): string {
    return 'kimi-code/kimi-for-coding';
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      swarmId: providerSessionId,
    };
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: '[KimiClawProvider] workspacePath is required' };
      return;
    }

    const systemPrompt = this.buildSystemPrompt(documentContext);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

    // Emit prompt additions for UI
    if (sessionId && (systemPrompt || userMessageAddition)) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    // Log user message
    if (sessionId) {
      await this.logAgentMessageBestEffort(sessionId, 'input', messageWithContext);
    }

    const abortController = new AbortController();
    this.abortController = abortController;
    let fullText = '';

    try {
      const existingSwarmId = this.sessions.getSessionId(sessionId || '');

      let isResumedSession = !!existingSwarmId;
      if (isResumedSession && existingSwarmId) {
        // Check if the swarm is still alive.
        //
        // 2026-05-18: status enum corrected. KCS's SwarmState
        // (k2_6_types.py:209) emits one of:
        //   in-flight: queued | decomposing | spawning | executing |
        //              synthesizing | cancelling
        //   terminal:  completed | failed | cancelled | budget_exhausted
        // The previous check `status === 'running'` matched nothing
        // because KCS never emits 'running' — so any resume on an
        // in-flight swarm fell through both branches and silently
        // dispatched a duplicate. Similarly the terminal branch missed
        // 'budget_exhausted' so those swarms re-dispatched instead of
        // rendering the persisted deliverable.
        const IN_FLIGHT = new Set(['queued', 'decomposing', 'spawning', 'executing', 'synthesizing', 'cancelling']);
        const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'budget_exhausted']);
        try {
          const snap = await this.protocol.getSnapshot(existingSwarmId);
          const status = snap.status as string;
          if (IN_FLIGHT.has(status)) {
            // The existing swarm is still in flight. We don't yet have a
            // factored reattach path that can re-stream events from the
            // existing swarmId without going through the full
            // createSession+dispatch flow below. Until that's wired,
            // surface the situation to the user and bail rather than
            // silently dispatching a second swarm on top of the first
            // (which was the prior behaviour and caused duplicate
            // dispatches on resume).
            console.log('[KIMICLAW] Existing swarm still in flight, not dispatching a new one:', existingSwarmId, 'status=', status);
            const elapsedMs = (snap as { duration_ms?: number }).duration_ms ?? 0;
            const elapsedSec = Math.max(1, Math.floor(elapsedMs / 1000));
            yield {
              type: 'text',
              content: `KimiClaw swarm ${existingSwarmId} is still ${status} for this session (elapsed ${elapsedSec}s). Wait for it to finish, or cancel it from the KCS UI at http://127.0.0.1:9643 before sending another message.`,
            };
            yield { type: 'complete', isComplete: true };
            return;
          } else if (TERMINAL.has(status)) {
            // Terminal — render persisted deliverable as history
            console.log('[KIMICLAW] Swarm terminal, rendering history:', existingSwarmId, 'status=', status);
            const deliverable = snap.deliverable || snap.result;
            if (deliverable) {
              const text = typeof deliverable === 'string' ? deliverable : JSON.stringify(deliverable);
              yield { type: 'text', content: text };
              yield { type: 'complete', isComplete: true };
              return;
            }
          } else {
            // Unknown status — log it so a future KCS state addition
            // doesn't silently fall through to a duplicate dispatch.
            console.warn('[KIMICLAW] Unknown swarm status, treating as new session:', existingSwarmId, 'status=', status);
            isResumedSession = false;
          }
        } catch {
          // Snapshot failed (e.g. 404 — swarm wiped by container rebuild
          // in dev). Treat as new session so the user can keep working.
          console.warn('[KIMICLAW] Resume snapshot failed, treating as new session');
          isResumedSession = false;
        }
      }

      // Load MCP config if available
      let mcpServers: Record<string, unknown> | undefined;
      try {
        mcpServers = await this.mcpConfigService.getMcpServersConfig({ workspacePath, sessionId });
      } catch {
        // MCP optional — proceed without
      }

      // 2026-05-18: per-session timeout override. The control plane
      // (controlRoutes.ts) stores the caller-supplied timeoutS into
      // session metadata at create time so headless automation can
      // dispatch large swarms (8+ agents) that need >1800s without
      // changing the global provider default. Read once here; the
      // value is plumbed into swarmDefaults below. Best-effort: if
      // the session row is missing or metadata can't be parsed,
      // fall back to provider default.
      let sessionTimeoutOverride: number | undefined;
      if (sessionId) {
        try {
          const { AISessionsRepository } = await import('@nimbalyst/runtime/storage/repositories/AISessionsRepository');
          const sess = await AISessionsRepository.get(sessionId);
          const mt = (sess as { metadata?: { timeoutS?: number } } | null)?.metadata?.timeoutS;
          if (typeof mt === 'number' && mt > 0) {
            sessionTimeoutOverride = mt;
            console.log(`[KIMICLAW] timeout_s override from session metadata: ${mt}s for session ${sessionId}`);
          }
        } catch (err) {
          // Non-fatal — provider default applies.
          console.warn(`[KIMICLAW] failed to read session timeoutS override:`, err);
        }
      }

      const sessionOptions = {
        workspacePath,
        model: this.config?.model || 'default',
        raw: {
          endpoint: (this.config as any)?.endpointUrl || (this.config as any)?.endpoint || 'http://127.0.0.1:9643',
          authMode: (this.config as any)?.authMethod || (this.config as any)?.authMode || 'cookie',
          username: (this.config as any)?.username || 'admin',
          password: (this.config as any)?.password || 'admin',
          bearerToken: (this.config as any)?.bearerToken || '',
          swarmDefaults: {
            // The settings panel stores the user's choice under `defaultMode`
            // as the literal string 'crew' | 'classic' (see KimiClawPanel.tsx).
            // Translate to KCS's persona_mode boolean here. The previous read
            // key `personaMode` never matched any saved field, so persona_mode
            // was always true and the user's "Classic" selection was silently
            // ignored.
            persona_mode: ((this.config as any)?.defaultMode ?? 'crew') !== 'classic',
            max_agents: (this.config as any)?.maxAgents ?? 4,
            max_steps: (this.config as any)?.maxSteps ?? 12,
            max_parallel: (this.config as any)?.maxParallel,
            // Per-swarm hard wall-clock budget. KCS watchdog cancels the
            // swarm at this elapsed time with a clean failure event.
            //
            // Per-swarm hard wall-clock budget. KCS watchdog cancels the
            // swarm at this elapsed time with a clean failure event.
            //
            // 2026-05-18: bumped default 300s -> 900s -> 1800s. A persona
            // swarm with 3-4 agents walking the cascade (kimi 120s + codex
            // 180s + claude_cli 300s = up to 600s per agent, sequential
            // within an agent because each tier waits for the previous to
            // fail) needs more headroom than the original 300s. Empirical
            // tonight: a 3-sentence 3-agent prompt hit 900s wall with
            // 2/3 agents done; 1800s covers 5-6 agent swarms with
            // cascade-walk slack. 8-agent DealMatrix-class runs should
            // override via session metadata (timeoutS at create time —
            // read below, takes precedence over the provider default).
            // Override chain (highest wins):
            //   1. session.metadata.timeoutS  — per-session, from
            //      nimbalyst_create_session MCP tool's timeoutS param.
            //      Loaded via getSessionTimeoutOverride() above.
            //   2. this.config.timeoutS       — provider-level config
            //      (settings panel "Timeout (s)" field).
            //   3. 1800                       — module default.
            timeout_s: sessionTimeoutOverride ?? (this.config as any)?.timeoutS ?? 1800,
            // Quality Control (KCS v4.12+). Defaults preserve pre-v4.12
            // behavior: verifier off, no retries.
            verifier_enabled: (this.config as any)?.verifierEnabled ?? false,
            // 0 in the UI means "send null" so pre-v4.12 KCS treats it as
            // no retry budget. >0 sends the integer.
            max_retries_per_agent:
              ((this.config as any)?.maxRetriesPerAgent ?? 0) === 0
                ? null
                : (this.config as any)?.maxRetriesPerAgent,
            retry_on: (this.config as any)?.retryOn ?? 'exception,empty',
          },
          mcpServers,
        } as Record<string, unknown>,
      };

      console.log(`[KIMICLAW] Creating session (resumed=${isResumedSession}) for ${sessionId}`);
      // v4.13 (2026-05-17): retain the AgentProtocolTranscriptAdapter
      // construction (its processEvent() is consumed in the streaming
      // loop below) but drop the .userMessage(...) call. The adapter
      // is built with `null` bus so userMessage was a guaranteed no-op
      // — placement-shuffling at 85db406b moved a call that wrote
      // nothing. Actual user message persistence happens upstream via
      // MessageStreamingHandler.ts:386 BEFORE provider.sendMessage()
      // is invoked, so for fresh sessions ordering is correct. If
      // "question at bottom" recurs on screen, the cause is elsewhere:
      // likely KCS SSE event timestamps from the server side racing
      // the user message sequence, or session-resume ordering. Needs
      // a separate investigation before another speculative fix.
      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');

      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSwarmId || '', sessionOptions)
        : await this.protocol.createSession(sessionOptions);
      console.log(`[KIMICLAW] Session created: ${session.id}`);

      // Note: we don't store session.id (random UUID) here.
      // The actual KCS swarmId is captured from the first protocol event below.

      // Stream protocol events — update stored providerSessionId to swarmId when dispatch completes
      let swarmIdCaptured = false;
      let hasText = false;

      console.log(`[KIMICLAW] Starting protocol.sendMessage for session ${session.id}`);
      for await (const event of this.protocol.sendMessage(session, {
        content: messageWithContext,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (!swarmIdCaptured && event.metadata && (event.metadata as Record<string, unknown>).providerSessionId) {
          console.log(`[KIMICLAW] Swarm dispatched: ${(event.metadata as Record<string, unknown>).providerSessionId}`);
        }
        // Overwrite stored session id with the actual KCS swarmId (needed for resume/snapshot)
        if (sessionId && !swarmIdCaptured && event.metadata && (event.metadata as Record<string, unknown>).providerSessionId) {
          this.sessions.captureSessionId(sessionId, (event.metadata as Record<string, unknown>).providerSessionId as string);
          swarmIdCaptured = true;
        }
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        // Store raw events for transcript
        if (sessionId && event.type === 'raw_event') {
          const rawSseEvent = (event.metadata as { rawEvent?: unknown } | undefined)?.rawEvent;
          if (rawSseEvent !== undefined) {
            const sseEventType = typeof (rawSseEvent as { type?: unknown }).type === 'string'
              ? (rawSseEvent as { type: string }).type : 'unknown';

            // Verbose-logging gate. When the toggle is off (default), skip
            // persisting the every-5s heartbeat ticks and phase-change chatter
            // so the transcript stays readable. Structural events (waves,
            // tier attempts/successes/failures, agent start/complete,
            // deliverable, errors) are always persisted.
            const verbose = ((this.config as any)?.verboseLogging as boolean) === true;
            const VERBOSE_ONLY_EVENTS = new Set([
              'cascade.tier_heartbeat',
              'agent.phase_changed',
              'agent.activity_changed',
              'budget.update',
            ]);
            if (!verbose && VERBOSE_ONLY_EVENTS.has(sseEventType)) {
              continue;
            }

            const { content } = safeJSONSerialize(rawSseEvent);
            await this.logAgentMessageBestEffort(sessionId, 'output', content, {
              metadata: { eventType: sseEventType, kimiclawProvider: true },
              hidden: true,
              searchable: false,
            });
            // Drive incremental transcript transformation
            await this.processTranscriptMessages(sessionId);
          }
        }

        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              // Add a blank line between chunks so multi-agent output is readable
              fullText += fullText ? '\n\n' + item.text : item.text;
              hasText = true;
              yield { type: 'text', content: item.text };
              break;
            case 'tool_call':
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;
            case 'tool_result':
              yield { type: 'tool_call', toolCall: { id: item.toolResult.id, name: item.toolResult.name, result: item.toolResult.result } };
              break;
            case 'complete':
              yield { type: 'complete', content: item.event.content, isComplete: true, usage: item.event.usage };
              break;
            case 'error':
              yield { type: 'error', error: item.message };
              break;
            case 'raw_event':
            case 'reasoning':
            case 'planning_mode':
              break;
          }
        }
      }

      // Persist final assistant output so the renderer can display it.
      // The transcript transformer (ClaudeCodeRawParser fallback) treats
      // non-JSON output messages as plain-text assistant_message events.
      if (sessionId && hasText && fullText.trim()) {
        await this.logAgentMessageBestEffort(sessionId, 'output', fullText.trim());
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[KIMICLAW] Error in sendMessage: ${errorMessage}`);
      if (!abortController.signal.aborted) {
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      this.abortController = null;
    }
  }

  /**
   * Process transcript messages for incremental transformation.
   */
  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      if (TranscriptMigrationRepository.hasService()) {
        await TranscriptMigrationRepository.getService().processNewMessages(
          sessionId,
          this.getProviderName(),
        );
      }
    } catch {
      // Best effort -- the session reload will catch up via ensureUpToDate
    }
  }

  async checkInstallation(): Promise<{ installed: boolean; details?: string }> {
    try {
      // Use configured endpoint/auth if available, otherwise fall back to defaults
      const cfg = this.config as any;
      const endpoint = cfg?.endpointUrl || cfg?.endpoint || 'http://127.0.0.1:9643';
      const authMode = cfg?.authMethod || cfg?.authMode || 'cookie';
      const transport = new KimiClawHttpTransport(endpoint, {
        mode: authMode,
        username: cfg?.username || 'admin',
        password: cfg?.password || 'admin',
        bearerToken: cfg?.bearerToken || '',
      });
      const protocol = new KimiClawProtocol(transport);
      const healthy = await protocol.healthCheck();
      if (healthy) {
        return { installed: true, details: 'KimiClaw reachable' };
      }
      return { installed: false, details: 'KimiClaw not reachable. Run: kcs serve --host 127.0.0.1 --port 9643' };
    } catch {
      return { installed: false, details: 'KimiClaw not reachable. Run: kcs serve --host 127.0.0.1 --port 9643' };
    }
  }
}
