/**
 * KimiClaw Agent Provider
 *
 * Integrates KimiClawSwarm (KCS) — a local Flask HTTP server in Docker
 * on 127.0.0.1:9643 — into Nimbalyst.
 *
 * Key features:
 * - HTTP+SSE transport (no subprocess management needed)
 * - Cookie or Bearer token auth
 * - Session-cookie auth via POST /api/login (admin/admin default)
 * - Bearer token generation via POST /api/tokens
 * - Per-agent metadata tagging (agentId, tier, persona)
 * - Cascade tier visibility (synthetic badge for tier-5)
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
import {
  KimiClawProtocol,
  KimiClawHttpTransport,
  KimiClawSwarmOptions,
  KimiClawError,
} from '../protocols/KimiClawProtocol';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';

interface KimiClawProviderDeps {
  protocol?: KimiClawProtocol;
}

export class KimiClawProvider extends BaseAgentProvider {
  private protocol: KimiClawProtocol;
  private currentSwarmId: string | null = null;

  // Configuration (set via initialize or static setters)
  private endpoint: string = 'http://127.0.0.1:9643';
  private authMode: 'cookie' | 'bearer' = 'cookie';
  private username: string = 'admin';
  private password: string = 'admin';
  private bearerToken: string = '';
  private swarmDefaults: KimiClawSwarmOptions = {
    persona_mode: true,
    max_agents: 4,
    max_steps: 12,
  };

  // Static swarm defaults setter (called from settings panel)
  private static globalSwarmDefaults: KimiClawSwarmOptions = {
    persona_mode: true,
    max_agents: 4,
    max_steps: 12,
  };

  constructor(deps: KimiClawProviderDeps = {}) {
    super();
    this.protocol = deps.protocol || new KimiClawProtocol(
      new KimiClawHttpTransport(this.endpoint, {
        mode: this.authMode,
        username: this.username,
        password: this.password,
        bearerToken: this.bearerToken,
      })
    );
  }

  getProviderName(): string {
    return 'kimiclaw';
  }

  getDisplayName(): string {
    return 'KimiClaw';
  }

  getDescription(): string {
    return 'KimiClaw Swarm — local multi-agent orchestration in Docker';
  }

  getProviderSessionData(sessionId: string): any {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return {
      providerSessionId,
      swarmId: this.currentSwarmId,
    };
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: false,      // KCS tools are internal, not exposed to nimbalyst
      mcpSupport: false, // Phase 1: MCP passthrough deferred
      edits: false,      // KCS does not expose file edits directly
      resumeSession: false, // KCS swarms are fire-and-forget
      supportsFileTools: false,
    };
  }

  static async getModels(): Promise<AIModel[]> {
    return [
      {
        id: 'kimi-code/kimi-for-coding',
        name: 'Kimi K2 Coding',
        provider: 'kimiclaw' as AIProviderType,
      },
    ];
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    if (config.baseUrl) this.endpoint = config.baseUrl;
    // @ts-expect-error - authMode is a custom config field
    if (config.authMode) this.authMode = config.authMode as 'cookie' | 'bearer';
    // @ts-expect-error
    if (config.username) this.username = config.username as string;
    // @ts-expect-error
    if (config.password) this.password = config.password as string;
    // @ts-expect-error
    if (config.bearerToken) this.bearerToken = config.bearerToken as string;
    // @ts-expect-error
    if (config.personaMode !== undefined) this.swarmDefaults.persona_mode = config.personaMode as boolean;
    // @ts-expect-error
    if (config.maxAgents !== undefined) this.swarmDefaults.max_agents = config.maxAgents as number;
    // @ts-expect-error
    if (config.maxSteps !== undefined) this.swarmDefaults.max_steps = config.maxSteps as number;
    // @ts-expect-error
    if (config.maxParallel !== undefined) this.swarmDefaults.max_parallel = config.maxParallel as number;

    // Rebuild protocol with updated config
    this.protocol = new KimiClawProtocol(
      new KimiClawHttpTransport(this.endpoint, {
        mode: this.authMode,
        username: this.username,
        password: this.password,
        bearerToken: this.bearerToken,
      })
    );
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: unknown[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
  ): AsyncIterableIterator<StreamChunk> {
    const abortController = new AbortController();
    this.abortController = abortController;
    const nimbalystSessionId = sessionId || 'unknown';
    let fullText = '';

    try {
      const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, documentContext);

      // Emit prompt additions for UI
      if (sessionId && (userMessageAddition)) {
        this.emit('promptAdditions', {
          sessionId,
          systemPromptAddition: null,
          userMessageAddition,
          attachments: [],
          timestamp: Date.now(),
        });
      }

      // Create a protocol session
      const protocolSession = await this.protocol.createSession({
        workspacePath: workspacePath || '.',
        model: documentContext?.model,
        systemPrompt: undefined,
        abortSignal: abortController.signal,
        raw: {
          endpoint: this.endpoint,
          authMode: this.authMode,
          username: this.username,
          password: this.password,
          bearerToken: this.bearerToken,
          swarmDefaults: this.swarmDefaults,
        },
      });

      // Store session mapping
      if (sessionId) {
        this.sessions.setProviderSessionData(sessionId, {
          providerSessionId: protocolSession.id,
          platform: 'kimiclaw',
        });
      }

      // Initialize transcript adapter
      const transcriptAdapter = new AgentProtocolTranscriptAdapter(this, nimbalystSessionId);
      transcriptAdapter.userMessage(
        messageWithContext,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      // Log user message
      this.logAgentMessageNonBlocking(
        nimbalystSessionId,
        this.getProviderName(),
        'input',
        message,
      );

      // Stream protocol events
      for await (const event of this.protocol.sendMessage(protocolSession, {
        content: messageWithContext,
        attachments,
        sessionId: nimbalystSessionId,
        mode: documentContext?.mode === 'planning' ? 'planning' : 'agent',
      })) {
        // Handle abort
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        // Store raw KCS events for transcript reconstruction
        if (sessionId && event.type === 'raw_event') {
          const rawSseEvent = (event.metadata as { rawEvent?: unknown } | undefined)?.rawEvent;
          if (rawSseEvent !== undefined) {
            const content = typeof rawSseEvent === 'string'
              ? rawSseEvent
              : JSON.stringify(rawSseEvent);
            const sseEventType = typeof (rawSseEvent as { type?: unknown }).type === 'string'
              ? (rawSseEvent as { type: string }).type
              : 'unknown';
            await this.logAgentMessageBestEffort(
              sessionId,
              'output',
              content,
              {
                metadata: { eventType: sseEventType, kimiclawProvider: true },
                hidden: true,
                searchable: false,
              },
            );
          }
        }

        // Map protocol events to StreamChunk via transcript adapter
        for (const item of transcriptAdapter.processEvent(event)) {
          switch (item.kind) {
            case 'text':
              fullText += item.text;
              yield { type: 'text', content: item.text };
              break;

            case 'tool_call':
              yield { type: 'tool_call', toolCall: item.toolCall };
              break;

            case 'tool_result':
              yield {
                type: 'tool_call',
                toolCall: {
                  id: item.toolResult.id,
                  name: item.toolResult.name,
                  result: item.toolResult.result,
                },
              };
              break;

            case 'complete':
              yield {
                type: 'complete',
                content: item.event.content,
                isComplete: true,
                usage: item.event.usage,
                ...(item.event.contextFillTokens !== undefined
                  ? { contextFillTokens: item.event.contextFillTokens }
                  : {}),
                ...(item.event.contextWindow !== undefined
                  ? { contextWindow: item.event.contextWindow }
                  : {}),
              };
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

        // Track swarm completion
        if (event.type === 'complete') {
          const swarmId = event.metadata?.swarmId as string;
          if (swarmId) {
            this.currentSwarmId = swarmId;
          }
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);

      if (!isAbort) {
        console.error('[KIMICLAW] Error in sendMessage:', errorMessage);
        yield { type: 'error', error: errorMessage };
        this.logAgentMessageNonBlocking(
          nimbalystSessionId,
          this.getProviderName(),
          'output',
          `Error: ${errorMessage}`,
          { isError: true },
        );
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    super.abort();
  }

  destroy(): void {
    this.abort();
    super.destroy();
  }

  // ---- Settings accessors ----

  getEndpoint(): string { return this.endpoint; }
  getAuthMode(): 'cookie' | 'bearer' { return this.authMode; }
  getSwarmDefaults(): KimiClawSwarmOptions { return { ...this.swarmDefaults }; }

  // ---- Static setters for settings panel ----

  static setSwarmDefaults(defaults: KimiClawSwarmOptions): void {
    KimiClawProvider.globalSwarmDefaults = { ...defaults };
  }

  static setEndpoint(_endpoint: string): void {
    // Applied per-instance via initialize()
  }

  async checkInstallation(): Promise<{ installed: boolean; details?: string }> {
    try {
      const transport = new KimiClawHttpTransport(this.endpoint, {
        mode: this.authMode,
        username: this.username,
        password: this.password,
        bearerToken: this.bearerToken,
      });
      const healthy = await transport.healthCheck();
      return {
        installed: healthy,
        details: healthy
          ? `KimiClaw reachable at ${this.endpoint}`
          : `KimiClaw not reachable at ${this.endpoint}. Run: docker compose up -d`,
      };
    } catch {
      return {
        installed: false,
        details: `KimiClaw not reachable at ${this.endpoint}. Run: docker compose up -d`,
      };
    }
  }
}
