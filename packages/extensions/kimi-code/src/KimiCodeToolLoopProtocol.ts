/**
 * KimiCodeToolLoopProtocol (extension-side, renderer-safe).
 *
 * Multi-turn agent loop using K2.6's native OpenAI-compatible function-
 * calling shape. Tools are passed as the `tools` parameter on
 * /v1/chat/completions; the model replies with `tool_calls` on the
 * assistant message; tool results are sent back in the next turn as
 * `role: 'tool'` messages tied to the originating `tool_call_id`.
 *
 * Migrated 2026-05-27 from the earlier JSON-envelope prompt-injection
 * protocol (mirrored from gemini-antigravity, which had to use a
 * prompt-injected envelope because the antigravity language server has
 * no native tool surface). K2.6 supports native tool_calls so the
 * injection layer is gone, along with the parser/stripper and the
 * synthetic `[Tool call: X]` placeholder text that was leaking into
 * the transcript renderer.
 */

import { KimiCodeRpcClient, type KimiCodeChatMessage, type KimiCodeToolCall, type KimiCodeToolDef } from './kimiCodeRpcClient';

export interface ToolCallStep {
  type: 'tool_call';
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultStep {
  type: 'tool_result';
  id: string;
  name: string;
  result: string;
}

export interface TextStep {
  type: 'text';
  content: string;
}

export interface CompleteStep {
  type: 'complete';
}

export type ProtocolStep = ToolCallStep | ToolResultStep | TextStep | CompleteStep;

/**
 * In-memory message history. Mirrors OpenAI's shape but keeps `toolName` as
 * a convenience field on tool results for callers that don't want to look
 * up the originating tool_call by id.
 */
interface ProtocolMessage {
  role: 'user' | 'assistant' | 'tool';
  /**
   * Optional on assistant turns that ONLY issued tool_calls (the Kimi API
   * rejects empty content alongside tool_calls). We persist undefined for
   * those turns and omit the key in buildMessages.
   */
  content?: string;
  /** Tool calls the assistant issued on this turn. */
  toolCalls?: KimiCodeToolCall[];
  /** Tool name; convenience field on 'tool' role. */
  toolName?: string;
  /** Required on 'tool' role; ties the result to an assistant tool_call. */
  toolCallId?: string;
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

  /**
   * Seed history from the host's session log when resuming a session. The
   * host's format carries role + content; for tool turns it carries a
   * compact `toolCall: { name, result }` blob. We convert those into the
   * native protocol shape - synthesizing tool_call_ids when missing so the
   * model sees a coherent thread.
   *
   * Note: seeded turns lose the original assistant `tool_calls` envelope
   * because the host doesn't persist it. The model will see the user's
   * prompt and the assistant's previous text answer, which is enough
   * context to continue.
   */
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
        if (!resultText) continue;
        // Synthesize an id so OpenAI shape is preserved; the model never
        // sees the seeded turns again because each fresh run() builds
        // messages from the live history forward.
        this.history.push({
          role: 'tool',
          content: resultText,
          toolName,
          toolCallId: `seed-${this.history.length}`,
        });
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
    tools: KimiCodeToolDef[],
    executeToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    timeoutMs = 120_000,
  ): AsyncGenerator<ProtocolStep> {
    this.aborted = false;
    this.history.push({ role: 'user', content: userMessage });

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (this.aborted) return;

      const messages = this.buildMessages(systemPrompt);
      const reply = await KimiCodeRpcClient.complete({
        messages,
        model: this.modelId,
        tools: tools.length > 0 ? tools : undefined,
        timeoutMs,
      });

      if (this.aborted) return;

      const text = reply.content?.trim() ?? '';
      const toolCalls = reply.toolCalls ?? [];

      // Persist the assistant turn. content is omitted when empty alongside
      // tool_calls per the API quirk (buildMessages enforces the omission).
      this.history.push({
        role: 'assistant',
        content: text.length > 0 ? text : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (text.length > 0) {
        yield { type: 'text', content: text };
      }

      if (toolCalls.length === 0) {
        // Conversation is done - the assistant gave a final text answer or
        // declined to use a tool. Either way we're out of the loop.
        yield { type: 'complete' };
        return;
      }

      // Execute each tool call the assistant issued. We run them
      // sequentially - K2.6 can issue multiple tool_calls per turn but the
      // meta-agent dispatch path is not built for parallel invocation, and
      // serial execution keeps the streamed UI predictable.
      for (const tc of toolCalls) {
        if (this.aborted) return;

        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          // Malformed JSON - pass an empty arg set rather than crashing.
          // The tool handler should surface its own validation error.
          parsedArgs = {};
        }

        yield { type: 'tool_call', id: tc.id, name: tc.function.name, args: parsedArgs };

        let resultText: string;
        try {
          const rawResult = await executeToolCall(tc.function.name, parsedArgs);
          resultText = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
        } catch (err) {
          resultText = JSON.stringify({
            isError: true,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        if (this.aborted) return;

        this.history.push({
          role: 'tool',
          content: resultText,
          toolName: tc.function.name,
          toolCallId: tc.id,
        });

        yield { type: 'tool_result', id: tc.id, name: tc.function.name, result: resultText };
      }
    }

    yield { type: 'text', content: '[Agent reached tool-call iteration limit]' };
    yield { type: 'complete' };
  }

  /**
   * Convert the in-memory history into a real OpenAI-shaped messages array.
   * - assistant turns with tool_calls but no text OMIT the content key (the
   *   Kimi endpoint returns 400 if `content` is present and empty alongside
   *   tool_calls; verified against the CLI's kimi.py source).
   * - tool turns carry tool_call_id + name + content.
   */
  private buildMessages(systemPrompt: string): KimiCodeChatMessage[] {
    const out: KimiCodeChatMessage[] = systemPrompt
      ? [{ role: 'system', content: systemPrompt }]
      : [];
    for (const msg of this.history) {
      if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content ?? '' });
      } else if (msg.role === 'assistant') {
        const entry: KimiCodeChatMessage = { role: 'assistant' };
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          entry.content = msg.content;
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          entry.tool_calls = msg.toolCalls;
        }
        out.push(entry);
      } else if (msg.role === 'tool') {
        out.push({
          role: 'tool',
          content: msg.content ?? '',
          tool_call_id: msg.toolCallId ?? '',
          name: msg.toolName,
        });
      }
    }
    return out;
  }
}
