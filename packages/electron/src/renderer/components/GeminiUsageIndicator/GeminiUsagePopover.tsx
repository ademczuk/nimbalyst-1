/**
 * GeminiUsagePopover - Detailed Gemini usage information popover
 *
 * Shows the cumulative input/output token split, the session turn count,
 * and the most recent turn's token usage. Gemini has no rolling limit
 * windows, so there are no reset timers here.
 */

import React, { RefObject, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  geminiUsageAtom,
  setGeminiUsageIndicatorEnabledAtom,
} from '../../store/atoms/geminiUsageAtoms';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';

interface GeminiUsagePopoverProps {
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

interface TokenRowProps {
  label: string;
  value: number;
  total: number;
  barClass: string;
}

const TokenRow: React.FC<TokenRowProps> = ({ label, value, total, barClass }) => {
  const percent = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <div className="text-[13px] font-semibold text-nim">{label}</div>
        <div className="text-[13px] font-semibold text-nim tabular-nums">
          {value.toLocaleString()}
        </div>
      </div>
      <div className="relative h-1.5 bg-nim-tertiary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barClass}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

export const GeminiUsagePopover: React.FC<GeminiUsagePopoverProps> = ({
  anchorRef,
  onClose,
  onRefresh,
}) => {
  const usage = useAtomValue(geminiUsageAtom);
  const setUsageIndicatorEnabled = useSetAtom(setGeminiUsageIndicatorEnabledAtom);
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const menu = useFloatingMenu({
    placement: 'right-end',
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  // Set the anchor element as the position reference
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

  const lastTurnTotal = usage.lastTurn
    ? usage.lastTurn.inputTokens + usage.lastTurn.outputTokens
    : 0;

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="w-60 bg-nim-secondary border border-nim rounded-lg shadow-lg z-50 overflow-y-auto"
        data-testid="gemini-usage-popover"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-nim">
          <div className="flex items-center gap-2">
            <MaterialSymbol icon="smart_toy" size={18} className="text-sky-500" />
            <span className="text-[14px] font-semibold text-nim">Gemini Usage</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-nim transition-colors disabled:opacity-50"
              aria-label="Refresh usage"
            >
              <MaterialSymbol icon="refresh" size={14} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
            <button
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
          <div className="flex justify-between items-baseline mb-3">
            <span className="text-[11px] uppercase tracking-wide text-nim-muted">Total tokens</span>
            <span className="text-[18px] font-semibold text-nim tabular-nums">
              {usage.totalTokens.toLocaleString()}
            </span>
          </div>

          <TokenRow
            label="Input"
            value={usage.totalInputTokens}
            total={usage.totalTokens}
            barClass="bg-sky-500"
          />
          <TokenRow
            label="Output"
            value={usage.totalOutputTokens}
            total={usage.totalTokens}
            barClass="bg-emerald-500"
          />

          <div className="mt-3 pt-3 border-t border-nim flex items-center justify-between text-[12px]">
            <span className="text-nim-muted">Turns</span>
            <span className="font-semibold text-nim tabular-nums">{usage.turnCount}</span>
          </div>

          {usage.lastTurn && (
            <div className="mt-2 flex items-center justify-between text-[12px]">
              <span className="text-nim-muted">Last turn</span>
              <span className="font-semibold text-nim tabular-nums">
                {lastTurnTotal.toLocaleString()}
                <span className="text-nim-muted font-normal">
                  {' '}({usage.lastTurn.inputTokens.toLocaleString()} in / {usage.lastTurn.outputTokens.toLocaleString()} out)
                </span>
              </span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-nim flex items-center justify-end">
          <button
            onClick={() => {
              setUsageIndicatorEnabled(false);
              onClose();
            }}
            className="text-[11px] text-nim-muted hover:text-nim transition-colors"
          >
            Disable
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
};
