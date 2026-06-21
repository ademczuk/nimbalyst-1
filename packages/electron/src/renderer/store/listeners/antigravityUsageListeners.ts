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
  // CLA-185 DIAGNOSTIC: log entry so we can see whether the chip's mount
  // effect or its Refresh button actually fired this. If the chip is
  // supposedly visible but no refresh logs appear, the mount effect never ran.
  console.log('[refreshAntigravityUsage] entry');
  if (typeof window === 'undefined' || !window.electronAPI) {
    console.warn('[refreshAntigravityUsage] window.electronAPI unavailable, returning null');
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
      console.warn('[refreshAntigravityUsage] error snapshot stored', {
        error: errorSnapshot.error,
      });
      store.set(antigravityUsageAtom, errorSnapshot);
      return errorSnapshot;
    }

    const snapshot = buildAntigravityUsageData(res.data);
    console.log('[refreshAntigravityUsage] success snapshot stored', {
      lastUpdated: snapshot.lastUpdated,
      modelsCount: snapshot.models.length,
      hasAccount: Boolean(snapshot.account.email),
      monthlyPromptCredits: snapshot.account.monthlyPromptCredits,
      availablePromptCredits: snapshot.account.availablePromptCredits,
    });
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
    console.error('[refreshAntigravityUsage] threw, storing error snapshot', errorSnapshot.error);
    store.set(antigravityUsageAtom, errorSnapshot);
    return errorSnapshot;
  }
}
