import React from 'react';
import { ProviderConfig, Model } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';

/**
 * Shared settings panel for the single-brain OpenClaw chat providers
 * (Anismin, Meridian). Both expose the same FastAPI /api/chat contract,
 * so the panel is identical apart from name/description/default endpoint.
 * Enable toggle + endpoint field + test button. No API key (the brain
 * uses its own local OpenClaw OAuth).
 */
interface OpenClawBrainPanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  availableModels: Model[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange: (updates: Partial<ProviderConfig>) => void;
  // Brain-specific labels injected by SettingsView.
  brainName: string;
  brainDescription: string;
  defaultEndpoint: string;
}

export function OpenClawBrainPanel({
  config,
  onToggle,
  onTestConnection,
  onConfigChange,
  brainName,
  brainDescription,
  defaultEndpoint,
}: OpenClawBrainPanelProps) {
  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">{brainName}</h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          {brainDescription}
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name={`Enable ${brainName}`}
        checked={config.enabled}
        onChange={onToggle}
      />

      {config.enabled && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Brain Endpoint</h4>
          <p className="text-xs text-[var(--nim-text-muted)] mb-3">
            The brain's HTTP chat endpoint. Single prompt in, one reply out — no swarm.
          </p>
          <div className="api-key-section mt-2">
            <div className="api-key-row flex gap-2 items-center">
              <input
                type="text"
                value={(config as ProviderConfig & { endpoint?: string }).endpoint || defaultEndpoint}
                onChange={(e) => onConfigChange({ endpoint: e.target.value } as Partial<ProviderConfig>)}
                onFocus={(e) => e.target.select()}
                placeholder={defaultEndpoint}
                className="api-key-input flex-1 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono focus:border-[var(--nim-primary)]"
              />
              <button
                className={`test-button inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] ${
                  config.testStatus === 'testing' ? 'opacity-60 cursor-wait' : ''
                } ${config.testStatus === 'success' ? 'text-[var(--nim-success)] border-[var(--nim-success)]' : ''} ${
                  config.testStatus === 'error' ? 'text-[var(--nim-error)] border-[var(--nim-error)]' : ''
                }`}
                onClick={onTestConnection}
                disabled={config.testStatus === 'testing'}
              >
                {config.testStatus === 'testing' ? 'Testing...' :
                 config.testStatus === 'success' ? '✓ Connected' :
                 config.testStatus === 'error' ? '✗ Failed' : 'Test'}
              </button>
            </div>
            {config.testMessage && config.testStatus === 'error' && (
              <div className="test-error text-xs mt-2 text-[var(--nim-error)]">{config.testMessage}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
