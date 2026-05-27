/**
 * KimiCodeToolLoopProtocol (extension-side, renderer-safe).
 *
 * Stateful multi-turn conversation manager for the kimi-code-agent provider.
 * Mirrors packages/extensions/gemini-antigravity/src/AntigravityToolLoopProtocol.ts.
 *
 * Although Moonshot Kimi natively supports OpenAI-style `tools` /
 * `tool_choice` in /v1/chat/completions, this protocol uses the same
 * prompt-injection approach gemini's antigravity provider uses (tools are
 * injected as a structured block in the system prompt, model is instructed to
 * reply with a {"tool_call":{...}} JSON envelope). This deliberately mirrors
 * gemini's shape for review parity. Migration to native function calling is
 * intentionally deferred.
 *
 * TODO(reshape): once the aiAgentProviders + backendModules SDK lands and the
 * gemini extension is reshaped, switch this protocol to use Moonshot's native
 * tools / tool_choice on /v1/chat/completions. K2.6 supports them and the
 * round-trip would drop the JSON-envelope parsing layer entirely. The host's
 * agent contract (get-tools / execute-tool IPC) doesn't change.
 */

import { KimiCodeRpcClient, type KimiCodeChatMessage } from './kimiCodeRpcClient';

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProtocolMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

export class KimiCodeToolLoopProtocol {
  private modelId: string;
  private readonly maxIterations: number;
  private history: ProtocolMessage[] = [];
  private aborted = false;

  constructor(opts: { modelId: string; maxIterations?: number }) {
    this.modelId = opts.modelId;
    this.maxIterations = opts.maxIterations ?? 40;
  }

  setModelId(modelId: string): void {
    this.modelId = modelId;
  }

  reset(): void {
    this.history = [];
    this.aborted = false;
  }

  seedHistory(messages: Array<{
    role?: string;
    content?: string;
    toolCall?: { name?: string; result?: unknown };
  }>): void {
    this.history = [];
    for (const msg of messages) {
      const role = msg.role;
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (role === 'user') {
        if (content.trim()) this.history.push({ role: 'user', content });
      } else if (role === 'assistant') {
        if (content.trim()) this.history.push({ role: 'assistant', content });
      } else if (role === 'tool') {
        const toolName = msg.toolCall?.name ?? 'unknown';
        const resultText = content.trim()
          ? content
          : (msg.toolCall?.result !== undefined
              ? (typeof msg.toolCall.result === 'string'
                  ? msg.toolCall.result
                  : JSON.stringify(msg.toolCall.result))
              : '');
        if (resultText) {
          this.history.push({ role: 'tool', content: resultText, toolName });
        }
      }
    }
    this.aborted = false;
  }

  abort(): void {
    this.aborted = true;
  }

  async *run(
    userMessage: string,
    systemPrompt: string,
    tools: OpenAITool[],
    executeToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    timeoutMs = 120_000
  ): AsyncGenerator<
    | { type: 'text'; content: string }
    | { type: 'tool_call'; name: string; args: Record<string, unknown> }
    | { type: 'tool_result'; name: string; result: string }
    | { type: 'complete' }
  > {
    this.aborted = false;
    this.history.push({ role: 'user', content: userMessage });

    const fullSystemPrompt = this.buildInstructedSystemPrompt(systemPrompt, tools);

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (this.aborted) return;

      const messages = this.buildMessages(fullSystemPrompt);
      const response = await KimiCodeRpcClient.complete({
        messages,
        model: this.modelId,
        timeoutMs,
      });

      if (this.aborted) return;

      const toolCall = this.parseToolCall(response);
      if (!toolCall) {
        const text = this.stripToolCallJson(response).trim();
        this.history.push({ role: 'assistant', content: text });
        yield { type: 'text', content: text };
        yield { type: 'complete' };
        return;
      }

      const thinkingText = this.stripToolCallJson(response).trim();
      const assistantEntry = thinkingText
        ? `${thinkingText}\n[Tool call: ${toolCall.name}]`
        : `[Tool call: ${toolCall.name}]`;
      this.history.push({ role: 'assistant', content: assistantEntry });

      yield { type: 'tool_call', name: toolCall.name, args: toolCall.arguments };

      let resultText: string;
      try {
        const rawResult = await executeToolCall(toolCall.name, toolCall.arguments);
        resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
      } catch (err) {
        resultText = JSON.stringify({
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (this.aborted) return;

      this.history.push({ role: 'tool', content: resultText, toolName: toolCall.name });
      yield { type: 'tool_result', name: toolCall.name, result: resultText };
    }

    yield { type: 'text', content: '[Agent reached tool-call iteration limit]' };
    yield { type: 'complete' };
  }

  // ---- Prompt construction ------------------------------------------------

  private buildInstructedSystemPrompt(baseSystemPrompt: string, tools: OpenAITool[]): string {
    if (tools.length === 0) {
      return baseSystemPrompt;
    }

    const toolSchemas = tools.map(t => ({
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? {},
    }));

    const toolBlock = [
      '## Available Tools',
      '',
      'You may call tools to help accomplish tasks. When you want to call a tool,',
      'respond with ONLY the following JSON block (no markdown fences, no extra text',
      'before or after it):',
      '',
      '{"tool_call":{"name":"<tool_name>","arguments":{...}}}',
      '',
      'After the tool runs, you will receive the result and can continue. When you',
      'are done with tool calls and ready to give your final answer, respond with',
      'plain text only (no JSON tool_call block).',
      '',
      '### Tool Definitions',
      '```json',
      JSON.stringify(toolSchemas, null, 2),
      '```',
    ].join('\n');

    return `${toolBlock}\n\n${baseSystemPrompt}`;
  }

  /**
   * Convert the in-memory history into a real OpenAI-shaped messages array.
   * Tool results are folded into user-role turns so we don't need tool_call_id
   * plumbing (matches the prompt-injection contract above; the model receives
   * tool results as natural-language user turns prefixed with "Tool result").
   */
  private buildMessages(systemPrompt: string): KimiCodeChatMessage[] {
    const out: KimiCodeChatMessage[] = [{ role: 'system', content: systemPrompt }];
    for (const msg of this.history) {
      if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (msg.role === 'tool') {
        out.push({
          role: 'user',
          content: `Tool result (${msg.toolName ?? 'unknown'}): ${msg.content}`,
        });
      }
    }
    return out;
  }

  // ---- Response parsing ---------------------------------------------------

  parseToolCall(response: string): ToolCallRequest | null {
    if (!response.includes('tool_call')) return null;

    const stripped = response.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    const keyIdx = stripped.search(/"tool_call"\s*:/);
    if (keyIdx === -1) return null;

    let openBrace = keyIdx - 1;
    while (openBrace >= 0 && stripped[openBrace] !== '{') {
      openBrace--;
    }
    if (openBrace < 0) return null;

    let depth = 0;
    let closeIdx = openBrace;
    for (let i = openBrace; i < stripped.length; i++) {
      if (stripped[i] === '{') depth++;
      else if (stripped[i] === '}') {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    if (depth !== 0) return null;

    const candidate = stripped.slice(openBrace, closeIdx + 1);
    try {
      const parsed = JSON.parse(candidate) as { tool_call?: { name?: unknown; arguments?: unknown } };
      const tc = parsed.tool_call;
      if (!tc || typeof tc.name !== 'string') return null;

      const args: Record<string, unknown> =
        typeof tc.arguments === 'object' && tc.arguments !== null
          ? tc.arguments as Record<string, unknown>
          : {};

      return { name: tc.name, arguments: args };
    } catch {
      return null;
    }
  }

  private stripToolCallJson(response: string): string {
    if (!response.includes('tool_call')) return response;
    let cleaned = response.replace(/```json\s*\{"tool_call"[\s\S]*?\}\s*```/g, '');
    cleaned = cleaned.replace(/\{[^{}]*"tool_call"\s*:[^{}]*(\{[^{}]*\})[^{}]*\}/g, '');
    cleaned = cleaned.replace(/\{.*"tool_call".*\}/g, '');
    return cleaned.trim();
  }
}
