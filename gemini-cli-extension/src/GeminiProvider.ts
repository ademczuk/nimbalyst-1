/**
 * Google Gemini CLI Provider (standalone, pure transport)
 *
 * Ported from packages/runtime/src/ai/server/providers/GeminiCLIProvider.ts,
 * stripped to PURE TRANSPORT for the renderer-side extension-provider bridge.
 *
 * What this does NOT do (the main-side handler owns persistence):
 *   - No DB writes, no logAgentMessage, no sessionManager, no transcript adapter.
 *   - No execFileSync "is installed" probe, no PATH resolution, no shell env
 *     scrubbing (the main spawn bridge runs the .cmd shim + inherits env).
 *
 * What it DOES:
 *   - Runs `gemini --acp` over the host-provided spawn (via GeminiACPProtocol).
 *   - Maps ACP ProtocolEvents to StreamChunks (text / tool_call / error /
 *     complete + usage).
 *   - Emits 'promptAdditions' exactly where the original did.
 *   - Tracks the ACP session id IN MEMORY (per Nimbalyst sessionId) so a
 *     follow-up turn resumes the same gemini session.
 *   - Keeps the 512-function-declaration MCP fallback: on that specific
 *     rejection it retries the turn once with MCP tools dropped.
 */

import type { StreamChunk } from '@nimbalyst/runtime/ai/server';
import { GeminiACPProtocol, type HostSpawn } from './GeminiACPProtocol';
import type { ProtocolEvent, ProtocolSession } from './protocolTypes';
import { buildUserMessageAddition, type MinimalDocumentContext } from './documentContextUtils';
import { TinyEmitter } from './emitter';

/** Host capability surface handed to the provider by the turn bridge. */
export interface GeminiProviderHost {
  spawn: HostSpawn;
}

interface ProviderConfigLike {
  model?: string;
  apiKey?: string;
  [key: string]: unknown;
}

const DEFAULT_MODEL = 'gemini-cli:default';

export class GeminiProvider {
  private readonly emitter = new TinyEmitter();
  private readonly protocol: GeminiACPProtocol;

  private config: ProviderConfigLike = {};

  /**
   * In-memory map of Nimbalyst sessionId -> ACP providerSessionId. This is the
   * ONLY session state we keep; the host persists the conversation from the
   * streamed chunks. Lives only for the lifetime of this provider instance
   * (one per session in the turn bridge).
   */
  private readonly providerSessions = new Map<string, string>();

  private abortController: AbortController | null = null;

  constructor(host: GeminiProviderHost) {
    this.protocol = new GeminiACPProtocol(host.spawn);
  }

  // --- EventEmitter surface (the bridge calls inst.on(...)) ---

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.emitter.off(event, listener);
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args);
  }

  // --- Lifecycle ---

  async initialize(config: unknown): Promise<void> {
    // gemini uses CLI OAuth, so apiKey is generally unused. Store whatever the
    // host hands us (model, etc.).
    this.config = (config as ProviderConfigLike) || {};
  }

  // --- In-memory provider session data (no DB) ---

  setProviderSessionData(sessionId: string, data: unknown): void {
    const providerSessionId = (data as { providerSessionId?: string } | undefined)?.providerSessionId;
    if (typeof providerSessionId === 'string' && providerSessionId) {
      this.providerSessions.set(sessionId, providerSessionId);
    }
  }

  getProviderSessionData(sessionId: string): { providerSessionId?: string } {
    const providerSessionId = this.providerSessions.get(sessionId);
    return { providerSessionId };
  }

  abort(): void {
    this.abortController?.abort();
    // Tear down the ACP process so a stalled turn can't keep the child alive.
    try {
      this.protocol.destroy();
    } catch {
      // ignore
    }
  }

  destroy(): void {
    this.abort();
    this.emitter.removeAllListeners();
  }

  // --- The turn ---

  async *sendMessage(
    message: string,
    documentContext?: unknown,
    sessionId?: string,
    _messages?: unknown[],
    workspacePath?: string,
    attachments?: unknown[],
    // Internal: set on the self-retry after Gemini rejects the request for
    // exceeding its 512 function-declaration limit. Drops MCP tools for the retry.
    forceNoMcp: boolean = false
  ): AsyncIterableIterator<StreamChunk> {
    if (!workspacePath) {
      yield { type: 'error', error: '[GeminiProvider] workspacePath is required but was not provided' };
      return;
    }

    const docCtx = (documentContext as MinimalDocumentContext | undefined) || undefined;

    // TODO(system-prompt): the core provider injected a Claude-Code-style system
    // prompt via buildClaudeCodeSystemPrompt (runtime-internal, not renderer-safe).
    // Pure transport leaves it empty; the host can prepend a system prompt before
    // delegating if it wants one.
    const systemPrompt = '';
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(message, docCtx);

    if (sessionId && (systemPrompt || userMessageAddition) && !forceNoMcp) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    const prompt = messageWithContext;

    const abortController = new AbortController();
    this.abortController = abortController;

    let fullText = '';

    try {
      const existingSessionId = sessionId ? this.providerSessions.get(sessionId) : undefined;

      // TODO(mcp): the core provider sourced MCP servers from McpConfigService,
      // which needs main-only ports/loaders (mcpServerPort, shellEnvironmentLoader,
      // etc.) that are not available in the renderer. Pure transport runs with no
      // MCP servers for now. When a renderer-safe MCP config channel exists, plumb
      // it in here (and the 512-fallback below stays as the guard).
      const mcpServers: Record<string, unknown> = {};

      const resolvedModel = this.config?.model || DEFAULT_MODEL;
      // On the no-MCP retry, force a fresh session so the resumed session's
      // already-registered tools don't re-trigger the 512 limit.
      const isResumedSession = !forceNoMcp && !!existingSessionId;

      const sessionOptions = {
        workspacePath,
        model: resolvedModel,
        systemPrompt,
        mcpServers,
      };

      const session: ProtocolSession = isResumedSession
        ? await this.protocol.resumeSession(existingSessionId as string, sessionOptions)
        : await this.protocol.createSession(sessionOptions);

      for await (const event of this.protocol.sendMessage(session, {
        content: prompt,
        attachments: attachments as unknown[] | undefined,
        sessionId,
        mode: docCtx?.mode === 'planning' ? 'planning' : 'agent',
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Operation cancelled');
        }

        const chunkOrRetry = this.mapEventToChunk(event, fullText, forceNoMcp);
        if (chunkOrRetry === 'retry-no-mcp') {
          console.warn('[GeminiProvider] Gemini rejected the request: MCP tools exceed the 512 function-declaration limit. Retrying this turn without MCP tools.');
          yield* this.sendMessage(message, documentContext, sessionId, _messages, workspacePath, attachments, true);
          return;
        }
        if (!chunkOrRetry) continue;

        if (chunkOrRetry.type === 'text' && chunkOrRetry.content) {
          fullText += chunkOrRetry.content;
        }
        yield chunkOrRetry;
      }

      if (sessionId && session.id && session.id !== existingSessionId) {
        this.providerSessions.set(sessionId, session.id);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(errorMessage);
      if (!isAbort) {
        if (/process exited|ENOENT|spawn.*gemini/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'Google Gemini CLI is not installed or failed to start. Install it globally with:\n\n' +
              '  npm install -g @google/gemini-cli\n\n' +
              'Then run `gemini` in your terminal and complete the OAuth login flow.',
          };
        } else if (/auth|login|token|unauthorized|forbidden|credentials/i.test(errorMessage)) {
          yield {
            type: 'error',
            error: 'Google Gemini CLI is not logged in. Run `gemini` in your terminal and complete the OAuth login flow.',
            isAuthError: true,
          };
        } else if (!forceNoMcp && !fullText && /At most 512 function declarations/i.test(errorMessage)) {
          console.warn('[GeminiProvider] Gemini rejected the request: MCP tools exceed the 512 function-declaration limit. Retrying this turn without MCP tools.');
          yield* this.sendMessage(message, documentContext, sessionId, _messages, workspacePath, attachments, true);
          return;
        } else {
          yield { type: 'error', error: errorMessage };
        }
      }
    } finally {
      if (this.abortController === abortController) {
        this.abortController = null;
      }
    }
  }

  /**
   * Map a single ACP ProtocolEvent to a StreamChunk (or signal a no-MCP retry,
   * or null to skip). Replaces the core provider's AgentProtocolTranscriptAdapter
   * for the transport-only path.
   */
  private mapEventToChunk(
    event: ProtocolEvent,
    fullTextSoFar: string,
    forceNoMcp: boolean
  ): StreamChunk | 'retry-no-mcp' | null {
    switch (event.type) {
      case 'text':
        if (event.content) {
          return { type: 'text', content: event.content };
        }
        return null;

      case 'tool_call':
        if (event.toolCall) {
          return {
            type: 'tool_call',
            toolCall: {
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments as Record<string, unknown> | undefined,
            },
          };
        }
        return null;

      case 'complete':
        return {
          type: 'complete',
          content: event.content,
          isComplete: true,
          usage: event.usage,
        };

      case 'error': {
        const msg = event.error ?? 'Unknown error';
        if (!forceNoMcp && !fullTextSoFar && /At most 512 function declarations/i.test(msg)) {
          return 'retry-no-mcp';
        }
        return { type: 'error', error: msg };
      }

      // raw_event / reasoning / tool_result / usage carry no StreamChunk in the
      // transport-only mapping (the host reconstructs from text/tool_call/complete).
      default:
        return null;
    }
  }
}
