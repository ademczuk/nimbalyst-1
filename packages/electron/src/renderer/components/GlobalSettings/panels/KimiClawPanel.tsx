import React, { useState, useCallback } from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface KimiClawPanelProps {
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

type AuthMethod = 'cookie' | 'bearer';
type DefaultMode = 'crew' | 'classic';
type HealthStatus = 'idle' | 'checking' | 'success' | 'error';
type TokenGenStatus = 'idle' | 'generating' | 'success' | 'error';

interface KimiClawConfig {
  endpointUrl: string;
  authMethod: AuthMethod;
  username: string;
  password: string;
  bearerToken: string;
  defaultMode: DefaultMode;
  maxAgents: number;
  maxSteps: number;
  maxParallel: number | null;
  verboseLogging: boolean;
}

function parseKimiClawConfig(config: ProviderConfig): KimiClawConfig {
  return {
    endpointUrl: (config.endpointUrl as string) || 'http://127.0.0.1:9643',
    authMethod: (config.authMethod as AuthMethod) || 'cookie',
    username: (config.username as string) || 'admin',
    password: (config.password as string) || 'admin',
    bearerToken: (config.bearerToken as string) || '',
    defaultMode: (config.defaultMode as DefaultMode) || 'crew',
    maxAgents: (config.maxAgents as number) || 4,
    maxSteps: (config.maxSteps as number) || 12,
    maxParallel: (config.maxParallel as number | null) ?? null,
    verboseLogging: (config.verboseLogging as boolean) || false,
  };
}

export function KimiClawPanel({
  config,
  onToggle,
  onTestConnection,
  onConfigChange,
}: KimiClawPanelProps) {
  const kc = parseKimiClawConfig(config);

  const [healthStatus, setHealthStatus] = useState<HealthStatus>(config.testStatus as HealthStatus || 'idle');
  const [healthMessage, setHealthMessage] = useState<string>(config.testMessage || '');
  const [tokenGenStatus, setTokenGenStatus] = useState<TokenGenStatus>('idle');
  const [tokenGenMessage, setTokenGenMessage] = useState<string>('');

  const handleConfigUpdate = useCallback(
    (updates: Partial<KimiClawConfig>) => {
      onConfigChange(updates as Partial<ProviderConfig>);
    },
    [onConfigChange]
  );

  const handleAuthMethodChange = (method: AuthMethod) => {
    handleConfigUpdate({ authMethod: method });
  };

  const handleHealthCheck = async () => {
    setHealthStatus('checking');
    setHealthMessage('');

    // Wrap the parent's test connection to capture status
    try {
      await onTestConnection();
      setHealthStatus('success');
      setHealthMessage('KCS is reachable');
    } catch {
      setHealthStatus('error');
      setHealthMessage('KCS is unreachable');
    }
  };

  const handleGenerateToken = async () => {
    setTokenGenStatus('generating');
    setTokenGenMessage('');

    try {
      // Step 1: POST /api/login with username/password
      const loginRes = await fetch(`${kc.endpointUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: kc.username,
          password: kc.password,
        }),
      });

      if (!loginRes.ok) {
        const err = await loginRes.text().catch(() => 'Login failed');
        setTokenGenStatus('error');
        setTokenGenMessage(`Login failed: ${err}`);
        return;
      }

      // Step 2: POST /api/tokens to create a new bearer token
      const tokenRes = await fetch(`${kc.endpointUrl}/api/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Use the cookie session from login for auth
          Cookie: loginRes.headers.get('set-cookie') || '',
        },
        body: JSON.stringify({ name: 'nimbalyst-kimiclaw' }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text().catch(() => 'Token generation failed');
        setTokenGenStatus('error');
        setTokenGenMessage(`Token generation failed: ${err}`);
        return;
      }

      const tokenData = await tokenRes.json().catch(() => null);
      const token = tokenData?.token || tokenData?.value || '';

      if (token) {
        handleConfigUpdate({ bearerToken: token });
        setTokenGenStatus('success');
        setTokenGenMessage('Token generated and saved');
      } else {
        setTokenGenStatus('error');
        setTokenGenMessage('No token returned from server');
      }
    } catch (err) {
      setTokenGenStatus('error');
      setTokenGenMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const healthButtonText =
    healthStatus === 'checking'
      ? 'Checking...'
      : healthStatus === 'success'
        ? '✓ Healthy'
        : healthStatus === 'error'
          ? '✗ Unhealthy'
          : 'Health Check';

  return (
    <div className="provider-panel flex flex-col">
      {/* Header */}
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          KimiClaw
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Connect to KimiClaw Server (KCS) for multi-agent orchestration.
          Configure your local KCS endpoint and authentication to enable
          Crew (persona) and Classic agent modes.
        </p>
      </div>

      {/* Enable Toggle */}
      <SettingsToggle
        variant="enable"
        name="Enable KimiClaw"
        description="Enable KimiClaw agent provider for multi-agent orchestration."
        checked={config.enabled}
        onChange={onToggle}
      />

      {config.enabled && (
        <>
          {/* Connection Section */}
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
              Connection
            </h4>

            {/* Endpoint URL */}
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-sm font-medium text-[var(--nim-text)]">
                Endpoint URL
              </label>
              <input
                type="text"
                value={kc.endpointUrl}
                onChange={(e) => handleConfigUpdate({ endpointUrl: e.target.value })}
                onFocus={(e) => e.target.select()}
                placeholder="http://127.0.0.1:9643"
                className="flex-1 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono text-sm focus:border-[var(--nim-primary)]"
              />
              <p className="text-xs text-[var(--nim-text-muted)]">
                The base URL of your KimiClaw Server instance.
              </p>
            </div>

            {/* Health Check */}
            <div className="flex items-center gap-3">
              <button
                className={`inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] ${
                  healthStatus === 'checking' ? 'opacity-60 cursor-wait' : ''
                } ${
                  healthStatus === 'success'
                    ? 'text-[var(--nim-success)] border-[var(--nim-success)]'
                    : ''
                } ${
                  healthStatus === 'error'
                    ? 'text-[var(--nim-error)] border-[var(--nim-error)]'
                    : ''
                }`}
                onClick={handleHealthCheck}
                disabled={healthStatus === 'checking'}
              >
                {healthButtonText}
              </button>
              {healthMessage && healthStatus === 'error' && (
                <span className="text-xs text-[var(--nim-error)]">{healthMessage}</span>
              )}
              {healthMessage && healthStatus === 'success' && (
                <span className="text-xs text-[var(--nim-success)]">{healthMessage}</span>
              )}
            </div>
          </div>

          {/* Authentication Section */}
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
              Authentication
            </h4>

            {/* Auth Method Radio Buttons */}
            <div className="flex flex-col gap-2 mb-4">
              <span className="text-sm font-medium text-[var(--nim-text)]">Auth method</span>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="kimiclaw-auth"
                    value="cookie"
                    checked={kc.authMethod === 'cookie'}
                    onChange={() => handleAuthMethodChange('cookie')}
                    className="cursor-pointer accent-[var(--nim-primary)]"
                  />
                  <span className="text-sm text-[var(--nim-text)]">Cookie session</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="kimiclaw-auth"
                    value="bearer"
                    checked={kc.authMethod === 'bearer'}
                    onChange={() => handleAuthMethodChange('bearer')}
                    className="cursor-pointer accent-[var(--nim-primary)]"
                  />
                  <span className="text-sm text-[var(--nim-text)]">Bearer token</span>
                </label>
              </div>
            </div>

            {/* Cookie Session Fields */}
            {kc.authMethod === 'cookie' && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-[var(--nim-text)]">
                    Username
                  </label>
                  <input
                    type="text"
                    value={kc.username}
                    onChange={(e) => handleConfigUpdate({ username: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    placeholder="admin"
                    className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none text-sm focus:border-[var(--nim-primary)]"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-[var(--nim-text)]">
                    Password
                  </label>
                  <input
                    type="password"
                    value={kc.password}
                    onChange={(e) => handleConfigUpdate({ password: e.target.value })}
                    onFocus={(e) => e.target.select()}
                    placeholder="admin"
                    className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none text-sm focus:border-[var(--nim-primary)]"
                  />
                </div>
              </div>
            )}

            {/* Bearer Token Fields */}
            {kc.authMethod === 'bearer' && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-[var(--nim-text)]">
                    Bearer token
                  </label>
                  <div className="flex gap-2 items-center">
                    <input
                      type="password"
                      value={kc.bearerToken}
                      onChange={(e) => handleConfigUpdate({ bearerToken: e.target.value })}
                      onFocus={(e) => e.target.select()}
                      placeholder="Paste a token or generate one below"
                      className="flex-1 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono text-sm focus:border-[var(--nim-primary)]"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    className={`inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] ${
                      tokenGenStatus === 'generating'
                        ? 'opacity-60 cursor-wait'
                        : ''
                    } ${
                      tokenGenStatus === 'success'
                        ? 'text-[var(--nim-success)] border-[var(--nim-success)]'
                        : ''
                    } ${
                      tokenGenStatus === 'error'
                        ? 'text-[var(--nim-error)] border-[var(--nim-error)]'
                        : ''
                    }`}
                    onClick={handleGenerateToken}
                    disabled={
                      tokenGenStatus === 'generating' ||
                      !kc.username ||
                      !kc.password
                    }
                    title={
                      !kc.username || !kc.password
                        ? 'Set username and password first'
                        : 'Generate a bearer token using cookie credentials'
                    }
                  >
                    <MaterialSymbol icon="key" size={16} className="mr-1.5" />
                    {tokenGenStatus === 'generating'
                      ? 'Generating...'
                      : tokenGenStatus === 'success'
                        ? '✓ Token generated'
                        : 'Generate token'}
                  </button>
                  {tokenGenMessage && tokenGenStatus === 'error' && (
                    <span className="text-xs text-[var(--nim-error)]">
                      {tokenGenMessage}
                    </span>
                  )}
                  {tokenGenMessage && tokenGenStatus === 'success' && (
                    <span className="text-xs text-[var(--nim-success)]">
                      {tokenGenMessage}
                    </span>
                  )}
                </div>
                <p className="text-xs text-[var(--nim-text-muted)]">
                  Token generation uses the cookie credentials above to create a
                  long-lived bearer token. Ensure username and password are set
                  even when using bearer authentication.
                </p>
              </div>
            )}
          </div>

          {/* Agent Configuration Section */}
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
              Agent Configuration
            </h4>

            {/* Default Mode */}
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-sm font-medium text-[var(--nim-text)]">
                Default mode
              </label>
              <select
                value={kc.defaultMode}
                onChange={(e) =>
                  handleConfigUpdate({ defaultMode: e.target.value as DefaultMode })
                }
                className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none text-sm focus:border-[var(--nim-primary)] cursor-pointer"
              >
                <option value="crew">Crew (persona)</option>
                <option value="classic">Classic</option>
              </select>
              <p className="text-xs text-[var(--nim-text-muted)]">
                Crew mode uses persona-based orchestration. Classic mode uses a
                single agent loop.
              </p>
            </div>

            {/* Max Agents */}
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-sm font-medium text-[var(--nim-text)]">
                Max agents
              </label>
              <input
                type="number"
                min={1}
                max={32}
                value={kc.maxAgents}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val) && val >= 1 && val <= 32) {
                    handleConfigUpdate({ maxAgents: val });
                  }
                }}
                className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none text-sm font-mono focus:border-[var(--nim-primary)] w-24"
              />
              <p className="text-xs text-[var(--nim-text-muted)]">
                Maximum number of agents that can be spawned (1–32).
              </p>
            </div>

            {/* Max Steps */}
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-sm font-medium text-[var(--nim-text)]">
                Max steps
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={kc.maxSteps}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val) && val >= 1 && val <= 100) {
                    handleConfigUpdate({ maxSteps: val });
                  }
                }}
                className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none text-sm font-mono focus:border-[var(--nim-primary)] w-24"
              />
              <p className="text-xs text-[var(--nim-text-muted)]">
                Maximum steps per agent session (1–100).
              </p>
            </div>

            {/* Max Parallel */}
            <div className="flex flex-col gap-1.5 mb-4">
              <label className="text-sm font-medium text-[var(--nim-text)]">
                Max parallel{' '}
                <span className="font-normal text-[var(--nim-text-muted)]">
                  (optional)
                </span>
              </label>
              <input
                type="number"
                min={1}
                value={kc.maxParallel ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '') {
                    handleConfigUpdate({ maxParallel: null });
                  } else {
                    const n = parseInt(val, 10);
                    if (!isNaN(n) && n >= 1) {
                      handleConfigUpdate({ maxParallel: n });
                    }
                  }
                }}
                placeholder="Engine default"
                className="py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none text-sm font-mono focus:border-[var(--nim-primary)] w-24"
              />
              <p className="text-xs text-[var(--nim-text-muted)]">
                Leave blank to use the engine default.
              </p>
            </div>
          </div>

          {/* Logging Section */}
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <SettingsToggle
              name="Verbose logging"
              description="Render raw events in the transcript panel for debugging."
              checked={kc.verboseLogging}
              onChange={(checked) => handleConfigUpdate({ verboseLogging: checked })}
            />
          </div>
        </>
      )}
    </div>
  );
}
