import { openFileInMainEditor, registerFileLinkHandler } from '@/utils/fileLink';

describe('registerFileLinkHandler', () => {
  it('opens data-href target in the current tab by default and a new tab on Cmd/Ctrl+Click', () => {
    const app = {
      workspace: {
        openLinkText: jest.fn(),
      },
    };

    const link: any = {
      dataset: { href: 'note#section' },
      getAttribute: jest.fn().mockReturnValue('note'),
      closest: jest.fn(),
    };
    link.closest.mockReturnValue(link);

    const handlers: Array<(event: MouseEvent) => void> = [];
    const component = {
      registerDomEvent: (_el: HTMLElement, _event: string, cb: (event: MouseEvent) => void) => {
        handlers.push(cb);
      },
    };

    registerFileLinkHandler(app as any, {} as HTMLElement, component as any);

    const normalEvent = {
      target: link,
      preventDefault: jest.fn(),
    } as any;
    handlers[0](normalEvent);

    expect(normalEvent.preventDefault).toHaveBeenCalled();
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('note#section', '', false);

    const modEvent = {
      target: link,
      metaKey: true,
      preventDefault: jest.fn(),
    } as any;
    handlers[0](modEvent);

    expect(app.workspace.openLinkText).toHaveBeenCalledWith('note#section', '', 'tab');
  });

  it('falls back to href when data-href is missing', () => {
    const app = {
      workspace: {
        openLinkText: jest.fn(),
      },
    };

    const link: any = {
      dataset: {},
      getAttribute: jest.fn().mockReturnValue('note^block'),
      closest: jest.fn(),
    };
    link.closest.mockReturnValue(link);

    const event = {
      target: link,
      ctrlKey: true,
      preventDefault: jest.fn(),
    } as any;

    const component = {
      registerDomEvent: (_el: HTMLElement, _event: string, cb: (event: MouseEvent) => void) => {
        cb(event);
      },
    };

    registerFileLinkHandler(app as any, {} as HTMLElement, component as any);

    expect(app.workspace.openLinkText).toHaveBeenCalledWith('note^block', '', 'tab');
  });

  it('reuses the most recent main-editor leaf in rootSplit on unmodified click', () => {
    const rootSplit = { id: 'root-split' };
    const mainLeaf = { getRoot: jest.fn(() => rootSplit) };
    const app = {
      workspace: {
        rootSplit,
        getMostRecentLeaf: jest.fn(() => mainLeaf),
        setActiveLeaf: jest.fn(),
        openLinkText: jest.fn(),
      },
    };

    const link: any = {
      dataset: { href: 'Projects/Plan.md' },
      getAttribute: jest.fn(),
      closest: jest.fn(),
    };
    link.closest.mockReturnValue(link);

    const event = {
      target: link,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as any;

    const component = {
      registerDomEvent: (_el: HTMLElement, _event: string, cb: (event: MouseEvent) => void) => {
        cb(event);
      },
    };

    registerFileLinkHandler(app as any, {} as HTMLElement, component as any);

    expect(event.stopPropagation).toHaveBeenCalled();
    expect(app.workspace.getMostRecentLeaf).toHaveBeenCalledWith(rootSplit);
    expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(mainLeaf, { focus: false });
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('Projects/Plan.md', '', false);
  });

  it('switches to an existing open tab in rootSplit instead of opening a duplicate', async () => {
    const rootSplit = { id: 'root-split' };
    const activeMainLeaf = {
      getRoot: jest.fn(() => rootSplit),
      getViewState: jest.fn(() => ({ type: 'markdown', state: { file: 'Other.md' } })),
    };
    const alreadyOpenLeaf = {
      getRoot: jest.fn(() => rootSplit),
      getViewState: jest.fn(() => ({ type: 'markdown', state: { file: 'Projects/Plan.md' } })),
    };
    const app = {
      metadataCache: {
        getFirstLinkpathDest: jest.fn(() => ({ path: 'Projects/Plan.md' })),
      },
      workspace: {
        rootSplit,
        getMostRecentLeaf: jest.fn(() => activeMainLeaf),
        iterateRootLeaves: jest.fn((cb: (leaf: any) => void) => {
          cb(activeMainLeaf);
          cb(alreadyOpenLeaf);
        }),
        setActiveLeaf: jest.fn(),
        revealLeaf: jest.fn().mockResolvedValue(undefined),
        openLinkText: jest.fn(),
      },
    };

    const link: any = {
      dataset: { href: 'Projects/Plan.md#Goals' },
      getAttribute: jest.fn(),
      closest: jest.fn(),
    };
    link.closest.mockReturnValue(link);

    const event = {
      target: link,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as any;

    const component = {
      registerDomEvent: (_el: HTMLElement, _event: string, cb: (event: MouseEvent) => void) => {
        cb(event);
      },
    };

    registerFileLinkHandler(app as any, {} as HTMLElement, component as any);
    await Promise.resolve();

    expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(alreadyOpenLeaf, { focus: true });
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(alreadyOpenLeaf);
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('Projects/Plan.md#Goals', '', false);
  });

  it('creates a leaf in rootSplit when rootSplit has no recent leaf', () => {
    const rootSplit = { id: 'root-split' };
    const createdLeaf = { getRoot: jest.fn(() => rootSplit) };
    const app = {
      workspace: {
        rootSplit,
        getMostRecentLeaf: jest.fn(() => null),
        createLeafInParent: jest.fn(() => createdLeaf),
        setActiveLeaf: jest.fn(),
        openLinkText: jest.fn(),
      },
    };

    const link: any = {
      dataset: { href: 'EmptyRootNote.md' },
      getAttribute: jest.fn(),
      closest: jest.fn(),
    };
    link.closest.mockReturnValue(link);

    const event = {
      target: link,
      preventDefault: jest.fn(),
    } as any;

    const component = {
      registerDomEvent: (_el: HTMLElement, _event: string, cb: (event: MouseEvent) => void) => {
        cb(event);
      },
    };

    registerFileLinkHandler(app as any, {} as HTMLElement, component as any);

    expect(app.workspace.createLeafInParent).toHaveBeenCalledWith(rootSplit, -1);
    expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(createdLeaf, { focus: false });
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('EmptyRootNote.md', '', false);
  });

  it('opens standard vault-relative markdown anchors while ignoring external URLs', () => {
    const app = {
      metadataCache: {
        getFirstLinkpathDest: jest.fn((p: string) => (p === 'docs/guide.md' ? { path: p } : null)),
      },
      vault: {
        getAbstractFileByPath: jest.fn(() => null),
      },
      workspace: {
        openLinkText: jest.fn(),
      },
    };

    const vaultAnchor: any = {
      dataset: {},
      getAttribute: jest.fn(() => 'docs/guide.md#intro'),
      closest: jest.fn((selector: string) => (selector === 'a' ? vaultAnchor : null)),
    };
    const externalAnchor: any = {
      dataset: {},
      getAttribute: jest.fn(() => 'https://example.com'),
      closest: jest.fn((selector: string) => (selector === 'a' ? externalAnchor : null)),
    };

    let handler: ((event: MouseEvent) => void) | undefined;
    const component = {
      registerDomEvent: (_el: HTMLElement, _event: string, cb: (event: MouseEvent) => void) => {
        handler = cb;
      },
    };

    registerFileLinkHandler(app as any, {} as HTMLElement, component as any);

    const vaultEvent = { target: vaultAnchor, preventDefault: jest.fn(), stopPropagation: jest.fn() } as any;
    handler!(vaultEvent);
    expect(vaultEvent.preventDefault).toHaveBeenCalled();
    expect(app.workspace.openLinkText).toHaveBeenCalledWith('docs/guide.md#intro', '', false);

    const extEvent = { target: externalAnchor, preventDefault: jest.fn() } as any;
    handler!(extEvent);
    expect(extEvent.preventDefault).not.toHaveBeenCalled();
    expect(app.workspace.openLinkText).toHaveBeenCalledTimes(1);
  });
});

describe('openFileInMainEditor', () => {
  it('reuses the most recent rootSplit leaf on normal open and opens a new tab when newTab is requested', async () => {
    const rootSplit = { id: 'root-split' };
    const rightSplit = { id: 'right-split' };
    const recentMainLeaf = {
      getRoot: jest.fn(() => rootSplit),
      getViewState: jest.fn(() => ({ type: 'markdown', state: { file: 'Current.md' } })),
      openFile: jest.fn().mockResolvedValue(undefined),
    };
    const rogueSidebarLeaf = { getRoot: jest.fn(() => rightSplit), openFile: jest.fn() };
    const fallbackRootLeaf = { getRoot: jest.fn(() => rootSplit), openFile: jest.fn().mockResolvedValue(undefined) };

    const app = {
      workspace: {
        rootSplit,
        getMostRecentLeaf: jest.fn(() => recentMainLeaf),
        setActiveLeaf: jest.fn(),
        getLeaf: jest.fn(() => rogueSidebarLeaf),
        createLeafInParent: jest.fn(() => fallbackRootLeaf),
      },
    };
    const file = { path: 'Notes/Test.md' } as any;

    await openFileInMainEditor(app as any, file);
    expect(recentMainLeaf.openFile).toHaveBeenCalledWith(file);

    await openFileInMainEditor(app as any, file, { newTab: true });
    expect(rogueSidebarLeaf.openFile).not.toHaveBeenCalled();
    expect(app.workspace.createLeafInParent).toHaveBeenCalledWith(rootSplit, -1);
    expect(fallbackRootLeaf.openFile).toHaveBeenCalledWith(file);
  });

  it('switches to an already-open tab in rootSplit instead of opening a duplicate', async () => {
    const rootSplit = { id: 'root-split' };
    const existingLeaf = {
      getRoot: jest.fn(() => rootSplit),
      getViewState: jest.fn(() => ({ type: 'markdown', state: { file: 'Notes/Test.md' } })),
      openFile: jest.fn(),
    };
    const activeMainLeaf = {
      getRoot: jest.fn(() => rootSplit),
      getViewState: jest.fn(() => ({ type: 'markdown', state: { file: 'Other.md' } })),
      openFile: jest.fn(),
    };
    const app = {
      workspace: {
        rootSplit,
        getMostRecentLeaf: jest.fn(() => activeMainLeaf),
        iterateRootLeaves: jest.fn((cb: (leaf: any) => void) => {
          cb(activeMainLeaf);
          cb(existingLeaf);
        }),
        setActiveLeaf: jest.fn(),
        revealLeaf: jest.fn().mockResolvedValue(undefined),
      },
    };
    const file = { path: 'Notes/Test.md' } as any;

    await openFileInMainEditor(app as any, file);

    expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(existingLeaf, { focus: true });
    expect(app.workspace.revealLeaf).toHaveBeenCalledWith(existingLeaf);
    expect(existingLeaf.openFile).not.toHaveBeenCalled();
    expect(activeMainLeaf.openFile).not.toHaveBeenCalled();
  });
});
