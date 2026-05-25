/**
 * Atoms for Gemini usage tracking
 *
 * Gemini exposes only per-turn token counts (no 5h/7d limit windows), so we
 * accumulate a running total of input/output tokens across the session and
 * display that cumulative count in the navigation gutter.
 */

import { atom } from 'jotai';

export interface GeminiUsageData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  turnCount: number;
  lastTurn: {
    inputTokens: number;
    outputTokens: number;
  } | null;
}

const EMPTY_USAGE: GeminiUsageData = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalTokens: 0,
  turnCount: 0,
  lastTurn: null,
};

export const geminiUsageAtom = atom<GeminiUsageData>(EMPTY_USAGE);

export const geminiUsageIndicatorEnabledAtom = atom<boolean>(true);

let geminiUsageIndicatorPersistTimer: ReturnType<typeof setTimeout> | null = null;
const GEMINI_USAGE_INDICATOR_PERSIST_DEBOUNCE_MS = 500;

function scheduleGeminiUsageIndicatorPersist(enabled: boolean): void {
  if (geminiUsageIndicatorPersistTimer) {
    clearTimeout(geminiUsageIndicatorPersistTimer);
  }
  geminiUsageIndicatorPersistTimer = setTimeout(async () => {
    geminiUsageIndicatorPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        // Send only the changed field -- ai:saveSettings handles partial updates
        await window.electronAPI.aiSaveSettings({ showGeminiUsageIndicator: enabled });
      } catch (error) {
        console.error('[geminiUsageAtoms] Failed to save usage indicator setting:', error);
      }
    }
  }, GEMINI_USAGE_INDICATOR_PERSIST_DEBOUNCE_MS);
}

export const setGeminiUsageIndicatorEnabledAtom = atom(
  null,
  (_get, set, enabled: boolean) => {
    set(geminiUsageIndicatorEnabledAtom, enabled);
    scheduleGeminiUsageIndicatorPersist(enabled);
  }
);

export async function initGeminiUsageIndicatorSetting(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return true;
  }

  try {
    const settings = await window.electronAPI.aiGetSettings();
    return (settings as Record<string, unknown>)?.showGeminiUsageIndicator as boolean ?? true;
  } catch (error) {
    console.error('[geminiUsageAtoms] Failed to load usage indicator setting:', error);
  }

  return true;
}

export const geminiUsageAvailableAtom = atom((get) => {
  const usage = get(geminiUsageAtom);
  return usage.totalTokens > 0 || usage.turnCount > 0;
});

/**
 * Format a token count for the compact gutter display.
 * e.g. 950 -> "950", 12300 -> "12.3k", 1500000 -> "1.5M".
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = tokens / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}
