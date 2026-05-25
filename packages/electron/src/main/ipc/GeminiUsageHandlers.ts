/**
 * IPC Handlers for Gemini Usage tracking
 */

import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import { getGeminiUsageService, GeminiUsageData } from '../services/GeminiUsageService';

export function registerGeminiUsageHandlers(): void {
  safeHandle('gemini-usage:get', async (): Promise<GeminiUsageData> => {
    return getGeminiUsageService().getUsage();
  });

  safeHandle('gemini-usage:refresh', async (): Promise<GeminiUsageData> => {
    return getGeminiUsageService().refresh();
  });

  safeHandle('gemini-usage:activity', async (): Promise<void> => {
    getGeminiUsageService().recordActivity();
  });

  logger.main.info('[GeminiUsageHandlers] Gemini usage IPC handlers registered');
}
