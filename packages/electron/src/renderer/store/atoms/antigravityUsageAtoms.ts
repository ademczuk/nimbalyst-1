/**
 * Atoms for Antigravity usage tracking
 *
 * Mirrors codexUsageAtoms / geminiUsageAtoms. Sources data from the main-side
 * `antigravity:get-user-status` IPC, which talks to the Antigravity language
 * server via AntigravityServerManager. Account credits and per-model quotas
 * are surfaced in the bottom-left navigation gutter as a chip parallel to the
 * Codex Usage and Gemini Usage chips.
 *
 * The chip is only visible when at least one of the two contributed antigravity
 * providers is enabled in the user's providerSettings.
 */

import { atom } from 'jotai';
import { providersAtom } from './appSettings';

export interface AntigravityModelQuota {
  model: string;
  label?: string;
  remainingFraction?: number;
  resetTime?: string;
}

export interface AntigravityAccount {
  name?: string;
  email?: string;
  tier?: string;
  planName?: string;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
}

export interface AntigravityUsageData {
  account: AntigravityAccount;
  models: AntigravityModelQuota[];
  /** True when any individual quota is below 10% remaining. */
  warn: boolean;
  /** Unix timestamp of the last successful refresh. */
  lastUpdated: number;
  /** Set when the last refresh failed. */
  error?: string;
}

/** Mutable atom holding the last successful (or last attempted) snapshot. */
export const antigravityUsageAtom = atom<AntigravityUsageData | null>(null);

/**
 * Visible only when at least one of the two contributed antigravity providers
 * is enabled. We intentionally do NOT key off ProviderRegistry.has() alone:
 * the descriptor is registered even when the extension is installed but the
 * provider has been manually disabled by the user, and we don't want to keep
 * polling getUserStatus (which spawns/keeps-warm the local server) in that
 * case.
 */
export const antigravityIndicatorVisibleAtom = atom((get) => {
  const providers = get(providersAtom);
  const chat = providers['antigravity-gemini']?.enabled === true;
  const agent = providers['antigravity-gemini-agent']?.enabled === true;
  return chat || agent;
});

/** Percentage of monthly prompt credits remaining (null if not reported). */
export const antigravityCreditsPercentAtom = atom((get) => {
  const usage = get(antigravityUsageAtom);
  if (!usage || usage.error) return null;
  const { availablePromptCredits, monthlyPromptCredits } = usage.account;
  if (
    typeof availablePromptCredits !== 'number' ||
    typeof monthlyPromptCredits !== 'number' ||
    monthlyPromptCredits <= 0
  ) {
    return null;
  }
  return Math.round((availablePromptCredits / monthlyPromptCredits) * 100);
});

/** Traffic-light color for the credit ring. */
export const antigravityCreditsColorAtom = atom((get) => {
  const pct = get(antigravityCreditsPercentAtom);
  if (pct === null) return 'muted';
  // INVERTED relative to Codex: Codex shows utilization (high = bad), we show
  // remaining credits (low = bad). So `red` means low credits left.
  if (pct <= 10) return 'red';
  if (pct <= 25) return 'yellow';
  return 'green';
});

/** Format an ISO reset timestamp for display in the popover. */
export function formatResetTime(iso?: string | null): string {
  if (!iso) return '';
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

/** Parse the raw GetUserStatus payload into our snapshot shape. */
export function buildAntigravityUsageData(us: unknown): AntigravityUsageData {
  const raw = (us ?? {}) as Record<string, unknown>;
  const plan = (raw.planStatus ?? {}) as Record<string, unknown>;
  const pi = (plan.planInfo ?? {}) as Record<string, unknown>;

  const account: AntigravityAccount = {
    name: raw.name as string | undefined,
    email: raw.email as string | undefined,
    tier: pi.teamsTier as string | undefined,
    planName: pi.planName as string | undefined,
    monthlyPromptCredits: pi.monthlyPromptCredits as number | undefined,
    monthlyFlowCredits: pi.monthlyFlowCredits as number | undefined,
    availablePromptCredits: plan.availablePromptCredits as number | undefined,
    availableFlowCredits: plan.availableFlowCredits as number | undefined,
  };

  const cfgs = ((raw.cascadeModelConfigData as { clientModelConfigs?: unknown[] } | undefined)
    ?.clientModelConfigs ?? []) as Array<Record<string, unknown>>;

  const models: AntigravityModelQuota[] = [];
  let warn = false;
  for (const c of cfgs) {
    const moa = c.modelOrAlias as { model?: string } | undefined;
    const enumName = moa?.model;
    if (!enumName) continue;
    const q = (c.quotaInfo ?? {}) as { remainingFraction?: number; resetTime?: string };
    models.push({
      model: enumName,
      label: c.label as string | undefined,
      remainingFraction: q.remainingFraction,
      resetTime: q.resetTime,
    });
    if (typeof q.remainingFraction === 'number' && q.remainingFraction < 0.1) {
      warn = true;
    }
  }

  const isLowCredit = (avail?: number, monthly?: number) =>
    typeof avail === 'number' &&
    typeof monthly === 'number' &&
    monthly > 0 &&
    avail < monthly * 0.1;
  if (
    isLowCredit(account.availablePromptCredits, account.monthlyPromptCredits) ||
    isLowCredit(account.availableFlowCredits, account.monthlyFlowCredits)
  ) {
    warn = true;
  }

  return {
    account,
    models,
    warn,
    lastUpdated: Date.now(),
  };
}
