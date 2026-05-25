import React, { useState, useEffect, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge } from '../../common/AlphaBadge';
import {
  geminiUsageIndicatorEnabledAtom,
  setGeminiUsageIndicatorEnabledAtom,
} from '../../../store/atoms/geminiUsageAtoms';

interface GeminiPanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  availableModels: any[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange: (updates: Partial<ProviderConfig>) => void;
}

type CLIStatus = 'checking' | 'installed' | 'not-installed' | 'installing' | 'install-error';
type OAuthStatus = 'checking' | 'installed' | 'expired' | 'not-installed' | 'error';

export function GeminiPanel({
  config,
  onToggle,
}: GeminiPanelProps) {
  const usageIndicatorEnabled = useAtomValue(geminiUsageIndicatorEnabledAtom);
  const setUsageIndicatorEnabled = useSetAtom(setGeminiUsageIndicatorEnabledAtom);

  const [cliStatus, setCLIStatus] = useState<CLIStatus>('checking');
  const [cliVersion, setCLIVersion] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>('checking');
  const [oauthEmail, setOauthEmail] = useState<string>('');
  const [oauthName, setOauthName] = useState<string>('');

  const checkCLI = useCallback(async () => {
    setCLIStatus('checking');
    try {
      const result = await window.electronAPI.invoke('cli:checkInstallation', 'gemini-cli');
      if (result?.installed) {
        setCLIVersion(result.version || null);
        setCLIStatus('installed');
      } else {
        setCLIStatus('not-installed');
      }
    } catch {
      setCLIStatus('not-installed');
    }
  }, []);

  const checkOAuthStatus = useCallback(async () => {
    setOauthStatus('checking');
    try {
      const result = await window.electronAPI.aiGetGeminiOAuthStatus();
      if (result) {
        setOauthStatus(result.status);
        setOauthEmail(result.email || '');
        setOauthName(result.name || '');
      } else {
        setOauthStatus('not-installed');
      }
    } catch {
      setOauthStatus('error');
    }
  }, []);

  useEffect(() => {
    checkCLI();
    checkOAuthStatus();
  }, [checkCLI, checkOAuthStatus]);

  const handleInstall = async () => {
    setCLIStatus('installing');
    setInstallError(null);
    try {
      await window.electronAPI.invoke('cli:install', 'gemini-cli', {});
      await checkCLI();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
      setCLIStatus('install-error');
    }
  };

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          Google Gemini (CLI)
          <AlphaBadge size="sm" />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Run high-performance agent sessions locally using the official Google Gemini CLI. 
          Integrates automatically using your active terminal OAuth login for authentication, requiring zero manual API keys.
        </p>
      </div>

      {/* CLI Tool Installation Status */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Gemini CLI Tool</h4>

        {cliStatus === 'checking' && (
          <p className="text-[13px] text-[var(--nim-text-muted)]">Checking for Google Gemini CLI...</p>
        )}

        {cliStatus === 'installed' && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--nim-success)] shrink-0" />
            <span className="text-[13px] text-[var(--nim-text)]">
              Installed{cliVersion ? ` (${cliVersion})` : ''}
            </span>
          </div>
        )}

        {(cliStatus === 'not-installed' || cliStatus === 'install-error') && (
          <div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              The Google Gemini CLI tool is required to orchestrate these sessions. Install it globally:
            </p>
            <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded mb-3 select-text">
              npm install -g @google/gemini-cli
            </code>
            <button
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-primary)] text-white border border-[var(--nim-primary)] hover:opacity-90"
              onClick={handleInstall}
            >
              Install Gemini CLI
            </button>
            {installError && (
              <div className="text-xs mt-2 text-[var(--nim-error)]">
                {installError}
                <p className="mt-1 text-[var(--nim-text-muted)]">
                  Try running manually: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">npm install -g @google/gemini-cli</code>
                </p>
              </div>
            )}
          </div>
        )}

        {cliStatus === 'installing' && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--nim-text-muted)]">Installing Google Gemini CLI...</span>
          </div>
        )}
      </div>

      {/* Enable Toggle */}
      <SettingsToggle
        variant="enable"
        name="Enable Google Gemini (via CLI OAuth)"
        checked={config.enabled || false}
        onChange={onToggle}
      />

      <SettingsToggle
        variant="enable"
        name="Show Usage Indicator"
        description="Display cumulative Gemini token usage in the navigation gutter"
        checked={usageIndicatorEnabled}
        onChange={setUsageIndicatorEnabled}
      />

      {/* OAuth Credentials Authentication Card */}
      {config.enabled && (
        <div className="provider-panel-section py-4 mt-4 border-t border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Google Authentication</h4>
          
          {oauthStatus === 'checking' && (
            <p className="text-[13px] text-[var(--nim-text-muted)]">Scanning for terminal credentials...</p>
          )}

          {oauthStatus === 'installed' && (
            <div className="flex items-center gap-3 p-4 rounded-lg border border-[var(--nim-success-border,rgba(34,197,94,0.2))] bg-[var(--nim-success-bg,rgba(34,197,94,0.05))]">
              <span className="w-2.5 h-2.5 rounded-full bg-[var(--nim-success)] shrink-0 animate-pulse" />
              <div>
                <p className="text-sm font-semibold text-[var(--nim-success-text,rgb(21,128,61))]">Connected with Google OAuth</p>
                <p className="text-[13px] text-[var(--nim-text-muted)] mt-0.5">
                  Logged in as <span className="font-semibold text-[var(--nim-text)]">{oauthName}</span> ({oauthEmail})
                </p>
              </div>
            </div>
          )}

          {oauthStatus === 'expired' && (
            <div className="flex flex-col gap-3 p-4 rounded-lg border border-[var(--nim-warning-border,rgba(234,179,8,0.2))] bg-[var(--nim-warning-bg,rgba(234,179,8,0.05))]">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--nim-warning)] shrink-0 animate-pulse" />
                <div>
                  <p className="text-sm font-semibold text-[var(--nim-warning-text,rgb(161,98,7))]">Google OAuth Session Expired</p>
                  <p className="text-[13px] text-[var(--nim-text-muted)] mt-0.5">
                    Credentials found for <span className="font-semibold">{oauthName}</span> ({oauthEmail}) but the login token has expired.
                  </p>
                </div>
              </div>
              <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
                The Gemini CLI will automatically refresh your credentials on the next agent run using the stored refresh token. 
                Alternatively, you can manually authenticate by running:
              </p>
              <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded select-text">
                gemini -p "test prompt"
              </code>
            </div>
          )}

          {(oauthStatus === 'not-installed' || oauthStatus === 'error') && (
            <div className="flex flex-col gap-3 p-4 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-surface-2,rgba(0,0,0,0.02))]">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--nim-text-muted)] shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-[var(--nim-text)]">Google OAuth Session Not Found</p>
                  <p className="text-[13px] text-[var(--nim-text-muted)] mt-0.5">
                    No active login credentials detected in <code className="text-xs bg-[var(--nim-code-bg)] px-1 py-0.5 rounded">~/.gemini/oauth_creds.json</code>.
                  </p>
                </div>
              </div>
              <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
                Please complete the quick Google OAuth CLI authentication flow to authorize access. 
                Open your terminal and run:
              </p>
              <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded select-text">
                gemini -p "hello"
              </code>
              <p className="text-[12px] text-[var(--nim-text-muted)]">
                This will automatically open your web browser to perform a secure login to your Google Account.
              </p>
            </div>
          )}

          <div className="mt-4">
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              Model parameters and access credentials are fully synchronized with the global CLI configuration. 
              The default agent model defaults to <code className="text-xs bg-[var(--nim-code-bg)] px-1 py-0.5 rounded">gemini-2.5-flash</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
