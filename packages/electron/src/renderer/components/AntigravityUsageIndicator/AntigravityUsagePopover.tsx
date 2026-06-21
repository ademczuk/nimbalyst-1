/**
 * AntigravityUsagePopover - Detailed Antigravity usage information popover
 *
 * Mirrors CodexUsagePopover. Shows account credits (prompt + flow), the
 * plan name, and per-model quota remaining with reset times. Provides a
 * Refresh button (forces a re-fetch via antigravity:get-user-status) and a
 * link to the Antigravity status page.
 */

import React, { useEffect, RefObject } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  antigravityUsageAtom,
  antigravityCreditsColorAtom,
  antigravityCreditsPercentAtom,
  formatResetTime,
} from '../../store/atoms/antigravityUsageAtoms';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';

interface AntigravityUsagePopoverProps {
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

const COLOR_CLASSES: Record<string, { text: string; bar: string }> = {
  green: { text: 'text-green-500', bar: 'bg-green-500' },
  yellow: { text: 'text-yellow-500', bar: 'bg-yellow-500' },
  red: { text: 'text-red-500', bar: 'bg-red-500' },
  muted: { text: 'text-nim-muted', bar: 'bg-nim-muted' },
};

export const AntigravityUsagePopover: React.FC<AntigravityUsagePopoverProps> = ({
  anchorRef,
  onClose,
  onRefresh,
}) => {
  const usage = useAtomValue(antigravityUsageAtom);
  const creditsColor = useAtomValue(antigravityCreditsColorAtom);
  const creditsPercent = useAtomValue(antigravityCreditsPercentAtom);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const menu = useFloatingMenu({
    placement: 'right-end',
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });

  useEffect(() => {
    if (anchorRef.current) {
      menu.refs.setReference(anchorRef.current);
    }
  }, [anchorRef, menu.refs]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  if (!usage) {
    return null;
  }

  const colors = COLOR_CLASSES[creditsColor] || COLOR_CLASSES.muted;
  const { account, models } = usage;
  const planLabel = account.planName ?? 'Antigravity';

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="antigravity-usage-popover w-64 bg-nim-secondary border border-nim rounded-lg shadow-lg z-50 overflow-y-auto"
        data-testid="antigravity-usage-popover"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-nim">
          <div className="flex items-center gap-2">
            <MaterialSymbol icon="auto_awesome" size={18} className="text-sky-500" />
            <span className="text-[14px] font-semibold text-nim">Antigravity Usage</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-nim transition-colors disabled:opacity-50"
              aria-label="Refresh usage"
            >
              <MaterialSymbol
                icon="refresh"
                size={14}
                className={isRefreshing ? 'animate-spin' : ''}
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-nim transition-colors"
              aria-label="Close"
            >
              <MaterialSymbol icon="close" size={14} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          {usage.error ? (
            <div className="text-[13px] text-nim-error">{usage.error}</div>
          ) : (
            <>
              {/* Plan + credits summary */}
              <div className="mb-3">
                <div className="flex items-baseline justify-between mb-1">
                  <div>
                    <div className="text-[13px] font-semibold text-nim">{planLabel} plan</div>
                    {account.email && (
                      <div className="text-[11px] text-nim-muted truncate max-w-[14rem]">
                        {account.email}
                      </div>
                    )}
                  </div>
                  {creditsPercent !== null && (
                    <div className={`text-[16px] font-semibold ${colors.text}`}>
                      {creditsPercent}%
                    </div>
                  )}
                </div>
                {creditsPercent !== null && (
                  <div className="relative h-1.5 bg-nim-tertiary rounded-full overflow-hidden mb-1">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${colors.bar}`}
                      style={{ width: `${Math.min(creditsPercent, 100)}%` }}
                    />
                  </div>
                )}
                {typeof account.availablePromptCredits === 'number' &&
                  typeof account.monthlyPromptCredits === 'number' && (
                    <div className="text-[11px] text-nim-muted">
                      Prompt credits {account.availablePromptCredits.toLocaleString()} /{' '}
                      {account.monthlyPromptCredits.toLocaleString()}
                    </div>
                  )}
                {typeof account.availableFlowCredits === 'number' &&
                  typeof account.monthlyFlowCredits === 'number' && (
                    <div className="text-[11px] text-nim-muted">
                      Flow credits {account.availableFlowCredits.toLocaleString()} /{' '}
                      {account.monthlyFlowCredits.toLocaleString()}
                    </div>
                  )}
              </div>

              {/* Per-model quota */}
              {models.length > 0 && (
                <div className="border-t border-nim pt-3 flex flex-col gap-1.5">
                  {models.map((m) => {
                    const pct =
                      typeof m.remainingFraction === 'number'
                        ? Math.round(m.remainingFraction * 100)
                        : null;
                    const low = pct !== null && pct < 10;
                    return (
                      <div
                        key={m.model}
                        className="flex items-center justify-between gap-2 text-[11px]"
                      >
                        <span className="text-nim-muted truncate" title={m.model}>
                          {m.label ?? m.model}
                        </span>
                        <span
                          className={`font-mono whitespace-nowrap ${low ? 'text-red-500' : 'text-nim'}`}
                        >
                          {pct !== null ? `${pct}%` : '--'}
                          {m.resetTime && (
                            <span className="text-nim-faint ml-1">
                              ({formatResetTime(m.resetTime)})
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {creditsPercent === null && models.length === 0 && (
                <div className="text-[12px] text-nim-muted">
                  No usage data reported. Make sure Antigravity is signed in.
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-nim flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-nim-faint">
              Updated {formatLastUpdated(usage.lastUpdated)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => window.electronAPI.openExternal('https://antigravity.google/status')}
            className="flex items-center gap-1 text-[11px] text-nim-muted hover:text-nim transition-colors"
          >
            <MaterialSymbol icon="open_in_new" size={12} />
            <span>Antigravity Status</span>
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
};

function formatLastUpdated(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffSeconds < 60) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
}
