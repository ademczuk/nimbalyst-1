/**
 * AntigravityToolLoopProtocol
 *
 * Stateful multi-turn conversation manager for the antigravity-gemini-agent provider.
 * Orchestrates a tool-call loop over GetModelResponse:
 *
 *   1. Build a system prompt that describes available tools as a JSON schema block.
 *   2. Send prompt to the model via AntigravityServerManager.getModelResponse().
 *   3. Parse the response for a function-call JSON block.
 *   4. If a function call is present: execute it, append result to conversation, repeat.
 *   5. If no function call: yield final text and exit.
 *
 * GetModelResponse has no native tool-calling surface, so tools are injected as a
 * structured block in the system prompt and the model is instructed to respond with
 * a specific JSON envelope when calling a tool. The protocol parser is intentionally
 * lenient to handle minor formatting variation in model output.
 *
 * MAX_TOOL_ITERATIONS caps the loop to prevent infinite cycles on misbehaving tool
 * sequences. The consumer should set a generous but finite budget (default: 40).
 */

import { AntigravityServerManager } from './AntigravityServerManager';

/** Shape returned by OpenAI-format tool conversion (subset we rely on). */
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
  toolName?: string;  // set on role=tool messages
}

export class AntigravityToolLoopProtocol {
  private readonly server: AntigravityServerManager;
  private readonly modelKey: string;
  private readonly maxIterations: number;
  private history: ProtocolMessage[] = [];
  private aborted = false;

  constructor(opts: {
    server: AntigravityServerManager;
    modelKey: string;
    maxIterations?: number;
  }) {
    this.server = opts.server;
    this.modelKey = opts.modelKey;
    this.maxIterations = opts.maxIterations ?? 40;
  }

  /** Reset conversation state for a new session turn. */
  reset(): void {
    this.history = [];
    this.aborted = false;
  }

  /**
   * Seed the conversation history from prior turns (for resumeSession support).
   *
   * GetModelResponse is stateless, so the agent provider rebuilds the running
   * conversation from the session's persisted messages on each turn. This maps
   * Nimbalyst's transcript-view messages into the protocol's compact history so
   * the model sees the prior dialogue when the next prompt is rendered.
   *
   * Pass the messages WITHOUT the current user turn -- `run()` appends that.
   * Empty-content messages and unknown roles are skipped.
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

  /**
   * Run one user turn through the tool loop.
   *
   * Yields individual steps so the caller can stream text and tool events:
   *   - { type: 'text', content }       -- final assistant text (no tool call)
   *   - { type: 'tool_call', name, args } -- tool about to be executed
   *   - { type: 'tool_result', name, result } -- tool result appended to context
   *   - { type: 'complete' }            -- loop finished
   *
   * @param userMessage   The user's message for this turn.
   * @param systemPrompt  Agent-level system prompt (role, meta-agent instructions, etc.).
   * @param tools         OpenAI-format tool definitions to inject into the prompt.
   * @param executeToolCall  Executor provided by the agent provider.
   * @param timeoutMs     Per-RPC timeout (default 120s).
   */
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

    // Append user message to history.
    this.history.push({ role: 'user', content: userMessage });

    const fullSystemPrompt = this.buildInstructedSystemPrompt(systemPrompt, tools);

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      if (this.aborted) return;

      const prompt = this.renderPrompt(fullSystemPrompt);
      console.log(`[AntigravityToolLoopProtocol] iter=${iteration} calling getModelResponse: promptLen=${prompt.length} modelKey=${this.modelKey} historyLen=${this.history.length}`);
      const response = await this.server.getModelResponse(prompt, this.modelKey, timeoutMs);
      console.log(`[AntigravityToolLoopProtocol] iter=${iteration} got response: responseLen=${response.length} preview=${JSON.stringify(response.slice(0, 120))}`);

      if (this.aborted) return;

      // Try to extract a tool call from the response.
      const toolCall = this.parseToolCall(response);

      if (!toolCall) {
        // No tool call -- this is the final text response.
        const text = this.stripToolCallJson(response).trim();
        this.history.push({ role: 'assistant', content: text });
        yield { type: 'text', content: text };
        yield { type: 'complete' };
        return;
      }

      // Append the assistant's tool-call "thinking" turn (the raw response text
      // before the tool call, if any, plus the call itself).
      const thinkingText = this.stripToolCallJson(response).trim();
      const assistantEntry = thinkingText
        ? `${thinkingText}\n[Tool call: ${toolCall.name}]`
        : `[Tool call: ${toolCall.name}]`;
      this.history.push({ role: 'assistant', content: assistantEntry });

      yield { type: 'tool_call', name: toolCall.name, args: toolCall.arguments };

      // Execute the tool.
      let resultText: string;
      try {
        const rawResult = await executeToolCall(toolCall.name, toolCall.arguments);
        resultText = typeof rawResult === 'string'
          ? rawResult
          : JSON.stringify(rawResult);
      } catch (err: any) {
        resultText = JSON.stringify({
          isError: true,
          error: err?.message ?? String(err),
        });
      }

      if (this.aborted) return;

      this.history.push({ role: 'tool', content: resultText, toolName: toolCall.name });
      yield { type: 'tool_result', name: toolCall.name, result: resultText };
    }

    // Fell through the iteration cap - produce a graceful stop.
    yield { type: 'text', content: '[Agent reached tool-call iteration limit]' };
    yield { type: 'complete' };
  }

  // ---- Prompt construction ------------------------------------------------

  /**
   * Prepend the tool-schema block to the system prompt so the model knows what
   * tools are available and the exact JSON format to use when calling them.
   */
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
   * Render the full conversation history into a single prompt string.
   * Format is compatible with GetModelResponse (one concatenated text blob).
   */
  private renderPrompt(systemPrompt: string): string {
    const parts: string[] = [systemPrompt, ''];

    for (const msg of this.history) {
      if (msg.role === 'user') {
        parts.push(`User: ${msg.content}`);
      } else if (msg.role === 'assistant') {
        parts.push(`Assistant: ${msg.content}`);
      } else if (msg.role === 'tool') {
        parts.push(`Tool result (${msg.toolName ?? 'unknown'}): ${msg.content}`);
      }
      parts.push('');
    }

    parts.push('Assistant:');
    return parts.join('\n');
  }

  // ---- Response parsing ---------------------------------------------------

  /**
   * Try to extract a tool call JSON envelope from the model's response.
   * Accepts both bare `{"tool_call":{...}}` and markdown-fenced variants.
   * Returns null if no valid tool call is found.
   */
  parseToolCall(response: string): ToolCallRequest | null {
    // Fast-path: no keyword present.
    if (!response.includes('tool_call')) return null;

    // Strip markdown fences if present.
    const stripped = response.replace(/```json\s*/g, '').replace(/```\s*/g, '');

    // Find the outermost `{"tool_call":{...}}` object. We scan for the key and
    // then extract the enclosing JSON object by bracket matching.
    const keyIdx = stripped.search(/"tool_call"\s*:/);
    if (keyIdx === -1) return null;

    // Walk back to find the opening brace of the outer object.
    let openBrace = keyIdx - 1;
    while (openBrace >= 0 && stripped[openBrace] !== '{') {
      openBrace--;
    }
    if (openBrace < 0) return null;

    // Walk forward to find the matching closing brace.
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

  /**
   * Remove the tool-call JSON block from the response text, leaving any
   * surrounding prose the model included (e.g. chain-of-thought text).
   */
  private stripToolCallJson(response: string): string {
    if (!response.includes('tool_call')) return response;

    // Remove fenced variants first.
    let cleaned = response.replace(/```json\s*\{"tool_call"[\s\S]*?\}\s*```/g, '');
    // Remove bare variants: the outermost `{...}` containing "tool_call".
    cleaned = cleaned.replace(/\{[^{}]*"tool_call"\s*:[^{}]*(\{[^{}]*\})[^{}]*\}/g, '');
    // Fallback: remove any remaining lines that start with `{"tool_call"`.
    cleaned = cleaned.replace(/\{.*"tool_call".*\}/g, '');
    return cleaned.trim();
  }
}
