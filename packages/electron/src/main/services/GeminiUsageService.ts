/**
 * GeminiUsageService - Tracks cumulative Gemini CLI token usage
 *
 * Unlike Codex (which exposes rate-limit windows), Gemini only provides
 * per-turn token counts. This service keeps a running cumulative total
 * across the app session and broadcasts updates to the renderer on every
 * change. There is no polling and no rate-limit window concept here.
 *
 * Usage is fed in from MessageStreamingHandler when a 'gemini-cli' session
 * yields a 'complete' chunk carrying `usage`.
 */

import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

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

interface GeminiUsageInput {
  input_tokens?: number;
  output_tokens?: number;
}

class GeminiUsageServiceImpl {
  private usage: GeminiUsageData = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    turnCount: 0,
    lastTurn: null,
  };

  initialize(): void {
    logger.main.info('[GeminiUsageService] Initialized');
  }

  /**
   * Record a single turn's usage. Adds to cumulative totals, increments the
   * turn count, stamps lastTurn, and broadcasts the full shape to all windows.
   */
  record(usage: GeminiUsageInput): void {
    const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
    const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;

    this.usage.totalInputTokens += inputTokens;
    this.usage.totalOutputTokens += outputTokens;
    this.usage.totalTokens = this.usage.totalInputTokens + this.usage.totalOutputTokens;
    this.usage.turnCount += 1;
    this.usage.lastTurn = { inputTokens, outputTokens };

    this.broadcastUpdate();
  }

  getUsage(): GeminiUsageData {
    return { ...this.usage, lastTurn: this.usage.lastTurn ? { ...this.usage.lastTurn } : null };
  }

  // Kept for parity with CodexUsageService's IPC surface. Gemini has no
  // polling or rate-limit windows, so these are no-ops.
  recordActivity(): void {
    // no-op
  }

  refresh(): GeminiUsageData {
    return this.getUsage();
  }

  private broadcastUpdate(): void {
    const snapshot = this.getUsage();
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('gemini-usage:update', snapshot);
      }
    }
  }
}

// Singleton instance
const geminiUsageService = new GeminiUsageServiceImpl();

export function getGeminiUsageService(): GeminiUsageServiceImpl {
  return geminiUsageService;
}
