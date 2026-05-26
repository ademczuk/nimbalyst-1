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

/**
 * Configuration service surface used by the auto-enable flow.
 * Mirrors the renderer-side ExtensionConfigurationService contract; declared
 * inline so this file doesn't need to import the SDK type just for one shape.
 */
interface AutoEnableConfigService {
  get: <T>(key: string, defaultValue?: T) => T;
  update: (key: string, value: unknown, scope?: 'user' | 'workspace') => Promise<void>;
}

interface AutoEnableContext {
  services?: {
    configuration?: AutoEnableConfigService;
  };
}

/** Sentinel key in the extension's configuration store. */
const AUTO_ENABLE_SENTINEL_KEY = 'didAutoEnableOnInstall';

/** Provider IDs we contribute (must match manifest aiProviders[].id). */
const CONTRIBUTED_PROVIDER_IDS = [
  'antigravity-gemini',
  'antigravity-gemini-agent',
] as const;

/**
 * Auto-enable the contributed providers and fire a one-shot Test connection
 * on first activation after install. Subsequent activations are no-ops thanks
 * to the `didAutoEnableOnInstall` sentinel stored in extension configuration.
 *
 * Without this, freshly-installed extensions render with both providers
 * disabled and force the user to toggle them on manually before they can
 * even attempt a connection - bad first-run UX.
 */
async function runFirstInstallAutoEnable(context: AutoEnableContext): Promise<void> {
  const configuration = context?.services?.configuration;
  if (!configuration) {
    console.warn(
      '[gemini-antigravity] No configuration service in activation context; skipping auto-enable',
    );
    return;
  }

  // Idempotency: only run the auto-enable once per install.
  const already = configuration.get<boolean>(AUTO_ENABLE_SENTINEL_KEY, false);
  if (already) return;

  const api = (globalThis as { window?: Window }).window?.electronAPI as
    | {
        aiSaveSettings?: (settings: unknown) => Promise<unknown>;
        aiTestConnection?: (provider: string, workspacePath?: string) => Promise<{ success: boolean; error?: string }>;
        aiClearModelCache?: () => Promise<unknown>;
      }
    | undefined;

  if (!api?.aiSaveSettings || !api?.aiTestConnection) {
    console.warn(
      '[gemini-antigravity] electronAPI not available in renderer; skipping auto-enable',
    );
    return;
  }

  // 1) Flip both providers to enabled in the host's settings store.
  try {
    await api.aiSaveSettings({
      providerSettings: {
        'antigravity-gemini': { enabled: true, testStatus: 'idle' },
        'antigravity-gemini-agent': { enabled: true, testStatus: 'idle' },
      },
    });
    console.log('[gemini-antigravity] auto-enabled both providers on first install');
  } catch (err) {
    console.error('[gemini-antigravity] auto-enable: aiSaveSettings failed:', err);
  }

  // 2) Mark the sentinel BEFORE the test connection so a slow/failing test
  //    doesn't cause us to retry the auto-enable on subsequent boots. The
  //    user is still free to manually toggle providers off; we don't second-
  //    guess them later.
  try {
    await configuration.update(AUTO_ENABLE_SENTINEL_KEY, true, 'user');
  } catch (err) {
    console.error('[gemini-antigravity] auto-enable: failed to set sentinel:', err);
  }

  // 3) Fire a one-shot Test connection so the user sees a green check (or a
  //    clear error) without having to click anything. The connection test
  //    populates the model catalog via the same path Settings would.
  try {
    if (api.aiClearModelCache) {
      await api.aiClearModelCache();
    }
    const result = await api.aiTestConnection('antigravity-gemini');
    if (result?.success) {
      console.log('[gemini-antigravity] auto-test: connection OK');
    } else {
      console.warn(
        '[gemini-antigravity] auto-test: connection failed:',
        result?.error ?? '(unknown error)',
      );
    }
  } catch (err) {
    console.warn('[gemini-antigravity] auto-test: aiTestConnection threw:', err);
  }
}

export async function activate(context: unknown): Promise<void> {
  console.log('[gemini-antigravity] Extension activated');
  // Run auto-enable + auto-test in the background so we don't block activation
  // on the connection probe (the underlying server cold-start can take 5-10s).
  void runFirstInstallAutoEnable(context as AutoEnableContext);
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

// Re-export the contributed IDs for any host integration that wants to know
// which providers this extension owns (used by sidebar usage chip targeting).
export { CONTRIBUTED_PROVIDER_IDS };
