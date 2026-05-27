/**
 * Kimi Code extension - standalone marketplace package.
 *
 * Contributes TWO AI providers:
 *   - kimi-code        (chat, default model = Kimi K2.6)
 *   - kimi-code-agent  (agent, tool-loop + meta-agent host)
 *
 * Both providers talk to Moonshot's OpenAI-compatible platform.moonshot.ai
 * API. Auth requires a Moonshot API key, entered in the settings panel and
 * stored in electron-store under globalApiKeys['kimi-code']. The HTTP client
 * + key resolution live in the main process behind the `kimi-code:*` IPC
 * bridge (see KimiCodeRpcHandlers). The provider classes below run in the
 * renderer (where extensions live) and call that bridge for every interaction.
 *
 * Exports:
 *   - aiProviders.KimiCodeProvider       (matches manifest aiProviders[].component)
 *   - aiProviders.KimiCodeAgentProvider  (matches manifest aiProviders[].component)
 *   - settingsPanel.KimiCodeSettings
 *   - settingsPanel.KimiCodeAgentSettings
 *
 * TODO(reshape): when the aiAgentProviders + backendModules SDK lands and
 * gemini is reshaped, this index exports a backend-module factory + the same
 * UI components. The class-as-export convention for providers may change to a
 * backend-module-impl convention; the surface area visible to nimbalyst stays
 * the same.
 */

import { KimiCodeProvider } from './KimiCodeProvider';
import { KimiCodeAgentProvider } from './KimiCodeAgentProvider';
import { KimiCodeSettings } from './components/KimiCodeSettings';
import { KimiCodeAgentSettings } from './components/KimiCodeAgentSettings';

/** Provider IDs we contribute (must match manifest aiProviders[].id). */
const CONTRIBUTED_PROVIDER_IDS = [
  'kimi-code',
  'kimi-code-agent',
] as const;

interface PersistedProviderSettings {
  enabled?: boolean;
  [key: string]: unknown;
}

interface AISettingsSnapshot {
  providerSettings?: Record<string, PersistedProviderSettings | undefined>;
  apiKeys?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Idempotent enable-on-activate.
 *
 * For each contributed provider:
 *   - If the user has explicitly set `enabled: false`, leave it alone.
 *   - Otherwise (missing entry OR `enabled !== false`), write `enabled: true`.
 *
 * Mirrors the same enable-on-activate flow gemini uses. Skips the auto Test
 * Connection probe that gemini fires, because kimi-code REQUIRES an API key
 * and probing before the user has entered one would always fail and confuse
 * the install experience. The settings panel's "Test connection" button is
 * the right place to probe instead.
 */
async function runActivationEnable(): Promise<void> {
  const api = (globalThis as { window?: Window }).window?.electronAPI as
    | {
        aiGetSettings?: () => Promise<AISettingsSnapshot>;
        aiSaveSettings?: (settings: unknown) => Promise<unknown>;
      }
    | undefined;

  if (!api?.aiGetSettings || !api?.aiSaveSettings) {
    console.warn(
      '[kimi-code] electronAPI unavailable in renderer; skipping enable-on-activate',
    );
    return;
  }

  let currentProviderSettings: Record<string, PersistedProviderSettings | undefined> = {};
  try {
    const snapshot = await api.aiGetSettings();
    currentProviderSettings = snapshot?.providerSettings ?? {};
  } catch (err) {
    console.error('[kimi-code] enable-on-activate: aiGetSettings failed:', err);
  }

  const slicesToWrite: Record<string, PersistedProviderSettings> = {};
  for (const providerId of CONTRIBUTED_PROVIDER_IDS) {
    const existing = currentProviderSettings[providerId];
    if (existing?.enabled === false) {
      console.log(
        `[kimi-code] enable-on-activate: ${providerId} is user-disabled; leaving as-is`,
      );
      continue;
    }
    slicesToWrite[providerId] = { ...(existing ?? {}), enabled: true };
  }

  if (Object.keys(slicesToWrite).length === 0) {
    console.log('[kimi-code] enable-on-activate: nothing to do');
    return;
  }

  try {
    await api.aiSaveSettings({ providerSettings: slicesToWrite });
    console.log(
      '[kimi-code] enable-on-activate: wrote enabled:true for',
      Object.keys(slicesToWrite).join(', '),
    );
  } catch (err) {
    console.error('[kimi-code] enable-on-activate: aiSaveSettings failed:', err);
  }
}

export async function activate(_context: unknown): Promise<void> {
  console.log('[kimi-code] Extension activated');
  void runActivationEnable().catch((err: unknown) => {
    console.warn('[kimi-code] enable-on-activate failed:', err);
  });
}

export async function deactivate(): Promise<void> {
  console.log('[kimi-code] Extension deactivated');
}

/** AI provider implementations, keyed by the manifest `component` name. */
export const aiProviders = {
  KimiCodeProvider,
  KimiCodeAgentProvider,
};

/** Settings panel components, keyed by the manifest `component` name. */
export const settingsPanel = {
  KimiCodeSettings,
  KimiCodeAgentSettings,
};

export type { KimiCodeProviderHost } from './KimiCodeProvider';
export type { KimiCodeAgentProviderHost } from './KimiCodeAgentProvider';

// Re-export the contributed IDs for any host integration that wants to know
// which providers this extension owns.
export { CONTRIBUTED_PROVIDER_IDS };
