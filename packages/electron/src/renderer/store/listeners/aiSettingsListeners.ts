/**
 * Central AI Settings Listeners
 *
 * Subscribes to the main process's `ai-settings:changed` broadcast and keeps
 * the renderer's aiProviderSettingsAtom in sync with the on-disk
 * electron-store. Without this, an extension's runActivationEnable() write to
 * `ai:saveSettings` updates the store on disk but the renderer's in-memory
 * atom keeps its stale snapshot - so the Settings UI toggle for that provider
 * visually appears unchecked even though enabled:true is persisted (Bug G).
 *
 * Call initAiSettingsListeners() once at app startup, AFTER the atom has been
 * initialized via initAIProviderSettings(). On every broadcast we re-read the
 * full settings snapshot from main and replace the atom value. The next render
 * picks up the refreshed providers map and the toggle reflects the truth.
 */

import { store } from '@nimbalyst/runtime/store';
import { aiProviderSettingsAtom, initAIProviderSettings } from '../atoms/appSettings';

let initialized = false;

interface AiSettingsChangedPayload {
  providerIds?: string[];
  apiKeyNames?: string[];
}

export function initAiSettingsListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    'ai-settings:changed',
    (payload: AiSettingsChangedPayload) => {
      // Re-fetch the full snapshot. We intentionally re-use initAIProviderSettings
      // rather than a partial-merge codepath so the atom's shape mirrors the
      // post-load state exactly, including registry-derived defaults that may
      // not have existed in the previous snapshot (e.g. when an extension was
      // installed since the last hydrate).
      void initAIProviderSettings()
        .then((settings) => {
          store.set(aiProviderSettingsAtom, settings);
          console.log(
            `[aiSettingsListeners] Refreshed aiProviderSettingsAtom after ai-settings:changed`,
            {
              providerIds: payload?.providerIds ?? [],
              apiKeyNames: payload?.apiKeyNames ?? [],
            },
          );
        })
        .catch((err) => {
          console.error(
            '[aiSettingsListeners] Failed to refresh aiProviderSettingsAtom on ai-settings:changed',
            err,
          );
        });
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
