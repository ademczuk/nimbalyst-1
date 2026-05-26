/**
 * Google Gemini (Antigravity) extension - standalone marketplace package.
 *
 * Contributes TWO AI providers:
 *   - antigravity-gemini        (chat, default model = Gemini 3.5 Flash High)
 *   - antigravity-gemini-agent  (agent, tool-loop over GetModelResponse)
 *
 * The Antigravity language server lifecycle (spawn + HTTPS RPC against the
 * self-signed cert at 127.0.0.1) stays in the main process behind the
 * `antigravity:*` IPC bridge. The provider classes below run in the renderer
 * (where extensions live) and call that bridge for every server interaction.
 * Auth rides the user's ~/.gemini login - no API key is stored by nimbalyst.
 *
 * Exports:
 *   - aiProviders.AntigravityProvider       (matches manifest aiProviders[].component)
 *   - aiProviders.AntigravityAgentProvider  (matches manifest aiProviders[].component)
 *   - settingsPanel.AntigravitySettings
 *   - settingsPanel.AntigravityAgentSettings
 */

import { AntigravityProvider } from './AntigravityProvider';
import { AntigravityAgentProvider } from './AntigravityAgentProvider';
import { AntigravitySettings } from './components/AntigravitySettings';
import { AntigravityAgentSettings } from './components/AntigravityAgentSettings';

export async function activate(context: unknown): Promise<void> {
  console.log('[gemini-antigravity] Extension activated', context);
}

export async function deactivate(): Promise<void> {
  console.log('[gemini-antigravity] Extension deactivated');
}

/** AI provider implementations, keyed by the manifest `component` name. */
export const aiProviders = {
  AntigravityProvider,
  AntigravityAgentProvider,
};

/** Settings panel components, keyed by the manifest `component` name. */
export const settingsPanel = {
  AntigravitySettings,
  AntigravityAgentSettings,
};

export type { AntigravityProviderHost } from './AntigravityProvider';
export type { AntigravityAgentProviderHost } from './AntigravityAgentProvider';
