import React, { useState, useEffect } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol, getProviderIcon } from '@nimbalyst/runtime';
import { isAgentProvider, shouldBlockStartedSessionProviderSwitch } from '@nimbalyst/runtime/ai/server/types';
import { ProviderRegistry } from '@nimbalyst/runtime/ai/server/ProviderRegistry';
import { getClaudeCodeModelLabel } from '../../utils/modelUtils';
import { providersAtom } from '../../store/atoms/appSettings';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { navigateToSettingsAtom } from '../../store/atoms/settingsNavigation';
import type { SettingsCategory } from '../Settings/SettingsSidebar';
import { AlphaBadge } from '../common/AlphaBadge';
import { HelpTooltip } from '../../help';

const ALPHA_PROVIDERS = new Set(['opencode', 'copilot-cli', 'gemini-cli']);

interface Model {
  id: string;
  name: string;
  provider: string;
}

type ProviderType = 'agent' | 'model';

interface ModelSelectorProps {
  currentModel: string;  // Full provider:model ID
  onModelChange: (modelId: string) => void;
  sessionHasMessages?: boolean;  // Whether current session has any messages
  currentProvider?: string | null;  // Current session provider
  /**
   * Render the current model as a non-interactive chip (no dropdown). Used for
   * committed claude-code-cli sessions where the model is fixed at spawn — we
   * still want to SHOW which provider/model is running, just not let it change.
   */
  readOnly?: boolean;
  /** Tooltip shown on the read-only chip explaining why it can't change. */
  readOnlyTitle?: string;
}

export function ModelSelector({
  currentModel,
  onModelChange,
  sessionHasMessages = false,
  currentProvider = null,
  readOnly = false,
  readOnlyTitle,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState<Record<string, Model[]>>({});
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const [providerIcons, setProviderIcons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const providers = useAtomValue(providersAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const navigateToSettings = useSetAtom(navigateToSettingsAtom);
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ fallbackPlacements: ['bottom-start', 'top-end', 'bottom-end'], padding: 8 }),
      shift({ padding: 8 }),
    ],
  });
  const dismiss = useDismiss(context, {
    escapeKey: true,
    outsidePress: (event) => !(event.target as Element | null)?.closest?.('.help-tooltip'),
  });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  // Clear cached models when provider settings change so next dropdown open fetches fresh data
  useEffect(() => {
    setModels({});
  }, [providers]);

  // Eagerly load the model catalog on mount so the closed-button label can
  // resolve `currentModel` to its friendly display name (e.g. "Gemini 3.5
  // Flash (High) (Agent)") instead of falling back to the raw key
  // ("gemini-3-flash-agent"). Without this, Bug K shows up: the chat header
  // chip displays the bare key for the active model until the user opens the
  // dropdown (which used to be the only trigger for loadModels), so the
  // High / Medium / Low tier on antigravity-gemini-agent stayed hidden in the
  // most prominent place users look for it. Cheap to do: aiGetModels is
  // cached per-provider in the renderer atom shape and main's ModelRegistry.
  useEffect(() => {
    if (Object.keys(models).length === 0) {
      void loadModels();
    }
    // We intentionally only depend on the empty-state guard; the providers
    // effect above wipes models when settings change so this effect re-runs
    // on the next render to pick up the new catalog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  // Outside-click / escape dismissal is handled by floating-ui's `useDismiss`
  // (configured above), so no manual document mousedown listener is needed here.

  // Load models when dropdown opens
  useEffect(() => {
    if (isOpen && Object.keys(models).length === 0) {
      loadModels();
    }
  }, [isOpen]);

  const loadModels = async () => {
    setLoading(true);
    try {
      const response = await window.electronAPI.aiGetModels();
      if (response.success && response.grouped) {
        setModels(response.grouped);
        const meta = response as {
          providerLabels?: Record<string, string>;
          providerIcons?: Record<string, string>;
        };
        if (meta.providerLabels) setProviderLabels(meta.providerLabels);
        if (meta.providerIcons) setProviderIcons(meta.providerIcons);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleModelSelect = (modelId: string) => {
    onModelChange(modelId);
    setIsOpen(false);
  };

  const getSettingsCategoryForModel = (modelId: string): SettingsCategory => {
    const provider = modelId.split(':')[0];
    switch (provider) {
      case 'claude':
      case 'claude-code':
      case 'openai':
      case 'openai-codex':
      case 'opencode':
      case 'copilot-cli':
      case 'lmstudio':
      case 'gemini-cli':
        return provider;
      case 'openai-codex-acp':
        // Settings still live under the OpenAI Codex panel.
        return 'openai-codex';
      default:
        return 'claude-code';
    }
  };

  const handleConfigureModels = () => {
    setIsOpen(false);
    navigateToSettings({
      category: getSettingsCategoryForModel(currentModel),
      scope: 'user',
    });
    setWindowMode('settings');
  };

  const getCurrentModelName = () => {
    if (!currentModel) return 'Select Model';

    // Find the model in our list
    for (const providerModels of Object.values(models)) {
      const model = providerModels.find(m => m.id === currentModel);
      if (model) return model.name;
    }

    // Fallback - strip provider prefix for display
    if (currentModel.startsWith('claude-code')) {
      return getClaudeCodeModelLabel(currentModel);
    }

    // Antigravity-aware fallback. The catalog round-trip (aiGetModels) can be
    // pending the first time the chip renders for a fresh session, and the
    // raw key ("gemini-3-flash-agent") is meaningless to users. Map the three
    // surfaced tiers to their tier-aware display names so the header shows the
    // selected variant immediately (Bug K). Suffix with "(Agent)" for the
    // agent provider so it matches the dropdown labels.
    const [providerId, ...modelParts] = currentModel.split(':');
    const modelKey = modelParts.join(':');
    if (providerId === 'antigravity-gemini' || providerId === 'antigravity-gemini-agent') {
      const tierLabel =
        modelKey === 'gemini-3-flash-agent'
          ? 'Gemini 3.5 Flash (High)'
          : modelKey === 'gemini-3.5-flash-low'
            ? 'Gemini 3.5 Flash (Medium)'
            : modelKey === 'gemini-3.5-flash-extra-low'
              ? 'Gemini 3.5 Flash (Low)'
              : null;
      if (tierLabel) {
        return providerId === 'antigravity-gemini-agent'
          ? `${tierLabel} (Agent)`
          : tierLabel;
      }
    }

    return modelKey || currentModel;
  };

  const getProviderLabel = (provider: string) => {
    // Extension-contributed providers carry their manifest displayName from
    // ai:getModels; prefer it over the prettified-id fallback below.
    if (providerLabels[provider]) return providerLabels[provider];
    switch (provider) {
      case 'claude': return 'Claude Chat';
      case 'claude-code': return 'Claude Agent (Claude Code Based)';
      case 'claude-code-cli': return 'Claude Code CLI (Subscription)';
      case 'openai': return 'OpenAI';
      case 'openai-codex': return 'OpenAI Codex';
      case 'openai-codex-acp': return 'OpenAI Codex (ACP)';
      case 'opencode': return 'OpenCode';
      case 'copilot-cli': return 'GitHub Copilot';
      case 'lmstudio': return 'LMStudio';
      case 'gemini-cli': return 'Google Gemini';
      // Built-ins above keep their picker-specific labels; the registry covers
      // any other built-in/extension provider before falling back to a
      // prettified form of the raw id.
      default: {
        const fromRegistry = ProviderRegistry.get(provider)?.label;
        if (fromRegistry) return fromRegistry;
        // Extension-contributed providers carry their contribution id here
        // (e.g. "antigravity-gemini-agent"). Prettify it for the group header
        // rather than showing the raw id; the per-model names already come
        // from the extension manifest.
        const cleaned = provider.replace(/-agent$/, '').replace(/[-_]+/g, ' ').trim();
        return cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) || provider;
      }
    }
  };

  // Built-in chat-model providers and extension-contributed agents are grouped
  // under "Agents" so they surface the same way Codex / Claude Code do, without
  // the renderer needing the main-process AgentProviderRegistry. Extension
  // providers ship a Material icon name in their manifest; prefer it so the
  // picker header matches the Agent Providers sidebar. Built-ins fall back to
  // getProviderIcon.
  const renderProviderIcon = (provider: string, size: number) => {
    const ext = providerIcons[provider];
    if (ext) return <MaterialSymbol icon={ext} size={size} />;
    return getProviderIcon(provider, { size });
  };

  // Prefer the registry; fall back to the runtime helper when metadata has not
  // been registered yet so behavior is identical either way.
  const providerIsAgent = (provider: string): boolean =>
    ProviderRegistry.has(provider) ? ProviderRegistry.isAgent(provider) : isAgentProvider(provider);

  const getProviderType = (provider: string): ProviderType => {
    return providerIsAgent(provider) ? 'agent' : 'model';
  };

  const isProviderSwitchDisabled = (targetProvider: string): boolean => {
    return shouldBlockStartedSessionProviderSwitch(currentProvider, targetProvider, sessionHasMessages);
  };

  const isSectionDisabled = (sectionType: 'agent' | 'model'): boolean => {
    if (!sessionHasMessages || !currentProvider) return false;
    const currentProviderType = getProviderType(currentProvider);
    return sectionType !== currentProviderType;
  };

  // Group providers by type (agents vs models)
  const groupedProviders = Object.entries(models).reduce((acc, [provider, providerModels]) => {
    const isAgent = providerIsAgent(provider);
    const type = isAgent ? 'agents' : 'models';
    if (!acc[type]) acc[type] = {};
    acc[type][provider] = providerModels;
    return acc;
  }, {} as Record<'agents' | 'models', Record<string, Model[]>>);

  // Read-only chip: show the running provider/model without a dropdown. Used by
  // committed claude-code-cli sessions where the model is fixed at spawn.
  if (readOnly) {
    return (
      <div className="model-selector inline-block">
        <span
          className="model-selector-button model-selector-readonly flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium whitespace-nowrap max-w-[200px] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] border border-[var(--nim-border)] cursor-default"
          aria-label={`Current model: ${getCurrentModelName()}`}
          data-testid="model-picker"
          title={readOnlyTitle}
        >
          <span className="model-selector-label overflow-hidden text-ellipsis">{getCurrentModelName()}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="model-selector inline-block">
      <button
        ref={refs.setReference}
        className="model-selector-button flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium cursor-pointer transition-all duration-200 outline-none whitespace-nowrap max-w-[200px] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)]"
        aria-label={`Current model: ${getCurrentModelName()}`}
        data-testid="model-picker"
        {...getReferenceProps({
          onClick: () => setIsOpen(open => !open),
        })}
      >
        <span className="model-selector-label overflow-hidden text-ellipsis">{getCurrentModelName()}</span>
        <MaterialSymbol icon="expand_more" size={14} className={`model-selector-arrow transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="model-selector-dropdown nim-scrollbar min-w-[240px] max-w-[320px] max-h-[min(400px,calc(100vh-24px))] overflow-y-auto rounded-lg p-1 z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
            style={floatingStyles}
            {...getFloatingProps()}
          >
          {loading ? (
            <div className="model-selector-loading p-3 text-center text-xs text-[var(--nim-text-faint)]">Loading models...</div>
          ) : Object.keys(models).length === 0 ? (
            <div className="model-selector-empty p-3 text-center text-xs text-[var(--nim-text-faint)]">No models available</div>
          ) : (
            <>
              {/* Agents Section */}
              {groupedProviders.agents && Object.keys(groupedProviders.agents).length > 0 && (
                <>
                  <div className="model-selector-section-header px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--nim-text-faint)]">Agents</div>
                  {isSectionDisabled('agent') && (
                    <div className="model-selector-disabled-notice px-2 pt-1 pb-1.5 text-[11px] italic text-[var(--nim-text-faint)]">
                      Start a new session to use agents
                    </div>
                  )}
                  {Object.entries(groupedProviders.agents).map(([provider, providerModels]) => (
                    <div key={provider} className="model-selector-provider-group mb-1">
                      {/* Hover help (NIM-825): providers with a
                          model-picker-provider-<id> HelpContent entry get a
                          tooltip explaining what they are (e.g. Claude Agent
                          vs Claude Code CLI); others render unchanged. */}
                      <HelpTooltip testId={`model-picker-provider-${provider}`} placement="right">
                        <div
                          className="model-selector-provider-header flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-[var(--nim-text-muted)]"
                          data-testid={`model-picker-provider-${provider}`}
                        >
                          {renderProviderIcon(provider, 12)}
                          <span>{getProviderLabel(provider)}</span>
                          {ALPHA_PROVIDERS.has(provider) && <AlphaBadge size="xs" />}
                        </div>
                      </HelpTooltip>
                      {providerModels.map(model => {
                        const isCurrent = model.id === currentModel;
                        const isDisabled = isProviderSwitchDisabled(provider);
                        const disabledTooltip = 'Start a new session to switch providers after the session has started';
                        return (
                          <button
                            key={model.id}
                            className={`model-selector-option flex items-center justify-between gap-2 pl-6 pr-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text)] ${isCurrent ? 'selected bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : ''} ${isDisabled ? 'disabled opacity-50 cursor-not-allowed' : 'hover:bg-[var(--nim-bg-hover)]'}`}
                            onClick={() => !isDisabled && handleModelSelect(model.id)}
                            title={isDisabled ? disabledTooltip : undefined}
                            aria-disabled={isDisabled}
                          >
                            <span className={`model-selector-option-name flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${isDisabled ? 'text-[var(--nim-text-faint)]' : ''}`}>{model.name}</span>
                            {isDisabled ? (
                              <MaterialSymbol icon="block" size={14} className="disabled-icon text-[var(--nim-text-faint)]" />
                            ) : isCurrent ? (
                              <MaterialSymbol icon="check" size={14} />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}

              {/* Chat with open document Section */}
              {groupedProviders.models && Object.keys(groupedProviders.models).length > 0 && (
                <>
                  {groupedProviders.agents && Object.keys(groupedProviders.agents).length > 0 && (
                    <div className="model-selector-divider h-px my-1 bg-[var(--nim-border)]" />
                  )}
                  <div className="model-selector-section-header px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--nim-text-faint)]">Chat with open document</div>
                  {isSectionDisabled('model') && (
                    <div className="model-selector-disabled-notice px-2 pt-1 pb-1.5 text-[11px] italic text-[var(--nim-text-faint)]">
                      Start a new session to use chat models
                    </div>
                  )}
                  {Object.entries(groupedProviders.models).map(([provider, providerModels]) => (
                    <div key={provider} className="model-selector-provider-group mb-1">
                      <div className="model-selector-provider-header flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-[var(--nim-text-muted)]">
                        {renderProviderIcon(provider, 12)}
                        {getProviderLabel(provider)}
                      </div>
                      {providerModels.map(model => {
                        const isCurrent = model.id === currentModel;
                        const isDisabled = isProviderSwitchDisabled(provider);
                        const disabledTooltip = 'Start a new session to switch providers after the session has started';
                        return (
                          <button
                            key={model.id}
                            className={`model-selector-option flex items-center justify-between gap-2 pl-6 pr-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text)] ${isCurrent ? 'selected bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : ''} ${isDisabled ? 'disabled opacity-50 cursor-not-allowed' : 'hover:bg-[var(--nim-bg-hover)]'}`}
                            onClick={() => !isDisabled && handleModelSelect(model.id)}
                            title={isDisabled ? disabledTooltip : undefined}
                            aria-disabled={isDisabled}
                          >
                            <span className={`model-selector-option-name flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${isDisabled ? 'text-[var(--nim-text-faint)]' : ''}`}>{model.name}</span>
                            {isDisabled ? (
                              <MaterialSymbol icon="block" size={14} className="disabled-icon text-[var(--nim-text-faint)]" />
                            ) : isCurrent ? (
                              <MaterialSymbol icon="check" size={14} />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}

              {/* Configure Models */}
              <div className="model-selector-divider h-px my-1 bg-[var(--nim-border)]" />
              <button
                className="model-selector-configure flex items-center gap-2 px-2 py-1.5 w-full bg-transparent border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                onClick={handleConfigureModels}
              >
                <MaterialSymbol icon="settings" size={14} />
                <span>Configure models</span>
              </button>
            </>
          )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
