export * from './types';
export * from './AIProvider';
export * from './ProviderFactory';
export * from './ProviderRegistry';
export * from './registerBuiltinProviderMetadata';
export * from './ModelRegistry';
export * from './SessionManager';
export * from './providers/ClaudeProvider';
export * from './providers/ClaudeCodeProvider';
export * from './providers/OpenAIProvider';
export * from './providers/OpenAICodexProvider';
export * from './providers/OpenAICodexACPProvider';
export * from './providers/ProviderPermissionMixin';
export * from './providers/LMStudioProvider';
export * from './providers/OpenCodeProvider';
export * from './providers/CopilotCLIProvider';
export * from './providers/GeminiCLIProvider';
export * from './utils/errorDetection';
export * from './preferredAgentLanguageConfig';
// Re-export prompt builders so out-of-tree consumers (e.g. the marketplace
// gemini-antigravity extension's main-side handlers) can build the meta-agent
// system prompt without depending on the internal `../prompt` path.
export { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt } from '../prompt';
export type { MetaAgentWorkflowPreset } from '../prompt';
