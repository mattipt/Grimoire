import { AntigravityCommandCatalog } from '@/providers/antigravity/commands/AntigravityCommandCatalog';

function createAdapter(initialFiles: Record<string, string>) {
  const files = new Map(Object.entries(initialFiles));
  return {
    delete: jest.fn(async (path: string) => { files.delete(path); }),
    deleteFolderRecursive: jest.fn(async () => undefined),
    ensureFolder: jest.fn(async () => undefined),
    exists: jest.fn(async (path: string) => (
      files.has(path) || Array.from(files.keys()).some(file => file.startsWith(`${path}/`))
    )),
    listFiles: jest.fn(async (root: string) => Array.from(files.keys()).filter(path => (
      path.startsWith(`${root}/`)
      && !path.slice(root.length + 1).includes('/')
    ))),
    listFolders: jest.fn(async (root: string) => Array.from(new Set(
      Array.from(files.keys())
        .filter(path => path.startsWith(`${root}/`))
        .map(path => path.slice(root.length + 1).split('/'))
        .filter(parts => parts.length > 1)
        .map(([folder]) => `${root}/${folder}`),
    ))),
    read: jest.fn(async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`Missing ${path}`);
      return value;
    }),
    rename: jest.fn(async () => undefined),
    write: jest.fn(async (path: string, content: string) => { files.set(path, content); }),
  };
}

describe('AntigravityCommandCatalog', () => {
  it('discovers flat .agents/workflows markdown files ahead of .claude/skills and .agents/skills', async () => {
    const adapter = createAdapter({
      '.agents/workflows/plan.md': '# Plan Workflow\n\nBuild a detailed plan.',
      '.claude/skills/plan/SKILL.md': 'Claude duplicate plan skill.',
      '.agents/skills/research/SKILL.md': 'Research vault notes.',
    });
    const catalog = new AntigravityCommandCatalog(adapter);

    const entries = await catalog.listVaultEntries();

    expect(entries.map(entry => entry.name)).toEqual(['plan', 'research']);
    expect(entries[0]).toMatchObject({
      name: 'plan',
      content: '# Plan Workflow\n\nBuild a detailed plan.',
      isEditable: false,
    });
  });
});
