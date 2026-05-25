/**
 * Google Gemini (CLI) extension - standalone marketplace package.
 *
 * Pure-transport AI provider: runs `gemini --acp` over the host-provided spawn,
 * maps ACP updates to StreamChunks, and lets the main-side handler persist the
 * conversation. No DB writes happen here.
 *
 * Exports:
 *   - aiProviders.GeminiProvider  -> matches manifest aiProviders[].component
 *   - settingsPanel.GeminiSettings -> matches manifest settingsPanel.component
 *     (and aiProviders[].settingsPanelComponent)
 */

import { GeminiProvider } from './GeminiProvider';
import { GeminiSettings } from './components/GeminiSettings';

export async function activate(context: unknown): Promise<void> {
  console.log('[gemini-cli] Extension activated', context);
}

export async function deactivate(): Promise<void> {
  console.log('[gemini-cli] Extension deactivated');
}

/** AI provider implementations, keyed by the manifest `component` name. */
export const aiProviders = {
  GeminiProvider,
};

/** Settings panel components, keyed by the manifest `component` name. */
export const settingsPanel = {
  GeminiSettings,
};

export type { GeminiProviderHost } from './GeminiProvider';
