/**
 * Runtime AI provider registry.
 *
 * Replaces the closed-world `AI_PROVIDER_TYPES` const + exhaustive `switch`
 * statements with a `Map` of provider descriptors that can be populated at
 * runtime. Built-in providers self-register at startup (see
 * `registerBuiltinProviders`); extension-contributed providers register through
 * the same API, which is what lets a provider ship as a marketplace extension.
 *
 * Migration is incremental: this module is introduced alongside the existing
 * const/switches and consumers are moved over one group at a time. The const is
 * only removed once every consumer reads from the registry.
 */
import type { AIProvider } from './AIProvider';
import type { AIModel } from './types';

/** Raw-event transcript parser kind (mirrors `selectRawParser`). */
export type TranscriptParserKind =
  | 'codex'
  | 'codex-acp'
  | 'copilot'
  | 'claude-code'
  | 'opencode';

export interface ProviderDescriptor {
  /** Unique provider id (e.g. 'claude-code', 'gemini-cli'). */
  id: string;
  /** Human-facing display label (e.g. 'Google Gemini'). */
  label: string;

  /**
   * Construct a new provider instance. Synchronous, mirroring ProviderFactory.
   * OPTIONAL: present only in the MAIN process (renderer registers metadata-only
   * descriptors, since provider classes import node-only modules).
   */
  createInstance?: () => AIProvider;
  /**
   * Fetch selectable models. The caller resolves `apiKey`/`baseUrl` from
   * settings using `apiKeyName`/`baseUrlName` below. MAIN-only (see above).
   */
  getModels?: (apiKey?: string, baseUrl?: string) => Promise<AIModel[]> | AIModel[];
  /** Resolve the provider's default model id. MAIN-only (see above). */
  getDefaultModel?: () => string | Promise<string>;
  /** Static default model id (was `DEFAULT_MODELS[id]`). */
  defaultModelId: string;

  /** SDK/CLI agent provider (was `isAgentProvider`). */
  isAgent: boolean;
  /** Plain chat provider shown in the chat-provider allowlist. */
  isChat: boolean;
  /** A session needs an API key before streaming (MessageStreamingHandler). */
  requiresApiKey: boolean;
  /** Models are discovered dynamically and should not be persisted (was DYNAMIC_MODEL_PROVIDERS). */
  dynamicModels: boolean;
  /** Transcript raw-parser kind (was `selectRawParser`). */
  transcriptParser: TranscriptParserKind;

  /** Material icon name (was ProviderIcons map); falls back to `id` when undefined. */
  icon?: string;
  /** `apiKeys[...]` entry feeding `getModels` (e.g. 'anthropic', 'openai'). */
  apiKeyName?: string;
  /** `apiKeys[...]` entry feeding `baseUrl` (e.g. 'lmstudio_url'). */
  baseUrlName?: string;
  /** MCP scoping id (MCP_PROVIDER_IDS) when MCP-capable. */
  mcpProviderId?: string;

  /** Provenance. */
  source: 'builtin' | 'extension';
}

const registry = new Map<string, ProviderDescriptor>();

export const ProviderRegistry = {
  register(descriptor: ProviderDescriptor): void {
    registry.set(descriptor.id, descriptor);
  },
  unregister(id: string): void {
    registry.delete(id);
  },
  get(id: string): ProviderDescriptor | undefined {
    return registry.get(id);
  },
  require(id: string): ProviderDescriptor {
    const d = registry.get(id);
    if (!d) throw new Error(`Unknown provider: ${id}`);
    return d;
  },
  has(id: string): boolean {
    return registry.has(id);
  },
  list(): ProviderDescriptor[] {
    return Array.from(registry.values());
  },
  ids(): string[] {
    return Array.from(registry.keys());
  },
  /** Registry-backed replacement for `isAgentProvider`. */
  isAgent(id: string | null | undefined): boolean {
    return !!id && (registry.get(id)?.isAgent ?? false);
  },
  clear(): void {
    registry.clear();
  },
};
