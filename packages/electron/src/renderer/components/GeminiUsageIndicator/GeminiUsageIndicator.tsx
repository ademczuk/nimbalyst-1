/**
 * GeminiUsageIndicator - Cumulative token counter for Gemini usage
 *
 * Gemini only reports per-turn token counts, so instead of a 5h/7d
 * utilization ring (like Codex) this renders the cumulative session token
 * count (e.g. "12.3k") in the navigation gutter. Clicking opens a popover
 * with the input/output breakdown, turn count, and the most recent turn.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  geminiUsageAtom,
  geminiUsageAvailableAtom,
  geminiUsageIndicatorEnabledAtom,
  formatTokenCount,
} from '../../store/atoms/geminiUsageAtoms';
import { GeminiUsagePopover } from './GeminiUsagePopover';
import { refreshGeminiUsage } from '../../store/listeners/geminiUsageListeners';

interface GeminiUsageIndicatorProps {
  className?: string;
}

export const GeminiUsageIndicator: React.FC<GeminiUsageIndicatorProps> = ({ className }) => {
  const usage = useAtomValue(geminiUsageAtom);
  const isAvailable = useAtomValue(geminiUsageAvailableAtom);
  const isEnabled = useAtomValue(geminiUsageIndicatorEnabledAtom);

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    setIsPopoverOpen((prev) => !prev);
  }, []);

  const handleRefresh = useCallback(async () => {
    await refreshGeminiUsage();
  }, []);

  if (!isEnabled || !isAvailable) {
    return null;
  }

  const totalLabel = formatTokenCount(usage.totalTokens);
  const tooltipContent = `Gemini: ${usage.totalTokens.toLocaleString()} tokens across ${usage.turnCount} turn${usage.turnCount === 1 ? '' : 's'}`;

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        onClick={handleClick}
        title={tooltipContent}
        className="relative w-9 h-9 flex flex-col items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Gemini Usage"
        data-testid="gemini-usage-indicator"
      >
        <MaterialSymbol icon="smart_toy" size={16} className="text-nim-muted leading-none" />
        <span className="text-[9px] font-semibold text-nim leading-none mt-0.5">
          {totalLabel}
        </span>
      </button>

      {isPopoverOpen && (
        <GeminiUsagePopover
          anchorRef={buttonRef}
          onClose={() => setIsPopoverOpen(false)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
};
