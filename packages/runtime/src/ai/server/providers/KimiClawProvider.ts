/**
 * KimiClaw Agent Provider
 *
 * Integrates KimiClawSwarm (KCS) -- a local Flask HTTP server in Docker
 * on 127.0.0.1:9643 -- into Nimbalyst.
 *
 * Key features:
 * - HTTP+SSE transport (no subprocess management needed)
 * - Cookie or Bearer token auth
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
} from '../protocols/KimiClawProtocol';
import { safeJSONSerialize } from '../../../utils/serialization';
import { AgentProtocolTranscriptAdapter } from './agentProtocol/AgentProtocolTranscriptAdapter';
import { McpConfigService } from '../services/McpConfigService';

interface KimiClawProviderDeps {
  protocol?: KimiClawProtocol;
}

export class KimiClawProvider extends BaseAgentProvider {
  private protocol: KimiClawProtocol;

  // Configuration (set via initialize)
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

  // Analytics initialization data
  private readonly mcpConfigService: McpConfigService;

  private _initData: {
    model: string;
    isResumedSession: boolean;
  } | null = null;

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
    this.mcpConfigService = new McpConfigService();
  }

  getProviderName(): string {
    return 'kimiclaw';
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      tools: false,
      mcpSupport: false,
      edits: false,
      resumeSession: false,
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
    // @ts-expect-error -- custom config fields not in base ProviderConfig
    if (config.endpoint || config.baseUrl) this.endpoint = config.endpoint || config.baseUrl;
    // @ts-expect-error
    if (config.authMode) this.authMode = config.authMode;
    // @ts-expect-error
    if (config.username) this.username = config.username;
    // @ts-expect-error
    if (config.password) this.password = config.password;
    // @ts-expect-error
    if (config.bearerToken) this.bearerToken = config.bearerToken;
    // @ts-expect-error
    if (config.personaMode !== undefined) this.swarmDefaults.persona_mode = config.personaMode;
    // @ts-expect-error
    if (config.maxAgents !== undefined) this.swarmDefaults.max_agents = config.maxAgents;
    // @ts-expect-error
    if (config.maxSteps !== undefined) this.swarmDefaults.max_steps = config.maxSteps;
    // @ts-expect-error
    if (config.maxParallel !== undefined) this.swarmDefaults.max_parallel = config.maxParallel;

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
    _messages?: any[],
    workspacePath?: string,
    attachments?: ChatAttachment[]
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: '[KimiClawProvider] workspacePath is required but was not provided' };
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

    if (sessionId) {
      await this.logAgentMessageBestEffort(sessionId, 'input', messageWithContext);
    }

    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      // Get or create protocol session
      const existingSessionId = this.sessions.getSessionId(sessionId || '');
      console.log('[KIMICLAW] Session lookup:', {
        sessionId,
        existingSessionId,
        action: existingSessionId ? 'RESUME' : 'CREATE'
      });

      // Fix D: Collect MCP servers for passthrough to KCS
      let mcpServers: Record<string, any> | undefined;
      try {
        mcpServers = await this.mcpConfigService.getMcpServersConfig({ sessionId, workspacePath });
      } catch {
        // MCP not available, proceed without
      }

      const sessionOptions = {
        workspacePath,
        model: this.config?.model || 'default',
        mcpServers,
        raw: {
          endpoint: this.endpoint,
          authMode: this.authMode,
          username: this.username,
          password: this.password,
          bearerToken: this.bearerToken,
          swarmDefaults: this.swarmDefaults,
          mcpServers,
        },
      };

      const isResumedSession = !!existingSessionId;
      const session = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      // Store initialization data for analytics
      this._initData = {
        model: this.config?.model || 'default',
        isResumedSession,
      };

      console.log('[KIMICLAW] Session after create/resume:', {
        sessionId,
        protocolSessionId: session.id,
        existingSessionId
      });

      // Create transcript adapter as event parser
      const transcriptAdapter = new AgentProtocolTranscriptAdapter(null, sessionId ?? '');

      transcriptAdapter.userMessage(
        messageWithContext,
        documentContext?.mode === 'planning' ? 'planning' : 'agent',
        attachments as any,
      );

      // Send message using protocol -- adapter parses all events
      for await (const event of this.protocol.sendMessage(session, {
        content: messageWithContext,
        attachments,
        sessionId,
        mode: documentContext?.mode || 'agent',
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        // Store raw KCS SSE events for transcript reconstruction
        if (sessionId && event.type === 'raw_event') {
          const rawSseEvent = (event.metadata as { rawEvent?: unknown } | undefined)?.rawEvent;
          if (rawSseEvent !== undefined) {
            const { content } = safeJSONSerialize(rawSseEvent);
            const sseEventType = typeof (rawSseEvent as { type?: unknown }).type === 'string'
              ? (rawSseEvent as { type: string }).type
              : 'unknown';
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
      }

      // Capture session ID after stream completes
      if (sessionId && session.id) {
        if (session.id !== existingSessionId) {
          console.log('[KIMICLAW] Saving provider session ID:', {
            nimbalystSessionId: sessionId,
            providerSessionId: session.id,
          });
          this.sessions.setProviderSessionData(sessionId, {
            providerSessionId: session.id,
            platform: 'kimiclaw',
          });
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);

      if (!isAbort) {
        console.error('[KIMICLAW] Error in sendMessage:', errorMessage);
        yield { type: 'error', error: errorMessage };
        await this.logAgentMessageBestEffort(sessionId || 'unknown', 'output', errorMessage, {
          metadata: { isError: true },
          hidden: false,
          searchable: false,
        });
      }
    } finally {
      this.abortController = null;
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

  static setEndpoint(endpoint: string): void {
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
          : `KimiClaw not reachable at ${this.endpoint}. Run: docker compose up -d in your KCS repo`,
      };
    } catch {
      return {
        installed: false,
        details: `KimiClaw not reachable at ${this.endpoint}. Run: docker compose up -d in your KCS repo`,
      };
    }
  }

  /**
   * Process transcript messages for incremental transcript transformation.
   * Called after logging raw events so canonical events appear during streaming.
   */
  private async processTranscriptMessages(sessionId: string): Promise<void> {
    try {
      const { TranscriptEventRepository } = await import('../../../storage/repositories/TranscriptEventRepository');
      const { TranscriptMigrationRepository } = await import('../../../storage/repositories/TranscriptMigrationRepository');
      const transformer = new (await import('../../../storage/transformers/TranscriptTransformer')).TranscriptTransformer(
        new TranscriptEventRepository(),
        new TranscriptMigrationRepository(),
      );
      await transformer.processEventsForSession(sessionId);
    } catch (error) {
      console.error('[KIMICLAW] Error processing transcript messages:', error);
    }
  }
}
