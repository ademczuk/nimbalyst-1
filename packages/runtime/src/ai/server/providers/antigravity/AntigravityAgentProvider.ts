/**
 * AntigravityAgentProvider
 *
 * AGENT provider (extends BaseAgentProvider) that surfaces Gemini 3.5 Flash
 * under "Agent Providers" alongside Claude Agent, OpenAI Codex, OpenCode, and
 * GitHub Copilot. Supports tool-calling and meta-agent mode.
 *
 * Architecture (Option C: Nimbalyst-orchestrated tool loop):
 *   - Uses AntigravityServerManager.getModelResponse() for each loop iteration
 *   - Injects tool schemas as JSON in the system prompt
 *   - Parses function-call JSON blocks from the model response
 *   - Executes tools via BaseAIProvider.executeToolCall()
 *   - Loops until no function call is present in the response
 *
 * Meta-agent mode:
 *   - Reads agentRole from the DB via getAgentRole()
 *   - When role === 'meta-agent': uses buildMetaAgentSystemPrompt() and restricts
 *     tools to BaseAgentProvider.META_AGENT_ALLOWED_TOOLS
 *
 * Auth rides the user's ~/.gemini login (no nimbalyst API key). See
 * AntigravityServerManager for server lifecycle and RPC details.
 *
 * Provider ID: 'antigravity-gemini-agent'
 * Default model: 'gemini-3-flash-agent' (stable key for Gemini 3.5 Flash High)
 */

import { BaseAgentProvider } from '../BaseAgentProvider';
import { buildUserMessageAddition } from '../documentContextUtils';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt } from '../../../prompt';
import {
  ProviderConfig,
  ProviderCapabilities,
  DocumentContext,
  StreamChunk,
  AIModel,
  AIProviderType,
} from '../../types';
import { ProviderSessionData } from '../ProviderSessionManager';
import { AntigravityServerManager, AntigravityModelInfo } from './AntigravityServerManager';
import {
  AntigravityToolLoopProtocol,
} from './AntigravityToolLoopProtocol';

const PROVIDER_ID = 'antigravity-gemini-agent';

/** Stable model key for Gemini 3.5 Flash High. */
export const ANTIGRAVITY_AGENT_DEFAULT_KEY = 'gemini-3-flash-agent';

/** Which model keys from the catalog this agent provider surfaces. */
const SURFACED_MODEL_KEYS = new Set<string>([
  'gemini-3-flash-agent',       // Gemini 3.5 Flash (High)
  'gemini-3.5-flash-low',       // Gemini 3.5 Flash (Medium)
]);

interface AntigravityAgentConfig extends ProviderConfig {
  model?: string;
}

export class AntigravityAgentProvider extends BaseAgentProvider {
  static readonly DEFAULT_MODEL = ANTIGRAVITY_AGENT_DEFAULT_KEY;

  private readonly server: AntigravityServerManager = AntigravityServerManager.shared();
  private readonly toolLoop: AntigravityToolLoopProtocol;
  private modelKey: string = AntigravityAgentProvider.DEFAULT_MODEL;

  constructor() {
    super();
    this.toolLoop = new AntigravityToolLoopProtocol({
      server: this.server,
      modelKey: this.modelKey,
    });
  }

  getProviderName(): string {
    return PROVIDER_ID;
  }

  async initialize(config: AntigravityAgentConfig): Promise<void> {
    this.config = config;
    if (config.model) {
      // Accept either 'antigravity-gemini-agent:key' or a bare key.
      this.modelKey = config.model.includes(':')
        ? config.model.split(':').slice(1).join(':')
        : config.model;
    }
    // Re-create the tool loop with the resolved model key.
    (this.toolLoop as any).modelKey = this.modelKey;
    await this.server.ensureRunning();
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: false,         // tool loop yields steps, not a true streaming transport
      tools: true,
      mcpSupport: false,        // tool loop uses nimbalyst's own tool registry, not MCP passthrough
      edits: true,
      resumeSession: true,      // history is rebuilt each turn from session messages (seedHistory)
      supportsFileTools: true,
    };
  }

  abort(): void {
    this.toolLoop.abort();
    super.abort();
  }

  destroy(): void {
    this.toolLoop.abort();
    super.destroy();
  }

  // ---- Session data -------------------------------------------------------

  getProviderSessionData(sessionId: string): ProviderSessionData | null {
    return this.sessions.getProviderSessionData(sessionId);
  }

  // ---- sendMessage --------------------------------------------------------

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: any[],
    _workspacePath?: string,
    _attachments?: any[],
  ): AsyncIterableIterator<StreamChunk> {
    if (sessionId) {
      this.abortController = new AbortController();
    }

    // Diagnostic entry log so we can see this provider's sendMessage is reached.
    // Without this, the silent no-response bug was indistinguishable from the IPC
    // never arriving at the provider.
    console.log(`[AntigravityAgentProvider] sendMessage entry: sessionId=${sessionId} modelKey=${this.modelKey} messageLen=${message.length}`);

    try {
      // Log the incoming user message.
      if (sessionId) {
        await this.logAgentMessage(sessionId, PROVIDER_ID, 'input', message,
          undefined, false, undefined, true);
      }

      // Determine whether this is a meta-agent session.
      const agentRole = await this.getAgentRole(sessionId);
      const isMetaAgent = agentRole === 'meta-agent';

      // Build system prompt (meta-agent or standard).
      const systemPrompt = isMetaAgent
        ? buildMetaAgentSystemPrompt('claude', 'default', {
            provider: PROVIDER_ID,
            model: this.modelKey,
          })
        : this.buildStandardSystemPrompt(documentContext);

      // Collect the tool definitions for this turn.
      // Meta-agent mode restricts to the allowed set; standard mode gets all tools.
      const allTools = this.getToolsInOpenAIFormat() as Array<{
        type: 'function';
        function: { name: string; description?: string; parameters?: Record<string, unknown> };
      }>;

      const allowedSet = isMetaAgent
        ? new Set(BaseAgentProvider.META_AGENT_ALLOWED_TOOLS)
        : null;

      const tools = allowedSet
        ? allTools.filter(t => allowedSet.has(t.function.name))
        : allTools;

      console.log(`[AntigravityAgentProvider] meta-agent=${isMetaAgent} allTools=${allTools.length} filteredTools=${tools.length} systemPromptLen=${systemPrompt.length}`);

      // Emit prompt additions for the UI (mirrors LMStudioProvider / AntigravityProvider).
      const { userMessageAddition, messageWithContext } = buildUserMessageAddition(
        message, documentContext);

      if (sessionId && userMessageAddition) {
        this.emit('promptAdditions', {
          sessionId,
          systemPromptAddition: systemPrompt || null,
          userMessageAddition,
          attachments: [],
          timestamp: Date.now(),
        });
      }

      const userTurn = messageWithContext || message;

      // Seed the tool loop with prior conversation so multi-turn sessions keep
      // context (GetModelResponse is stateless). Drop a trailing user message
      // that duplicates this turn to avoid sending it twice -- run() appends the
      // current turn itself.
      const priorMessages = Array.isArray(messages) ? [...messages] : [];
      const lastPrior = priorMessages[priorMessages.length - 1];
      if (lastPrior && lastPrior.role === 'user' &&
          typeof lastPrior.content === 'string' &&
          lastPrior.content.trim() === message.trim()) {
        priorMessages.pop();
      }
      if (priorMessages.length > 0) {
        this.toolLoop.seedHistory(priorMessages);
      } else {
        this.toolLoop.reset();
      }

      // Run the tool loop.
      let finalText = '';
      let toolCallSeq = 0;
      let sawText = false;
      const lastToolResult = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();
      for await (const step of this.toolLoop.run(
        userTurn,
        systemPrompt,
        tools,
        (name, args) => this.executeToolCall(name, args),
      )) {
        if (this.abortController?.signal.aborted) break;

        if (step.type === 'tool_call') {
          // Mint a stable id per call so the result chunk can reference it.
          const id = `agy-${Date.now()}-${toolCallSeq++}`;
          lastToolResult.set(step.name, { id, name: step.name, args: step.args });
          yield {
            type: 'tool_call',
            toolCall: {
              id,
              name: step.name,
              arguments: step.args,
            },
          };
        } else if (step.type === 'tool_result') {
          // Re-emit the tool call now carrying its result, so the transcript
          // widget can show the executed call + output together (mirrors how
          // SDK providers attach a result to the same tool_use_id).
          const pending = lastToolResult.get(step.name);
          if (pending) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: pending.id,
                name: pending.name,
                arguments: pending.args,
                result: step.result,
              },
            };
            lastToolResult.delete(step.name);
          }
        } else if (step.type === 'text') {
          finalText = step.content;
          sawText = true;
          console.log(`[AntigravityAgentProvider] received text step: len=${finalText.length} preview=${JSON.stringify(finalText.slice(0, 120))}`);
          // ALWAYS yield a text chunk so the renderer's stream pipeline registers
          // the assistant's response. Dropping empty text chunks was the root
          // cause of the silent no-response bug: when GetModelResponse returns
          // whitespace or empty (which Gemini 3.5 Flash occasionally does on long
          // meta-agent system prompts with no tool calls available), the original
          // `if (finalText)` guard suppressed the chunk entirely and the renderer
          // never received `ai:streamResponse`, leaving the chat input "waiting".
          // Substitute a visible placeholder when empty so the user sees that the
          // turn completed.
          const renderedText = finalText.trim().length === 0
            ? '(model returned no text)'
            : finalText;
          yield { type: 'text', content: renderedText };
        } else if (step.type === 'complete') {
          // Log the assistant's final output. Persist the rendered text (which
          // includes the placeholder when the model produced nothing) so the
          // transcript on reload mirrors what the user saw during the turn.
          const persistedText = finalText.trim().length === 0
            ? (sawText ? '(model returned no text)' : '(no model response)')
            : finalText;
          if (sessionId) {
            await this.logAgentMessage(sessionId, PROVIDER_ID, 'output', persistedText,
              undefined, false, undefined, true);
          }
          console.log(`[AntigravityAgentProvider] sendMessage complete: sawText=${sawText} finalTextLen=${finalText.length} persistedLen=${persistedText.length}`);
          yield { type: 'complete', content: persistedText, isComplete: true };
        }
      }
    } catch (err: any) {
      if (this.abortController?.signal.aborted) return;
      this.logError(
        sessionId,
        PROVIDER_ID,
        err instanceof Error ? err : new Error(String(err)),
        'sendMessage',
      );
      yield { type: 'error', content: err?.message ?? String(err) };
    } finally {
      this.abortController = null;
    }
  }

  // ---- System prompt ------------------------------------------------------

  private buildStandardSystemPrompt(documentContext?: DocumentContext): string {
    return buildClaudeCodeSystemPrompt({
      hasSessionNaming: false,
      toolReferenceStyle: 'claude',
      worktreePath: documentContext?.worktreePath,
      isVoiceMode: (documentContext as any)?.isVoiceMode ?? false,
      voiceModeCodingAgentPrompt: (documentContext as any)?.voiceModeCodingAgentPrompt,
      enableAgentTeams: false,
    });
  }

  // ---- Model discovery ----------------------------------------------------

  static async getModels(): Promise<AIModel[]> {
    const server = AntigravityServerManager.shared();
    const catalog = await server.getAvailableModels();
    const models: AIModel[] = [];
    for (const [key, info] of catalog.entries()) {
      if (!SURFACED_MODEL_KEYS.has(key)) continue;
      models.push(AntigravityAgentProvider.toAIModel(key, info));
    }
    const order = ['gemini-3-flash-agent', 'gemini-3.5-flash-low'];
    models.sort((a, b) => order.indexOf(stripPrefix(a.id)) - order.indexOf(stripPrefix(b.id)));
    return models;
  }

  static getDefaultModel(): string {
    return `${PROVIDER_ID}:${AntigravityAgentProvider.DEFAULT_MODEL}`;
  }

  private static toAIModel(key: string, info: AntigravityModelInfo): AIModel {
    return {
      id: `${PROVIDER_ID}:${key}`,
      name: info.displayName ? `${info.displayName} (Agent)` : key,
      provider: PROVIDER_ID as AIProviderType,
      maxTokens: info.maxTokens,
      contextWindow: info.maxTokens,
    };
  }
}

function stripPrefix(id: string): string {
  return id.includes(':') ? id.split(':').slice(1).join(':') : id;
}
