import {
  GRIMOIRE_SETTINGS_PATH,
  GrimoireSettingsStorage,
} from '@/app/settings/GrimoireSettingsStorage';
import { builtInProviderCatalog } from '@/providers/BuiltInProviderCatalog';

describe('GrimoireSettingsStorage legacy appearance theme cleanup', () => {
  it('does not persist the Claude Code project settings snapshot', async () => {
    const writes: Array<{ content: string; path: string }> = [];
    const adapter = {
      exists: jest.fn().mockResolvedValue(false),
      read: jest.fn(),
      rename: jest.fn(),
      write: jest.fn(async (path: string, content: string) => {
        writes.push({ path, content });
      }),
    };
    const storage = new GrimoireSettingsStorage(adapter as never);

    await storage.save({
      providerConfigs: {
        claude: {
          respectProjectSettings: true,
          projectSettingsSnapshot: {
            model: 'settings-json-model',
            env: { ANTHROPIC_MODEL: 'settings-json-model' },
          },
        },
      },
    } as never);

    expect(writes[0]?.path).toBe(GRIMOIRE_SETTINGS_PATH);
    const persisted = JSON.parse(writes[0]?.content ?? '{}') as Record<string, unknown>;
    expect((persisted.providerConfigs as any).claude.respectProjectSettings).toBe(true);
    expect((persisted.providerConfigs as any).claude.projectSettingsSnapshot).toBeUndefined();
  });

  it('drops legacy appearance theme values from loaded settings and persists the cleanup', async () => {
    const writes: Array<{ content: string; path: string }> = [];
    const adapter = {
      exists: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue(JSON.stringify({
        appearanceTheme: 'graphite-blue',
      })),
      rename: jest.fn(),
      write: jest.fn(async (path: string, content: string) => {
        writes.push({ path, content });
      }),
    };
    const storage = new GrimoireSettingsStorage(adapter as never);

    const settings = await storage.load();

    expect(settings).not.toHaveProperty('appearanceTheme');
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(writes[0]?.path).toBe(GRIMOIRE_SETTINGS_PATH);
    expect(JSON.parse(writes[0]?.content ?? '{}')).not.toHaveProperty('appearanceTheme');
  });

  it('normalizes invalid debug logging values back to disabled and persists the cleanup', async () => {
    const writes: Array<{ content: string; path: string }> = [];
    const adapter = {
      exists: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue(JSON.stringify({
        debugLoggingEnabled: 'true',
      })),
      rename: jest.fn(),
      write: jest.fn(async (path: string, content: string) => {
        writes.push({ path, content });
      }),
    };
    const storage = new GrimoireSettingsStorage(adapter as never);

    const settings = await storage.load();

    expect(settings.debugLoggingEnabled).toBe(false);
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(writes[0]?.path).toBe(GRIMOIRE_SETTINGS_PATH);
    expect(JSON.parse(writes[0]?.content ?? '{}')).toMatchObject({
      debugLoggingEnabled: false,
    });
  });

  it('normalizes invalid usage indicator values back to enabled and persists the cleanup', async () => {
    const writes: Array<{ content: string; path: string }> = [];
    const adapter = {
      exists: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue(JSON.stringify({
        usageIndicatorsEnabled: 'false',
      })),
      rename: jest.fn(),
      write: jest.fn(async (path: string, content: string) => {
        writes.push({ path, content });
      }),
    };
    const storage = new GrimoireSettingsStorage(adapter as never);

    const settings = await storage.load();

    expect(settings.usageIndicatorsEnabled).toBe(true);
    expect(adapter.write).toHaveBeenCalledTimes(1);
    expect(writes[0]?.path).toBe(GRIMOIRE_SETTINGS_PATH);
    expect(JSON.parse(writes[0]?.content ?? '{}')).toMatchObject({
      usageIndicatorsEnabled: true,
    });
  });

  it('preserves catalog-declared multi-option permission modes and migrates legacy normal/yolo while keeping other providers strict', async () => {
    const realGet = builtInProviderCatalog.get.bind(builtInProviderCatalog);
    const getSpy = jest.spyOn(builtInProviderCatalog, 'get').mockImplementation((providerId: string) => {
      const base = realGet(providerId);
      if (providerId !== 'codex' || !base) {
        return base;
      }
      return {
        ...base,
        declarations: {
          ...base.declarations,
          chatUI: {
            ...base.declarations.chatUI,
            permissionMode: {
              ...base.declarations.chatUI.permissionMode,
              toggle: () => ({
                inactiveValue: 'default',
                inactiveLabel: 'Default',
                activeValue: 'full_access',
                activeLabel: 'Bypass permissions',
                planValue: 'plan',
                planLabel: 'Plan',
                options: [
                  { value: 'default', label: 'Default', detail: 'Ask' },
                  { value: 'accept-edits', label: 'Accept edits', detail: 'Auto-approve edits' },
                  { value: 'auto', label: 'Auto', detail: 'Smart auto' },
                  { value: 'plan', label: 'Plan', detail: 'Plan first', isPlan: true },
                  { value: 'full_access', label: 'Bypass', detail: 'Skip prompts', isBypass: true },
                ],
              }),
            },
          },
        },
      };
    });

    try {
      const adapter = {
        exists: jest.fn().mockResolvedValue(true),
        read: jest.fn().mockResolvedValue(JSON.stringify({
          settingsProvider: 'codex',
          permissionMode: 'accept-edits',
          providerConfigs: { codex: { enabled: true } },
          savedProviderPermissionMode: {
            codex: 'auto',
            claude: 'accept-edits',
          },
        })),
        rename: jest.fn(),
        write: jest.fn(),
      };
      const storage = new GrimoireSettingsStorage(adapter as never);

      const settings = await storage.load();

      expect(settings.permissionMode).toBe('accept-edits');
      expect(settings.savedProviderPermissionMode.codex).toBe('auto');
      expect(settings.savedProviderPermissionMode.claude).toBeUndefined();

      adapter.read.mockResolvedValueOnce(JSON.stringify({
        settingsProvider: 'codex',
        permissionMode: 'normal',
        providerConfigs: { codex: { enabled: true } },
        savedProviderPermissionMode: { codex: 'yolo' },
      }));
      const migrated = await storage.load();
      expect(migrated.permissionMode).toBe('default');
      expect(migrated.savedProviderPermissionMode.codex).toBe('full_access');
    } finally {
      getSpy.mockRestore();
    }
  });
});
