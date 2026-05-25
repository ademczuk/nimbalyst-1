/**
 * Renderer-safe built-in provider METADATA.
 *
 * Contains only light descriptor fields (no provider-class imports, no
 * createInstance/getModels). Safe to call from the renderer so UI code can read
 * provider metadata (isAgent, icon, label, etc.) from the registry. The MAIN
 * process additionally attaches heavy factories via `registerBuiltinProviders`.
 */
import { ProviderRegistry, ProviderDescriptor } from './ProviderRegistry';
import { DEFAULT_MODELS } from '../modelConstants';

export const BUILTIN_PROVIDER_METADATA: ProviderDescriptor[] = [
  {
    id: 'claude', label: 'Claude', source: 'builtin', defaultModelId: DEFAULT_MODELS['claude'],
    isAgent: false, isChat: true, requiresApiKey: true, dynamicModels: false,
    transcriptParser: 'claude-code', apiKeyName: 'anthropic',
  },
  {
    id: 'claude-code', label: 'Claude Agent', source: 'builtin', defaultModelId: DEFAULT_MODELS['claude-code'],
    isAgent: true, isChat: false, requiresApiKey: false, dynamicModels: false,
    transcriptParser: 'claude-code', mcpProviderId: 'claude-agent',
  },
  {
    id: 'openai', label: 'OpenAI', source: 'builtin', defaultModelId: DEFAULT_MODELS['openai'],
    isAgent: false, isChat: true, requiresApiKey: true, dynamicModels: false,
    transcriptParser: 'claude-code', apiKeyName: 'openai',
  },
  {
    id: 'openai-codex', label: 'OpenAI Codex', source: 'builtin', defaultModelId: DEFAULT_MODELS['openai-codex'],
    isAgent: true, isChat: false, requiresApiKey: false, dynamicModels: true,
    transcriptParser: 'codex', apiKeyName: 'openai', mcpProviderId: 'codex',
  },
  {
    id: 'openai-codex-acp', label: 'OpenAI Codex (ACP)', source: 'builtin', defaultModelId: DEFAULT_MODELS['openai-codex-acp'],
    isAgent: true, isChat: false, requiresApiKey: false, dynamicModels: false,
    transcriptParser: 'codex-acp', apiKeyName: 'openai', mcpProviderId: 'codex', icon: 'openai-codex',
  },
  {
    id: 'opencode', label: 'OpenCode', source: 'builtin', defaultModelId: DEFAULT_MODELS['opencode'],
    isAgent: true, isChat: false, requiresApiKey: false, dynamicModels: false,
    transcriptParser: 'opencode',
  },
  {
    id: 'lmstudio', label: 'LM Studio', source: 'builtin', defaultModelId: DEFAULT_MODELS['lmstudio'],
    isAgent: false, isChat: true, requiresApiKey: false, dynamicModels: false,
    transcriptParser: 'claude-code', baseUrlName: 'lmstudio_url',
  },
  {
    id: 'copilot-cli', label: 'GitHub Copilot', source: 'builtin', defaultModelId: DEFAULT_MODELS['copilot-cli'],
    isAgent: true, isChat: false, requiresApiKey: false, dynamicModels: true,
    transcriptParser: 'copilot', icon: 'terminal', mcpProviderId: 'copilot',
  },
  {
    // Gemini 3.5 Flash chat provider backed by the local Antigravity language
    // server. CHAT provider (not agent): no MCP, no file tools, no API key (auth
    // rides the user's ~/.gemini login). Default model is "Gemini 3.5 Flash (High)".
    // Mirrors the lmstudio chat-provider descriptor. The full default id includes
    // the model key (there is no DEFAULT_MODELS['antigravity-gemini'] entry).
    id: 'antigravity-gemini', label: 'Gemini 3.5 Flash (Antigravity)', source: 'builtin',
    defaultModelId: 'antigravity-gemini:gemini-3-flash-agent',
    isAgent: false, isChat: true, requiresApiKey: false, dynamicModels: true,
    transcriptParser: 'claude-code', icon: 'gemini-cli',
  },
  // gemini-cli ships as a marketplace extension (registers via the aiProviders
  // contribution), so it is intentionally absent from the built-in metadata.
];

let metaRegistered = false;

/** Renderer-safe: register light metadata descriptors only. */
export function registerBuiltinProviderMetadata(): void {
  if (metaRegistered) return;
  metaRegistered = true;
  for (const meta of BUILTIN_PROVIDER_METADATA) {
    ProviderRegistry.register(meta);
  }
}
