import '@/providers';

import { applyProviderUIGating } from '@/features/chat/tabs/tabProviderUI';
import type { TabData } from '@/features/chat/tabs/types';
import type GrimoirePlugin from '@/main';

function createTestTab(providerId: TabData['providerId'], orchestratorMode: boolean): TabData {
  return {
    providerId,
    lifecycleState: 'bound_active',
    conversationId: null,
    draftModel: null,
    service: null,
    orchestratorMode,
    state: {
      usage: null,
    },
    ui: {
      mcpServerSelector: {
        clearEnabled: jest.fn(),
        setVisible: jest.fn(),
      },
      permissionToggle: {
        setVisible: jest.fn(),
      },
      orchestratorToggle: {
        setVisible: jest.fn(),
        updateDisplay: jest.fn(),
      },
      fileContextManager: {
        setMcpManager: jest.fn(),
        setAgentService: jest.fn(),
      },
      imageContextManager: {
        setEnabled: jest.fn(),
      },
      contextUsageMeter: {
        update: jest.fn(),
      },
    },
    services: {
      agentMentionServices: new Map(),
    },
  } as unknown as TabData;
}

describe('applyProviderUIGating', () => {
  const plugin = {
    settings: {},
    getApplicationRuntimeOrNull: () => null,
  } as unknown as GrimoirePlugin;

  it('hides the parallel workers toggle and clears orchestratorMode for Antigravity', () => {
    const tab = createTestTab('antigravity', true);

    applyProviderUIGating(tab, plugin);

    expect(tab.orchestratorMode).toBe(false);
    expect(tab.ui.orchestratorToggle?.setVisible).toHaveBeenCalledWith(false);
    expect(tab.ui.orchestratorToggle?.updateDisplay).toHaveBeenCalledTimes(1);
  });

  it('keeps the parallel workers toggle visible and preserves orchestratorMode for other providers', () => {
    const tab = createTestTab('claude', true);

    applyProviderUIGating(tab, plugin);

    expect(tab.orchestratorMode).toBe(true);
    expect(tab.ui.orchestratorToggle?.setVisible).toHaveBeenCalledWith(true);
    expect(tab.ui.orchestratorToggle?.updateDisplay).toHaveBeenCalledTimes(1);
  });
});
