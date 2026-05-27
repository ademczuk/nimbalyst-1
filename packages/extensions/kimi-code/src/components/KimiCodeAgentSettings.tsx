/**
 * Settings panel for the Kimi Code AGENT provider.
 *
 * Mirrors KimiCodeSettings - both providers share the same Kimi Code CLI
 * OAuth login. The agent variant adds meta-agent host language.
 */

import React from 'react';
import { KimiCodeAgentProvider } from '../KimiCodeAgentProvider';
import { KimiCodeRpcClient, type KimiCodeAuthStatus } from '../kimiCodeRpcClient';

interface Model {
  id: string;
  name: string;
  provider: string;
}

interface ProviderConfig {
  enabled?: boolean;
  testStatus?: 'idle' | 'testing' | 'success' | 'error';
  testMessage?: string;
  models?: string[];
}

export interface KimiCodeAgentSettingsProps {
  config: ProviderConfig;
  apiKeys?: Record<string, string>;
  availableModels: Model[];
  loading?: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange?: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange?: (updates: Partial<ProviderConfig>) => void;
}

function formatRemaining(expiresAt: number): string {
  const remaining = expiresAt - Date.now() / 1000;
  if (remaining <= 0) return 'expired';
  if (remaining < 60) return `${Math.floor(remaining)}s`;
  if (remaining < 3600) return `${Math.floor(remaining / 60)} min`;
  return `${Math.floor(remaining / 3600)}h ${Math.floor((remaining % 3600) / 60)}m`;
}

export function KimiCodeAgentSettings({
  config,
  availableModels,
  loading,
  onToggle,
  onModelToggle,
  onSelectAllModels,
  onTestConnection,
}: KimiCodeAgentSettingsProps): React.ReactElement {
  const enabledModelIds = config.models ?? [];
  const allSelected = availableModels.length > 0
    && availableModels.every((m) => enabledModelIds.includes(m.id));

  const [authStatus, setAuthStatus] = React.useState<KimiCodeAuthStatus | null>(null);
  const [authProbing, setAuthProbing] = React.useState<boolean>(true);
  const [modelsError, setModelsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const probe = () => {
      KimiCodeRpcClient.authStatus()
        .then((s) => {
          if (!cancelled) {
            setAuthStatus(s);
            setAuthProbing(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAuthStatus({ state: 'not-logged-in' });
            setAuthProbing(false);
          }
        });
    };
    probe();
    const id = window.setInterval(probe, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const autoSelectFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (
      !autoSelectFiredRef.current
      && config.enabled
      && config.models === undefined
      && availableModels.length > 0
    ) {
      autoSelectFiredRef.current = true;
      onSelectAllModels(true);
    }
  }, [config.enabled, config.models, availableModels.length, onSelectAllModels]);

  const handleProbeModels = React.useCallback(() => {
    setModelsError(null);
    KimiCodeAgentProvider.getModels()
      .then(() => setModelsError(null))
      .catch((err: unknown) => {
        setModelsError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const isLoggedIn = authStatus?.state === 'valid';
  const canTest = !loading && config.testStatus !== 'testing' && (authStatus?.state ?? 'not-logged-in') !== 'not-logged-in';

  return (
    <div className="provider-panel kimi-code-agent-panel flex flex-col" data-testid="kimi-code-agent-settings">
      <div className="kimi-code-main-column flex-1 flex flex-col">
        <div className="provider-panel-header mb-4 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
            Kimi (Agent)
          </h3>
          <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
            Runs a Nimbalyst-orchestrated tool loop over Kimi using the
            Kimi Code endpoint. Supports meta-agent host mode: a Kimi agent
            session can spawn Claude or Codex child sessions mid-loop. Auth
            rides the same Kimi Code CLI login as the chat provider.
          </p>
        </div>

        {/* OAUTH STATUS CARD - shared shape with the chat panel */}
        <div
          className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]"
          data-testid="kimi-code-agent-oauth-status"
        >
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
            Kimi Code CLI authentication
          </h4>

          {authProbing && (
            <p className="text-[13px] text-[var(--nim-text-muted)]">Checking for Kimi Code CLI credentials...</p>
          )}

          {!authProbing && authStatus?.state === 'valid' && (
            <div className="flex items-center gap-3 p-3 rounded-lg border border-[var(--nim-success-border,rgba(34,197,94,0.2))] bg-[var(--nim-success-bg,rgba(34,197,94,0.05))]">
              <span className="w-2.5 h-2.5 rounded-full bg-[var(--nim-success)] shrink-0 animate-pulse" />
              <div>
                <p className="text-sm font-semibold text-[var(--nim-success-text,rgb(21,128,61))]">
                  Connected via Kimi Code CLI
                </p>
                <p className="text-[13px] text-[var(--nim-text-muted)] mt-0.5">
                  Access token valid for another <span className="font-semibold text-[var(--nim-text)]">{formatRemaining(authStatus.expiresAt)}</span>; refreshed in the background.
                </p>
              </div>
            </div>
          )}

          {!authProbing && authStatus?.state === 'expired' && (
            <div className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--nim-warning-border,rgba(234,179,8,0.2))] bg-[var(--nim-warning-bg,rgba(234,179,8,0.05))]">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--nim-warning)] shrink-0" />
                <p className="text-sm font-semibold text-[var(--nim-warning-text,rgb(161,98,7))]">
                  Kimi Code session expired
                </p>
              </div>
              <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
                The extension will try to refresh automatically. If that fails, open the Kimi Code CLI and run:
              </p>
              <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded select-text">
                /login
              </code>
            </div>
          )}

          {!authProbing && authStatus?.state === 'not-logged-in' && (
            <div className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-surface-2,rgba(0,0,0,0.02))]">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full bg-[var(--nim-text-muted)] shrink-0" />
                <p className="text-sm font-semibold text-[var(--nim-text)]">
                  Kimi Code CLI not logged in
                </p>
              </div>
              <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
                Open the Kimi Code CLI and run <code className="text-xs bg-[var(--nim-code-bg)] px-1 py-0.5 rounded">/login</code>. Nimbalyst picks up the credentials from <code className="text-xs bg-[var(--nim-code-bg)] px-1 py-0.5 rounded">~/.kimi/credentials/kimi-code.json</code>.
              </p>
            </div>
          )}
        </div>

        <div
          className="provider-panel-section py-3 mb-4 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] px-4"
          data-testid="kimi-code-agent-connection-test"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <h4 className="text-base font-semibold text-[var(--nim-text)] mb-1">
                Connection
              </h4>
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Same probe as the chat provider; both share the Kimi Code CLI access token.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { void onTestConnection().then(handleProbeModels); }}
              disabled={!canTest}
              className={`provider-test-button py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed ${
                config.testStatus === 'success' ? 'text-[var(--nim-success)] border-[var(--nim-success)]' : ''
              } ${
                config.testStatus === 'error' ? 'text-[var(--nim-error)] border-[var(--nim-error)]' : ''
              }`}
              data-testid="kimi-code-agent-test-button"
            >
              {config.testStatus === 'testing'
                ? 'Testing...'
                : config.testStatus === 'success'
                ? 'Connected'
                : config.testStatus === 'error'
                ? 'Failed'
                : 'Test connection'}
            </button>
          </div>
          {config.testMessage && config.testStatus === 'error' && (
            <div className="text-xs mt-2 text-[var(--nim-error)]">
              {config.testMessage}
            </div>
          )}
        </div>

        <div className="provider-panel-section py-3 mb-4 border-b border-[var(--nim-border)] flex items-center justify-between">
          <label htmlFor="kc-agent-enable" className="text-sm font-medium text-[var(--nim-text)]">
            Enable Kimi (Agent)
          </label>
          <input
            id="kc-agent-enable"
            type="checkbox"
            checked={config.enabled || false}
            onChange={(e) => onToggle(e.target.checked)}
            className="cursor-pointer"
          />
        </div>

        {config.enabled && (
          <>
            <div
              className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0"
              data-testid="kimi-code-agent-models-list"
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)]">
                  Models
                </h4>
                {availableModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onSelectAllModels(!allSelected)}
                    className="text-[13px] text-[var(--nim-primary)] hover:underline"
                  >
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                )}
              </div>

              {availableModels.length === 0 ? (
                <>
                  {modelsError && !loading && (
                    <p className="text-[13px] text-[var(--nim-error)] mb-2">
                      {modelsError}
                    </p>
                  )}
                  <p className="text-[13px] text-[var(--nim-text-muted)]">
                    {loading
                      ? 'Loading models...'
                      : isLoggedIn
                        ? 'No models found. Test the connection to fetch the live catalog.'
                        : 'Log in via the Kimi Code CLI to load the model catalog.'}
                  </p>
                </>
              ) : (
                <ul className="provider-model-list flex flex-col gap-1">
                  {availableModels.map((model) => (
                    <li key={model.id} className="provider-model-row flex items-center gap-2 py-1">
                      <input
                        type="checkbox"
                        id={`kc-agent-model-${model.id}`}
                        checked={enabledModelIds.includes(model.id)}
                        onChange={(e) => onModelToggle(model.id, e.target.checked)}
                      />
                      <label htmlFor={`kc-agent-model-${model.id}`} className="text-sm text-[var(--nim-text)]">
                        {model.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="provider-panel-section py-3">
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Default model is <strong>kimi-for-coding</strong> (Kimi, 256K context).
                Meta-agent mode activates when a session has agentRole = meta-agent;
                the Kimi agent can then spawn Claude or Codex child sessions.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
