/**
 * AntigravityUsageIndicator - Circular progress chip for Antigravity credits
 *
 * Mirrors CodexUsageIndicator. Renders a small ring + percent badge in the
 * navigation gutter showing remaining account prompt credits. Clicking opens
 * the AntigravityUsagePopover with full account + per-model quota details.
 *
 * Visibility: only when at least one of the two contributed antigravity
 * providers (antigravity-gemini / antigravity-gemini-agent) is enabled in
 * the user's providerSettings.
 *
 * Inverted color scale relative to Codex: we show REMAINING credits, so
 * red = low (<=10%), yellow = medium (<=25%), green = healthy.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
  antigravityUsageAtom,
  antigravityIndicatorVisibleAtom,
  antigravityCreditsColorAtom,
  antigravityCreditsPercentAtom,
} from '../../store/atoms/antigravityUsageAtoms';
import { AntigravityUsagePopover } from './AntigravityUsagePopover';
import { refreshAntigravityUsage } from '../../store/listeners/antigravityUsageListeners';

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface AntigravityUsageIndicatorProps {
  className?: string;
}

export const AntigravityUsageIndicator: React.FC<AntigravityUsageIndicatorProps> = ({
  className,
}) => {
  const usage = useAtomValue(antigravityUsageAtom);
  const visible = useAtomValue(antigravityIndicatorVisibleAtom);
  const creditsColor = useAtomValue(antigravityCreditsColorAtom);
  const creditsPercent = useAtomValue(antigravityCreditsPercentAtom);

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const didFetchRef = useRef(false);

  // CLA-185 DIAGNOSTIC: every render logs the visibility + data summary so we
  // can compare what the chip saw against what the panels saw. If visible is
  // false here but the panels report enabled:true, that pinpoints the
  // antigravityIndicatorVisibleAtom gate as the disconnect.
  console.log('[AntigravityUsageIndicator] render', {
    visible,
    hasData: usage !== null,
    hasError: Boolean(usage?.error),
    creditsPercent,
    creditsColor,
    isPopoverOpen,
  });

  // CLA-185 DIAGNOSTIC: mount + unmount lifecycle so we can detect if the
  // component never mounted at all (e.g. parent rendered something else).
  useEffect(() => {
    console.log('[AntigravityUsageIndicator] mount', { visible, hasData: usage !== null });
    return () => {
      console.log('[AntigravityUsageIndicator] unmount');
    };
    // Intentionally empty deps - one-shot mount/unmount log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch usage once when the indicator first becomes visible. Repeated
  // refreshes are user-driven via the popover Refresh button (the underlying
  // RPC cold-starts the language server, so background polling would be
  // expensive).
  useEffect(() => {
    if (visible && !didFetchRef.current) {
      console.log(
        '[AntigravityUsageIndicator] visible became true, firing initial refreshAntigravityUsage()',
      );
      didFetchRef.current = true;
      void refreshAntigravityUsage();
    }
    if (!visible) {
      // Reset so re-enabling triggers a fresh fetch.
      didFetchRef.current = false;
    }
  }, [visible]);

  const handleClick = useCallback(() => {
    setIsPopoverOpen((prev) => !prev);
  }, []);

  const handleRefresh = useCallback(async () => {
    await refreshAntigravityUsage();
  }, []);

  if (!visible) {
    // CLA-185 DIAGNOSTIC: explicit log on the hidden path so the absence of
    // [AntigravityUsageIndicator] render-visible lines is easy to grep for.
    console.log('[AntigravityUsageIndicator] returning null (visible=false)');
    return null;
  }
  console.log('[AntigravityUsageIndicator] rendering visible chip', {
    creditsPercent,
    creditsColor,
    hasData: usage !== null,
  });

  const hasError = Boolean(usage?.error);
  const utilization = creditsPercent !== null ? 100 - creditsPercent : 0;
  // For the ring we draw the FILLED portion (matches Codex's util ring).
  // Since we're showing remaining, the filled portion is what's GONE.
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - utilization / 100);

  const strokeColorClasses: Record<string, string> = {
    green: 'stroke-green-500',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };
  const strokeColor = strokeColorClasses[creditsColor] || strokeColorClasses.muted;

  const tooltipContent = hasError
    ? `Antigravity usage unavailable: ${usage?.error ?? 'unknown error'}`
    : creditsPercent !== null
      ? `Antigravity: ${creditsPercent}% credits remaining`
      : 'Antigravity usage (no quota reported)';

  return (
    <div className={`relative antigravity-usage-indicator ${className || ''}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleClick}
        title={tooltipContent}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Antigravity Usage"
        data-testid="antigravity-usage-indicator"
      >
        <svg width="32" height="32" viewBox="0 0 32 32" className="transform -rotate-90">
          {/* Background ring */}
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            className="stroke-nim-tertiary"
            strokeWidth="3"
          />
          {/* Progress ring (filled portion = consumed credits) */}
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            className={strokeColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
            style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-nim">
          {creditsPercent !== null ? `${creditsPercent}%` : '--'}
        </span>
      </button>

      {isPopoverOpen && (
        <AntigravityUsagePopover
          anchorRef={buttonRef}
          onClose={() => setIsPopoverOpen(false)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
};
