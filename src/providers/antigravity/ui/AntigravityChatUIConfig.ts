import type {
  ProviderPermissionModeToggleConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import type {
  ProviderChatUIConfig,
} from '../../../providers/shared/providerHostContracts';
import { ANTIGRAVITY_PROVIDER_ICON } from '../../../shared/icons';
import {
  ANTIGRAVITY_DEFAULT_REASONING_LEVEL,
  ANTIGRAVITY_SYNTHETIC_MODEL_ID,
  decodeAntigravityModelId,
  encodeAntigravityModelId,
  isAntigravityModelSelectionId,
} from '../models';
import {
  getAntigravityProviderSettings,
  normalizeAntigravityWorkMode,
  updateAntigravityProviderSettings,
} from '../settings';

const ANTIGRAVITY_MODELS: ProviderUIOption[] = [
  {
    description: 'Antigravity CLI default model',
    label: 'Antigravity',
    value: ANTIGRAVITY_SYNTHETIC_MODEL_ID,
  },
];
// One entry, which is the picker not offering a choice: the tiers below it
// reached no argument and no prompt. See `capabilities.ts` for the whole of it.
const ANTIGRAVITY_REASONING_OPTIONS: ProviderReasoningOption[] = [
  { value: ANTIGRAVITY_DEFAULT_REASONING_LEVEL, label: 'Default' },
];
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const ANTIGRAVITY_PERMISSION_MODE_TOGGLE: ProviderPermissionModeToggleConfig = {
  inactiveValue: 'default',
  inactiveLabel: 'Default',
  inactiveDescription: 'Ask before edits and commands, per your permission settings.',
  activeValue: 'full_access',
  activeLabel: 'Bypass permissions',
  activeDescription: 'Launch agy acp with --dangerously-skip-permissions (skips all permission prompts).',
  planValue: 'plan',
  planLabel: 'Plan',
  planDescription: 'Plan carefully before executing a task.',
  options: [
    {
      value: 'default',
      label: 'Default',
      detail: 'Ask before edits and commands, per your permission settings.',
      icon: 'shield',
    },
    {
      value: 'accept-edits',
      label: 'Accept edits',
      detail: 'Approve file edits in the workspace without asking.',
      icon: 'pencil',
    },
    {
      value: 'auto',
      label: 'Auto',
      detail: 'Approve edits and safe commands; ask before irreversible actions.',
      icon: 'shield-check',
    },
    {
      value: 'plan',
      label: 'Plan',
      detail: 'Plan carefully before executing a task.',
      icon: 'route',
      isPlan: true,
    },
    {
      value: 'full_access',
      label: 'Bypass permissions',
      detail: 'Launch agy acp with --dangerously-skip-permissions (skips all permission prompts).',
      icon: 'shield-off',
      isBypass: true,
    },
  ],
};

function getAntigravityModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
  const antigravitySettings = getAntigravityProviderSettings(settings);
  const discoveredModels = new Map(antigravitySettings.discoveredModels.map((model) => [
    model.rawId,
    model,
  ]));
  const visibleModels = antigravitySettings.discoveredModels.length > 0
    ? antigravitySettings.discoveredModels.map((model) => model.rawId)
    : antigravitySettings.visibleModels;

  const optionRawIds = mergeAntigravityModelIds(visibleModels, parseAntigravityCustomModels(antigravitySettings.customModels));
  const customModelIds = new Set(parseAntigravityCustomModels(antigravitySettings.customModels));
  const options: ProviderUIOption[] = [];
  for (const rawId of optionRawIds) {
    const discovered = discoveredModels.get(rawId);
    options.push({
      description: discovered
        ? discovered.description ?? 'Antigravity CLI model'
        : customModelIds.has(rawId) ? 'Custom Antigravity CLI model' : 'Antigravity CLI model',
      label: antigravitySettings.modelAliases[rawId] ?? discovered?.label ?? rawId,
      value: encodeAntigravityModelId(rawId),
    });
  }

  return options.length > 0 ? options : [...ANTIGRAVITY_MODELS];
}

function parseAntigravityCustomModels(value: string): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mergeAntigravityModelIds(primary: string[], extra: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const rawId of [...primary, ...extra]) {
    if (!rawId || seen.has(rawId)) {
      continue;
    }
    seen.add(rawId);
    merged.push(rawId);
  }
  return merged;
}

export const antigravityChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    return getAntigravityModelOptions(settings);
  },

  ownsModel(model: string): boolean {
    return isAntigravityModelSelectionId(model);
  },

  isAdaptiveReasoningModel(_model: string, _settings: Record<string, unknown>): boolean {
    return true;
  },

  getReasoningOptions(_model: string, _settings: Record<string, unknown>): ProviderReasoningOption[] {
    return [...ANTIGRAVITY_REASONING_OPTIONS];
  },

  getDefaultReasoningValue(_model: string, _settings: Record<string, unknown>): string {
    return ANTIGRAVITY_DEFAULT_REASONING_LEVEL;
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    return customLimits?.[model] ?? DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return isAntigravityModelSelectionId(model);
  },

  applyModelDefaults(model: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }

    const settingsBag = settings as Record<string, unknown>;
    const rawModelId = decodeAntigravityModelId(model);
    settingsBag.model = rawModelId ? encodeAntigravityModelId(rawModelId) : ANTIGRAVITY_SYNTHETIC_MODEL_ID;
    settingsBag.effortLevel = ANTIGRAVITY_DEFAULT_REASONING_LEVEL;
  },

  applyReasoningSelection(_model: string, value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    (settings as Record<string, unknown>).effortLevel = value || ANTIGRAVITY_DEFAULT_REASONING_LEVEL;
  },

  normalizeModelVariant(model: string, settings: Record<string, unknown>): string {
    if (getAntigravityModelOptions(settings).some((option) => option.value === model)) {
      return model;
    }
    return ANTIGRAVITY_SYNTHETIC_MODEL_ID;
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  getPermissionModeToggle(): ProviderPermissionModeToggleConfig {
    return ANTIGRAVITY_PERMISSION_MODE_TOGGLE;
  },

  resolvePermissionMode(settings: Record<string, unknown>): string | null {
    const selectedMode = getAntigravityProviderSettings(settings).selectedMode;
    return normalizeAntigravityWorkMode(selectedMode) ?? null;
  },

  applyPermissionMode(value: string, settings: unknown): void {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return;
    }
    const normalized = normalizeAntigravityWorkMode(value) ?? 'default';
    const settingsBag = settings as Record<string, unknown>;
    settingsBag.permissionMode = normalized;
    updateAntigravityProviderSettings(settingsBag, { selectedMode: normalized });
  },

  getProviderIcon() {
    return ANTIGRAVITY_PROVIDER_ICON;
  },
};
