/**
 * Usage chip - mirrors the OpenAI Codex remaining-quota chip style (image #12).
 *
 * Renders compact account credits + per-model quota fetched from the
 * Antigravity language server (via `antigravity:get-user-status`). Click the
 * Refresh button to re-fetch. Placed on the LEFT side of the settings panel
 * per user image #14.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AntigravityRpcClient } from '../antigravityRpcClient';

interface AccountUsage {
  name?: string;
  email?: string;
  tier?: string;
  planName?: string;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
}

interface ModelQuota {
  model: string;
  label?: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface UsageSnapshot {
  account: AccountUsage;
  models: ModelQuota[];
  warn: boolean;
}

/** Compute snapshot from raw GetUserStatus payload. */
function toSnapshot(us: unknown): UsageSnapshot {
  const raw = (us ?? {}) as Record<string, unknown>;
  const plan = (raw.planStatus ?? {}) as Record<string, unknown>;
  const pi = (plan.planInfo ?? {}) as Record<string, unknown>;
  const account: AccountUsage = {
    name: raw.name as string | undefined,
    email: raw.email as string | undefined,
    tier: pi.teamsTier as string | undefined,
    planName: pi.planName as string | undefined,
    monthlyPromptCredits: pi.monthlyPromptCredits as number | undefined,
    monthlyFlowCredits: pi.monthlyFlowCredits as number | undefined,
    availablePromptCredits: plan.availablePromptCredits as number | undefined,
    availableFlowCredits: plan.availableFlowCredits as number | undefined,
  };
  const cfgs = ((raw.cascadeModelConfigData as { clientModelConfigs?: unknown[] } | undefined)?.clientModelConfigs ?? []) as Array<Record<string, unknown>>;
  const models: ModelQuota[] = [];
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
    typeof avail === 'number' && typeof monthly === 'number' && monthly > 0 && avail < monthly * 0.1;
  if (isLowCredit(account.availablePromptCredits, account.monthlyPromptCredits) ||
      isLowCredit(account.availableFlowCredits, account.monthlyFlowCredits)) {
    warn = true;
  }
  return { account, models, warn };
}

function formatResetTime(iso?: string): string {
  if (!iso) return '';
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString();
  } catch {
    return iso;
  }
}

export interface UsageChipProps {
  /** Only show quotas for these enum names (e.g. the model the panel is for). */
  modelEnumFilter?: string[];
  /** Compact (single-line) layout when true. */
  compact?: boolean;
}

export function UsageChip({ compact }: UsageChipProps): React.ReactElement {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const us = await AntigravityRpcClient.getUserStatus();
      setSnapshot(toSnapshot(us));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <div
        className="antigravity-usage-chip flex flex-col gap-1 p-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]"
        data-testid="antigravity-usage-chip"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--nim-text-muted)]">
            Antigravity usage
          </span>
          <button
            type="button"
            onClick={() => { void refresh(); }}
            disabled={loading}
            className="text-[11px] text-[var(--nim-primary)] hover:underline disabled:opacity-50"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
        <span className="text-[12px] text-[var(--nim-error)]">
          {error}
        </span>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div
        className="antigravity-usage-chip flex items-center gap-2 p-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]"
        data-testid="antigravity-usage-chip"
      >
        <span className="text-[12px] text-[var(--nim-text-muted)]">
          {loading ? 'Loading usage...' : 'Usage not loaded'}
        </span>
      </div>
    );
  }

  const { account, models, warn } = snapshot;
  const promptPercent = account.monthlyPromptCredits && account.availablePromptCredits !== undefined
    ? Math.round((account.availablePromptCredits / account.monthlyPromptCredits) * 100)
    : null;

  const borderColor = warn ? 'border-[var(--nim-warning,var(--nim-border))]' : 'border-[var(--nim-border)]';

  return (
    <div
      className={`antigravity-usage-chip flex flex-col gap-2 p-3 rounded-md bg-[var(--nim-bg-secondary)] border ${borderColor}`}
      data-testid="antigravity-usage-chip"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-[var(--nim-text)]">
          {account.planName ?? 'Antigravity'} plan
        </span>
        <button
          type="button"
          onClick={() => { void refresh(); }}
          disabled={loading}
          className="text-[11px] text-[var(--nim-primary)] hover:underline disabled:opacity-50"
          aria-label="Refresh Antigravity usage"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {promptPercent !== null && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--nim-text-muted)]">
            Prompt credits
          </span>
          <span className="text-[11px] font-mono text-[var(--nim-text)]">
            {account.availablePromptCredits} / {account.monthlyPromptCredits} ({promptPercent}%)
          </span>
        </div>
      )}

      {!compact && models.length > 0 && (
        <div className="flex flex-col gap-1 pt-1 border-t border-[var(--nim-border)]">
          {models.map((m) => (
            <div key={m.model} className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[var(--nim-text-muted)] truncate">
                {m.label ?? m.model}
              </span>
              <span className="text-[11px] font-mono text-[var(--nim-text)]">
                {typeof m.remainingFraction === 'number'
                  ? `${Math.round(m.remainingFraction * 100)}%`
                  : '--'}
                {m.resetTime && (
                  <span className="text-[var(--nim-text-muted)] ml-1">
                    (resets {formatResetTime(m.resetTime)})
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
