/**
 * Grimoire - File Link Utilities
 *
 * Detects Obsidian wikilinks [[path/to/file]] in rendered content and makes
 * them clickable to open the file in Obsidian.
 */

import type { App, Component, TFile, WorkspaceLeaf } from 'obsidian';

import { createDetachedEl } from './dom';
import { getVaultFileByPath } from './obsidianCompat';

/**
 * Regex pattern to match Obsidian wikilinks in text content.
 *
 * Matches:
 * - Standard wikilinks: [[note]] or [[folder/note]]
 * - Wikilinks with display text: [[note|display text]]
 * - Wikilinks with headings: [[note#heading]]
 * - Wikilinks with block references: [[note^block]]
 *
 * Does NOT match image embeds ![[image.png]] (those are handled separately).
 */
const WIKILINK_PATTERN_SOURCE = '(?<!!)\\[\\[([^\\]|#^]+)(?:#[^\\]|]+)?(?:\\^[^\\]|]+)?(?:\\|[^\\]]+)?\\]\\]';

/** Creates a fresh regex instance to avoid global state issues */
function createWikilinkPattern(): RegExp {
  return new RegExp(WIKILINK_PATTERN_SOURCE, 'g');
}

export function hasProcessableWikilink(text: string): boolean {
  if (!text.includes('[[')) return false;

  const pattern = createWikilinkPattern();
  return pattern.test(text);
}

export function mayContainFileLinks(text: string): boolean {
  return hasProcessableWikilink(text) || (text.includes('`') && text.includes('.'));
}

interface WikilinkMatch {
  index: number;
  fullMatch: string;
  linkPath: string;
  linkTarget: string;
  displayText: string;
}

function buildWikilinkMatch(
  fullMatch: string,
  linkPath: string,
  index: number
): WikilinkMatch {
  const pipeIndex = fullMatch.lastIndexOf('|');
  const displayText = pipeIndex > 0 ? fullMatch.slice(pipeIndex + 1, -2) : linkPath;

  return {
    index,
    fullMatch,
    linkPath,
    linkTarget: extractLinkTarget(fullMatch),
    displayText,
  };
}

export function extractLinkTarget(fullMatch: string): string {
  const inner = fullMatch.slice(2, -2);
  const pipeIndex = inner.indexOf('|');
  return pipeIndex >= 0 ? inner.slice(0, pipeIndex) : inner;
}

/**
 * Finds all wikilinks in text that exist in the vault.
 * Sorted by index descending for end-to-start processing.
 */
function findWikilinks(app: App, text: string): WikilinkMatch[] {
  const pattern = createWikilinkPattern();
  const matches: WikilinkMatch[] = [];

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const linkPath = match[1];

    if (!fileExistsInVault(app, linkPath)) continue;

    matches.push(buildWikilinkMatch(fullMatch, linkPath, match.index));
  }

  return matches.sort((a, b) => b.index - a.index);
}

function fileExistsInVault(app: App, linkPath: string): boolean {
  const file = app.metadataCache.getFirstLinkpathDest(linkPath, '');
  if (file) {
    return true;
  }

  const directFile = getVaultFileByPath(app, linkPath);
  if (directFile) {
    return true;
  }

  if (!linkPath.endsWith('.md')) {
    const withExt = getVaultFileByPath(app, linkPath + '.md');
    if (withExt) {
      return true;
    }
  }

  return false;
}

function extractLinkPathFromTarget(linkTarget: string): string {
  const subpathIndex = linkTarget.search(/[#^]/);
  return subpathIndex >= 0 ? linkTarget.slice(0, subpathIndex) : linkTarget;
}

/**
 * Creates a link element for a wikilink.
 * Click handling is done via event delegation in registerFileLinkHandler.
 */
function createWikilink(
  ownerDocument: Document,
  linkTarget: string,
  displayText: string
): HTMLElement {
  const link = createDetachedEl(ownerDocument, 'a', {
    cls: 'grimoire-file-link internal-link',
    text: displayText,
  });
  link.setAttribute('data-href', linkTarget);
  link.setAttribute('href', linkTarget);
  return link;
}

function repairEmptyInternalLink(app: App, link: HTMLAnchorElement): void {
  if ((link.textContent || '').trim()) return;

  const linkTarget = link.dataset.href || link.getAttribute('data-href') || link.getAttribute('href');
  if (!linkTarget) return;

  const linkPath = extractLinkPathFromTarget(linkTarget);
  if (!linkPath || !fileExistsInVault(app, linkPath)) return;

  link.classList.add('grimoire-file-link');
  if (!link.dataset.href) {
    link.setAttribute('data-href', linkTarget);
  }
  link.textContent = linkTarget;
}

/**
 * Registers a delegated click handler for file links on a container.
 * Should be called once on the messages container.
 * Handles both our custom .grimoire-file-link and Obsidian's .internal-link.
 */
function isLeafInRootSplit(app: App, leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf {
  if (!leaf) return false;
  const rootSplit = app.workspace.rootSplit;
  if (!rootSplit) return true;
  if (typeof leaf.getRoot !== 'function') return true;
  return leaf.getRoot() === rootSplit;
}

export interface MainEditorOpenOptions {
  readonly newTab?: boolean;
}

export function isModClickEvent(event?: MouseEvent | KeyboardEvent | null): boolean {
  if (!event) return false;
  return Boolean(event.metaKey || event.ctrlKey || ('button' in event && event.button === 1));
}

function getLeafFilePath(leaf: WorkspaceLeaf): string | null {
  if (typeof leaf.getViewState === 'function') {
    const viewState = leaf.getViewState();
    const rawState: unknown = viewState?.state;
    if (rawState && typeof rawState === 'object' && 'file' in rawState) {
      const stateFile = (rawState as { file?: unknown }).file;
      if (typeof stateFile === 'string' && stateFile.length > 0) {
        return stateFile;
      }
    }
  }
  const view: unknown = (leaf as { view?: unknown }).view;
  if (view && typeof view === 'object' && 'file' in view) {
    const file = (view as { file?: { path?: unknown } }).file;
    if (file && typeof file.path === 'string' && file.path.length > 0) {
      return file.path;
    }
  }
  return null;
}

function findOpenLeafForFileInRootSplit(app: App, filePath: string): WorkspaceLeaf | null {
  const { workspace } = app;
  const recentMainLeaf = typeof workspace.getMostRecentLeaf === 'function'
    ? workspace.getMostRecentLeaf(workspace.rootSplit)
    : null;
  if (isLeafInRootSplit(app, recentMainLeaf) && getLeafFilePath(recentMainLeaf) === filePath) {
    return recentMainLeaf;
  }

  let matched: WorkspaceLeaf | null = null;
  if (typeof workspace.iterateRootLeaves === 'function') {
    workspace.iterateRootLeaves((leaf) => {
      if (!matched && isLeafInRootSplit(app, leaf) && getLeafFilePath(leaf) === filePath) {
        matched = leaf;
      }
    });
  }
  return matched;
}

function resolveTargetFileForLink(app: App, linkTarget: string, sourcePath: string): TFile | null {
  const linkPath = extractLinkPathFromTarget(linkTarget);
  if (!linkPath) return null;
  const cached = app.metadataCache?.getFirstLinkpathDest?.(linkPath, sourcePath);
  if (cached) return cached;
  if (!app.vault) return null;
  const direct = getVaultFileByPath(app, linkPath);
  if (direct) return direct;
  if (!linkPath.endsWith('.md')) {
    return getVaultFileByPath(app, `${linkPath}.md`);
  }
  return null;
}

/**
 * Resolves a leaf inside the main editor (`workspace.rootSplit`) so opening
 * files or links from a sidebar pane never replaces or splits inside the sidebar.
 */
export function resolveMainEditorLeaf(
  app: App,
  options: MainEditorOpenOptions = {},
): WorkspaceLeaf {
  const { workspace } = app;
  const rootSplit = workspace.rootSplit;
  const recentMainLeaf = typeof workspace.getMostRecentLeaf === 'function'
    ? workspace.getMostRecentLeaf(rootSplit)
    : null;

  if (options.newTab) {
    if (isLeafInRootSplit(app, recentMainLeaf)) {
      workspace.setActiveLeaf?.(recentMainLeaf, { focus: false });
      const leaf = workspace.getLeaf('tab');
      if (isLeafInRootSplit(app, leaf)) {
        return leaf;
      }
      if (rootSplit && typeof workspace.createLeafInParent === 'function') {
        return workspace.createLeafInParent(rootSplit, -1);
      }
      return leaf;
    }

    if (rootSplit && typeof workspace.createLeafInParent === 'function') {
      return workspace.createLeafInParent(rootSplit, -1);
    }

    return workspace.getLeaf('tab');
  }

  if (isLeafInRootSplit(app, recentMainLeaf)) {
    workspace.setActiveLeaf?.(recentMainLeaf, { focus: false });
    return recentMainLeaf;
  }

  if (rootSplit && typeof workspace.createLeafInParent === 'function') {
    return workspace.createLeafInParent(rootSplit, -1);
  }

  return workspace.getLeaf(false);
}

export async function openFileInMainEditor(
  app: App,
  file: TFile,
  options: MainEditorOpenOptions = {},
): Promise<void> {
  if (!options.newTab) {
    const existingLeaf = findOpenLeafForFileInRootSplit(app, file.path);
    if (existingLeaf) {
      app.workspace.setActiveLeaf?.(existingLeaf, { focus: true });
      await app.workspace.revealLeaf?.(existingLeaf);
      return;
    }
  }
  const leaf = resolveMainEditorLeaf(app, options);
  await leaf.openFile(file);
}

export async function openLinkTextInMainEditor(
  app: App,
  linkTarget: string,
  sourcePath = '',
  options: MainEditorOpenOptions = {},
): Promise<void> {
  const { workspace } = app;
  const rootSplit = workspace.rootSplit;

  if (!options.newTab) {
    const targetFile = resolveTargetFileForLink(app, linkTarget, sourcePath);
    if (targetFile) {
      const existingLeaf = findOpenLeafForFileInRootSplit(app, targetFile.path);
      if (existingLeaf) {
        workspace.setActiveLeaf?.(existingLeaf, { focus: true });
        await workspace.revealLeaf?.(existingLeaf);
        if (/[#^]/.test(linkTarget)) {
          await workspace.openLinkText(linkTarget, sourcePath, false);
        }
        return;
      }
    }
  }

  const recentMainLeaf = typeof workspace.getMostRecentLeaf === 'function'
    ? workspace.getMostRecentLeaf(rootSplit)
    : null;
  const newLeafArg: false | 'tab' = options.newTab ? 'tab' : false;

  if (isLeafInRootSplit(app, recentMainLeaf)) {
    workspace.setActiveLeaf?.(recentMainLeaf, { focus: false });
    await workspace.openLinkText(linkTarget, sourcePath, newLeafArg);
    return;
  }

  if (rootSplit && typeof workspace.createLeafInParent === 'function') {
    const newMainLeaf = workspace.createLeafInParent(rootSplit, -1);
    workspace.setActiveLeaf?.(newMainLeaf, { focus: false });
    await workspace.openLinkText(linkTarget, sourcePath, false);
    return;
  }

  await workspace.openLinkText(linkTarget, sourcePath, newLeafArg);
}

function resolveStandardVaultHref(app: App, anchor: HTMLAnchorElement): string | null {
  const rawTarget = anchor.dataset?.href || anchor.getAttribute?.('href');
  if (!rawTarget) return null;
  if (rawTarget.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
    return null;
  }
  const normalized = rawTarget.replace(/^\.\//, '');
  const decoded = (() => {
    try {
      return decodeURIComponent(normalized);
    } catch {
      return normalized;
    }
  })();
  const linkPath = decoded.split('#')[0].split('^')[0];
  if (!linkPath) return null;
  if (app.metadataCache?.getFirstLinkpathDest?.(linkPath, '')) {
    return decoded;
  }
  if (getVaultFileByPath(app, linkPath)) {
    return decoded;
  }
  return null;
}

export function registerFileLinkHandler(
  app: App,
  container: HTMLElement,
  component: Component
): void {
  component.registerDomEvent(container, 'click', (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // Handle both our links and Obsidian's internal links
    const link = target.closest?.<HTMLAnchorElement>('.grimoire-file-link, .internal-link') ?? null;

    if (link) {
      event.preventDefault();
      event.stopPropagation?.();
      const linkTarget = link.dataset?.href || link.getAttribute?.('href');
      if (linkTarget) {
        void openLinkTextInMainEditor(app, linkTarget, '', { newTab: isModClickEvent(event) });
      }
      return;
    }

    const anchor = target.closest?.('a') ?? null;
    if (!anchor) return;
    const vaultHref = resolveStandardVaultHref(app, anchor);
    if (vaultHref) {
      event.preventDefault();
      event.stopPropagation?.();
      void openLinkTextInMainEditor(app, vaultHref, '', { newTab: isModClickEvent(event) });
    }
  });
}

function buildFragmentWithLinks(ownerDocument: Document, text: string, matches: WikilinkMatch[]): DocumentFragment {
  const fragment = ownerDocument.win.createFragment();
  let currentIndex = text.length;

  for (const { index, fullMatch, linkTarget, displayText } of matches) {
    const endIndex = index + fullMatch.length;

    if (endIndex < currentIndex) {
      fragment.insertBefore(
        ownerDocument.createTextNode(text.slice(endIndex, currentIndex)),
        fragment.firstChild
      );
    }

    fragment.insertBefore(createWikilink(ownerDocument, linkTarget, displayText), fragment.firstChild);
    currentIndex = index;
  }

  if (currentIndex > 0) {
    fragment.insertBefore(
      ownerDocument.createTextNode(text.slice(0, currentIndex)),
      fragment.firstChild
    );
  }

  return fragment;
}

function processTextNode(app: App, node: Text): boolean {
  const text = node.textContent;
  if (!text || !text.includes('[[')) return false;

  const matches = findWikilinks(app, text);
  if (matches.length === 0) return false;

  node.parentNode?.replaceChild(buildFragmentWithLinks(node.ownerDocument, text, matches), node);
  return true;
}

/**
 * Call after MarkdownRenderer.renderMarkdown().
 * Catches wikilinks that remain as raw text after rendering, especially inline code spans.
 */
export function processFileLinks(app: App, container: HTMLElement): void {
  if (!app || !container) return;

  // Repair resolved internal links that rendered as empty anchors.
  container.querySelectorAll('a.internal-link').forEach((linkEl) => {
    repairEmptyInternalLink(app, linkEl as HTMLAnchorElement);
  });

  // Wikilinks in inline code aren't rendered by Obsidian's MarkdownRenderer
  container.querySelectorAll('code').forEach((codeEl) => {
    if (codeEl.closest('pre, a')) return;

    const text = codeEl.textContent;
    if (!text) return;
    if (!text.includes('[[')) {
      // A whole inline code span delimits paths with spaces without guessing
      // where a filename begins or ends in prose.
      if (!/\.[\w-]+$/.test(text) || /[\\:#^\n\r]/.test(text) || text.startsWith('/')) return;
      const file = getVaultFileByPath(app, text);
      if (file?.path === text) {
        codeEl.replaceChildren(createWikilink(container.ownerDocument, file.path, text));
      }
      return;
    }

    const matches = findWikilinks(app, text);
    if (matches.length === 0) return;

    codeEl.textContent = '';
    codeEl.appendChild(buildFragmentWithLinks(container.ownerDocument, text, matches));
  });

  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        const tagName = parent.tagName.toUpperCase();
        if (tagName === 'PRE' || tagName === 'CODE' || tagName === 'A') {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest('pre, code, a, .grimoire-file-link, .internal-link')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  // Modifying DOM while walking causes issues, so collect first
  const textNodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    processTextNode(app, textNode);
  }
}
