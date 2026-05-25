/**
 * AntigravityProvider
 *
 * A CHAT provider (extends BaseAIProvider) that serves Google's Gemini models via
 * the Antigravity language server's GetModelResponse RPC. Default model is
 * "Gemini 3.5 Flash (High)". No MCP, no file tools, no resumable session - a
 * single prompt + attached document context -> text response.
 *
 * Modeled on LMStudioProvider (the other localhost-endpoint chat provider). The
 * server lifecycle and RPC live in AntigravityServerManager; usage/quota in
 * AntigravityUsageMeter.
 *
 * Auth rides the user's ~/.gemini login (no nimbalyst API key; no browser OAuth).
 *
 * v1 is non-streaming: GetModelResponse returns the whole text in one call, so we
 * yield a single text chunk + complete. (capabilities.streaming = false.)
 */
import { BaseAIProvider } from '../../AIProvider';
import {
  DocumentContext,
  ProviderConfig,
  ProviderCapabilities,
  StreamChunk,
  AIModel,
} from '../../types';
import { buildUserMessageAddition } from '../documentContextUtils';
import { AntigravityServerManager, AntigravityModelInfo } from './AntigravityServerManager';

const PROVIDER_ID = 'antigravity-gemini';

/** Stable model KEY for "Gemini 3.5 Flash (High)" (resolve enum at runtime). */
export const ANTIGRAVITY_FLASH35_HIGH_KEY = 'gemini-3-flash-agent';

/** Model keys this provider surfaces to nimbalyst (stable across builds). */
const SURFACED_MODEL_KEYS = new Set<string>([
  'gemini-3-flash-agent',       // Gemini 3.5 Flash (High)
  'gemini-3.5-flash-low',       // Gemini 3.5 Flash (Medium)
  'gemini-3.5-flash-extra-low', // Gemini 3.5 Flash (Low)
]);

interface AntigravityConfig extends ProviderConfig {
  /** Optional override of the default model key. */
  model?: string;
}

export class AntigravityProvider extends BaseAIProvider {
  static readonly DEFAULT_MODEL = ANTIGRAVITY_FLASH35_HIGH_KEY;

  private server: AntigravityServerManager = AntigravityServerManager.shared();
  private modelKey: string = AntigravityProvider.DEFAULT_MODEL;
  private aborted = false;

  async initialize(config: AntigravityConfig): Promise<void> {
    this.config = config;
    if (config.model) {
      // Accept either the provider-prefixed id (antigravity-gemini:key) or a bare key.
      this.modelKey = config.model.includes(':')
        ? config.model.split(':').slice(1).join(':')
        : config.model;
    }
    // Validate connectivity early so misconfiguration surfaces before first send.
    await this.server.ensureRunning();
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: false,       // GetModelResponse returns the whole response at once
      tools: false,           // no native function-calling via this RPC
      mcpSupport: false,
      edits: false,
      resumeSession: false,
      supportsFileTools: false, // attach docs as context, don't expose file tools
    };
  }

  abort(): void {
    // No streaming connection to cancel; mark aborted so an in-flight yield is dropped.
    this.aborted = true;
  }

  destroy(): void {
    this.abort();
    // Do not stop the shared server here; other sessions may be using it. The
    // server is stopped at app shutdown / provider-disable by the owner.
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    _messages?: any[],
    _workspacePath?: string,
    attachments?: any[],
  ): AsyncIterableIterator<StreamChunk> {
    this.aborted = false;

    const systemPrompt = this.buildSystemPrompt(documentContext);
    const { userMessageAddition, messageWithContext } = buildUserMessageAddition(
      message, documentContext);
    const fullMessage = messageWithContext;

    if (!fullMessage || fullMessage.trim() === '') {
      throw new Error('Cannot send empty message to Antigravity');
    }

    // Emit prompt additions for the debugging UI (mirrors LMStudioProvider).
    if (sessionId && (systemPrompt || userMessageAddition)) {
      this.emit('promptAdditions', {
        sessionId,
        systemPromptAddition: systemPrompt || null,
        userMessageAddition,
        attachments: [],
        timestamp: Date.now(),
      });
    }

    // GetModelResponse takes a single prompt string. Prepend the system prompt so
    // the model still gets it (the RPC has no separate system slot).
    const prompt = systemPrompt
      ? `${systemPrompt}\n\n${fullMessage}`
      : fullMessage;

    try {
      const text = await this.server.getModelResponse(prompt, this.modelKey);

      if (this.aborted) return;

      if (text) {
        yield { type: 'text', content: text };
      }

      if (sessionId && text) {
        await this.logAgentMessage(sessionId, PROVIDER_ID, 'output', text);
      }

      yield { type: 'complete', content: text, isComplete: true };
    } catch (err: any) {
      if (this.aborted) return;
      this.logError(sessionId, PROVIDER_ID, err instanceof Error ? err : new Error(String(err)),
        'getModelResponse');
      yield {
        type: 'error',
        content: err?.message || String(err),
      };
    }
  }

  /**
   * Discover the models this provider exposes (stable keys -> AIModel). Surfaces
   * the Gemini 3.5 Flash family by default. Static so the settings UI can call it
   * without an initialized provider.
   */
  static async getModels(): Promise<AIModel[]> {
    const server = AntigravityServerManager.shared();
    const catalog = await server.getAvailableModels();
    const models: AIModel[] = [];
    for (const [key, info] of catalog.entries()) {
      if (!SURFACED_MODEL_KEYS.has(key)) continue;
      models.push(AntigravityProvider.toAIModel(key, info));
    }
    // Stable order: High, Medium, Low.
    const order = ['gemini-3-flash-agent', 'gemini-3.5-flash-low', 'gemini-3.5-flash-extra-low'];
    models.sort((a, b) => order.indexOf(stripPrefix(a.id)) - order.indexOf(stripPrefix(b.id)));
    return models;
  }

  private static toAIModel(key: string, info: AntigravityModelInfo): AIModel {
    return {
      id: `${PROVIDER_ID}:${key}`,
      name: info.displayName || key,
      provider: PROVIDER_ID as AIModel['provider'],
      maxTokens: info.maxTokens,
      contextWindow: info.maxTokens,
    };
  }
}

function stripPrefix(id: string): string {
  return id.includes(':') ? id.split(':').slice(1).join(':') : id;
}
