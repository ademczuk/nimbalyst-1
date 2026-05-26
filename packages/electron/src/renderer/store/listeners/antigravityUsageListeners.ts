/**
 * Centralized refresh helpers for Antigravity usage tracking
 *
 * Unlike Codex (which has push events from the CLI session file watcher),
 * Antigravity only reports usage on-demand via `antigravity:get-user-status`.
 * The chip calls refresh() on mount and provides a manual refresh button.
 *
 * Follows the same pattern as codex/gemini listeners: writes to atoms, never
 * subscribes from components.
 */

import { store } from '../index';
import {
  antigravityUsageAtom,
  buildAntigravityUsageData,
  type AntigravityUsageData,
} from '../atoms/antigravityUsageAtoms';

/**
 * One-shot refresh. Writes the result (or an error snapshot) into the atom.
 * Returns the snapshot for callers that want to act on it directly.
 */
export async function refreshAntigravityUsage(): Promise<AntigravityUsageData | null> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return null;
  }

  try {
    const res = (await window.electronAPI.invoke('antigravity:get-user-status')) as {
      ok: boolean;
      data?: unknown;
      error?: string;
    };

    if (!res?.ok) {
      const errorSnapshot: AntigravityUsageData = {
        account: {},
        models: [],
        warn: true,
        lastUpdated: Date.now(),
        error: res?.error ?? 'antigravity:get-user-status failed',
      };
      store.set(antigravityUsageAtom, errorSnapshot);
      return errorSnapshot;
    }

    const snapshot = buildAntigravityUsageData(res.data);
    store.set(antigravityUsageAtom, snapshot);
    return snapshot;
  } catch (err) {
    const errorSnapshot: AntigravityUsageData = {
      account: {},
      models: [],
      warn: true,
      lastUpdated: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
    store.set(antigravityUsageAtom, errorSnapshot);
    return errorSnapshot;
  }
}
