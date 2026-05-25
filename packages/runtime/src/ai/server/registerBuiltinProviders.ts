/**
 * MAIN-process built-in provider registration.
 *
 * Merges the renderer-safe metadata (registerBuiltinProviderMetadata) with heavy
 * factories (createInstance/getModels/getDefaultModel) that eagerly import the
 * provider classes. Do NOT import this from renderer code — use
 * registerBuiltinProviderMetadata there instead.
 */
import { ProviderRegistry } from './ProviderRegistry';
import type { AIProvider } from './AIProvider';
import type { AIModel } from './types';
import { BUILTIN_PROVIDER_METADATA } from './registerBuiltinProviderMetadata';
import { ClaudeProvider } from './providers/ClaudeProvider';
import { ClaudeCodeProvider } from './providers/ClaudeCodeProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { OpenAICodexProvider } from './providers/OpenAICodexProvider';
import { OpenAICodexACPProvider } from './providers/OpenAICodexACPProvider';
import { LMStudioProvider } from './providers/LMStudioProvider';
import { OpenCodeProvider } from './providers/OpenCodeProvider';
import { CopilotCLIProvider } from './providers/CopilotCLIProvider';
import { AntigravityProvider } from './providers/antigravity/AntigravityProvider';
import { AntigravityAgentProvider } from './providers/antigravity/AntigravityAgentProvider';

interface HeavyImpl {
  createInstance: () => AIProvider;
  getModels: (apiKey?: string, baseUrl?: string) => Promise<AIModel[]> | AIModel[];
  getDefaultModel: () => string | Promise<string>;
}

const HEAVY: Record<string, HeavyImpl> = {
  claude: {
    createInstance: () => new ClaudeProvider(),
    getModels: () => ClaudeProvider.getModels(),
    getDefaultModel: () => ClaudeProvider.getDefaultModel(),
  },
  'claude-code': {
    createInstance: () => new ClaudeCodeProvider(),
    getModels: () => ClaudeCodeProvider.getModels(),
    getDefaultModel: () => ClaudeCodeProvider.getDefaultModel(),
  },
  openai: {
    createInstance: () => new OpenAIProvider(),
    getModels: (apiKey) => OpenAIProvider.getModels(apiKey),
    getDefaultModel: () => OpenAIProvider.getDefaultModel(),
  },
  'openai-codex': {
    createInstance: () => new OpenAICodexProvider(),
    getModels: (apiKey) => OpenAICodexProvider.getModels(apiKey),
    getDefaultModel: () => OpenAICodexProvider.getDefaultModel(),
  },
  'openai-codex-acp': {
    createInstance: () => new OpenAICodexACPProvider(),
    getModels: (apiKey) => OpenAICodexACPProvider.getModels(apiKey),
    getDefaultModel: () => OpenAICodexACPProvider.getDefaultModel(),
  },
  opencode: {
    createInstance: () => new OpenCodeProvider(),
    getModels: () => OpenCodeProvider.getModels(),
    getDefaultModel: () => OpenCodeProvider.DEFAULT_MODEL,
  },
  lmstudio: {
    createInstance: () => new LMStudioProvider(),
    getModels: (_apiKey, baseUrl) => LMStudioProvider.getModels(baseUrl || 'http://127.0.0.1:1234'),
    getDefaultModel: () => LMStudioProvider.getDefaultModel(),
  },
  'copilot-cli': {
    createInstance: () => new CopilotCLIProvider(),
    getModels: () => CopilotCLIProvider.getModels(),
    getDefaultModel: () => CopilotCLIProvider.getDefaultModel(),
  },
  'antigravity-gemini': {
    createInstance: () => new AntigravityProvider(),
    // Returns empty array if the Antigravity server can't be reached.
    getModels: () => AntigravityProvider.getModels(),
    getDefaultModel: () => `antigravity-gemini:${AntigravityProvider.DEFAULT_MODEL}`,
  },
  'antigravity-gemini-agent': {
    createInstance: () => new AntigravityAgentProvider(),
    getModels: () => AntigravityAgentProvider.getModels(),
    getDefaultModel: () => AntigravityAgentProvider.getDefaultModel(),
  },
  // gemini-cli is no longer a built-in: it ships as a marketplace extension
  // and registers itself through the aiProviders contribution + the main-side
  // ExtensionProviderProxy. The class statics remain wired in main only as a
  // dormant runtime-config carrier (MCP ports, enhanced PATH).
};

let registered = false;

/** MAIN: register full descriptors (metadata + heavy factories). */
export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;
  for (const meta of BUILTIN_PROVIDER_METADATA) {
    const heavy = HEAVY[meta.id];
    ProviderRegistry.register(heavy ? { ...meta, ...heavy } : meta);
  }
}
