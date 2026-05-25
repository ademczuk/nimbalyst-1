/**
 * Local, renderer-safe copy of the ACP protocol value shapes.
 *
 * Mirrors the subset of
 * packages/runtime/src/ai/server/protocols/ProtocolInterface.ts that the ported
 * GeminiACPProtocol uses. Kept local so the extension never imports
 * @nimbalyst/runtime (which pulls node-only modules into the renderer bundle).
 */

export interface ToolResult {
  success?: boolean;
  result?: unknown;
  output?: unknown;
  error?: string | unknown;
  status?: string;
  command?: string;
  exit_code?: number;
  changes?: unknown;
  query?: string;
  action?: unknown;
  [key: string]: unknown;
}

export interface SessionOptions {
  workspacePath: string;
  model?: string;
  systemPrompt?: string;
  mcpServers?: Record<string, unknown>;
  env?: Record<string, string>;
  raw?: Record<string, unknown>;
}

export interface ProtocolMessage {
  content: string;
  attachments?: unknown[];
  sessionId?: string;
  mode?: 'planning' | 'agent';
}

export interface ProtocolSession {
  id: string;
  platform: string;
  raw?: Record<string, unknown>;
}

export type ProtocolEventType =
  | 'raw_event'
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'complete'
  | 'usage';

export interface ProtocolEvent {
  type: ProtocolEventType;
  content?: string;
  toolCall?: {
    id?: string;
    name: string;
    arguments?: Record<string, unknown>;
    result?: ToolResult | string;
  };
  toolResult?: {
    id?: string;
    name: string;
    result?: ToolResult | string;
  };
  error?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  metadata?: Record<string, unknown>;
}
