/**
 * @jest-environment jsdom
 */
jest.mock('obsidian', () => ({
  setIcon: jest.fn((el: HTMLElement, iconName: string) => {
    el.setAttribute('data-icon', iconName);
  }),
}));

import { StepFoldController } from '@/features/chat/rendering/StepFoldController';
import { createThinkingBlock, finalizeThinkingBlock } from '@/features/chat/rendering/ThinkingBlockRenderer';

function createAssistantMessageContent(parent: HTMLElement): HTMLElement {
  const msg = parent.ownerDocument.createElement('div');
  msg.className = 'grimoire-message grimoire-message-assistant';
  const content = parent.ownerDocument.createElement('div');
  content.className = 'grimoire-message-content';
  msg.appendChild(content);
  parent.appendChild(msg);
  return content;
}

function createToolStep(doc: Document, running = false): HTMLElement {
  const el = doc.createElement('div');
  el.className = running ? 'grimoire-tool-call grimoire-tool-step is-running' : 'grimoire-tool-call grimoire-tool-step';
  if (running) {
    const spinner = doc.createElement('span');
    spinner.className = 'grimoire-tool-spinner';
    el.appendChild(spinner);
  }
  return el;
}

function createThinkingStep(doc: Document, running = false): HTMLElement {
  const el = doc.createElement('div');
  el.className = running ? 'grimoire-thinking-block is-running' : 'grimoire-thinking-block';
  const label = doc.createElement('span');
  label.className = 'grimoire-thinking-label';
  label.textContent = running ? 'Thinking 1s...' : 'Thought for 2s';
  el.appendChild(label);
  return el;
}

describe('StepFoldController', () => {
  it('leaves a single step unfolded', () => {
    const messagesEl = document.createElement('div');
    const contentEl = createAssistantMessageContent(messagesEl);
    contentEl.appendChild(createToolStep(document));

    const controller = new StepFoldController(messagesEl);

    expect(contentEl.querySelector('.grimoire-step-toggle-header')).toBeNull();
    expect(contentEl.querySelectorAll('.grimoire-tool-step')).toHaveLength(1);
    controller.disconnect();
  });

  it('groups 2+ steps into a compact scrollable window and toggles between recent and all steps', () => {
    const messagesEl = document.createElement('div');
    const contentEl = createAssistantMessageContent(messagesEl);
    for (let i = 0; i < 6; i += 1) {
      contentEl.appendChild(i === 0 ? createThinkingStep(document) : createToolStep(document));
    }
    const prose = document.createElement('div');
    prose.className = 'grimoire-text-block';
    contentEl.appendChild(prose);

    const controller = new StepFoldController(messagesEl);
    const header = contentEl.querySelector<HTMLButtonElement>('.grimoire-step-toggle-header');
    const container = contentEl.querySelector<HTMLElement>('.grimoire-step-group-container');

    expect(header).not.toBeNull();
    expect(container).not.toBeNull();
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.textContent).toBe('6 steps · Show all');
    expect(container?.classList.contains('is-compact')).toBe(true);
    expect(container?.children).toHaveLength(6);
    expect(contentEl.lastElementChild).toBe(prose);

    header?.click();
    expect(header?.getAttribute('aria-expanded')).toBe('true');
    expect(header?.classList.contains('is-expanded')).toBe(true);
    expect(header?.textContent).toBe('6 steps · Show recent');
    expect(container?.classList.contains('is-compact')).toBe(false);

    header?.click();
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.textContent).toBe('6 steps · Show all');
    expect(container?.classList.contains('is-compact')).toBe(true);

    controller.disconnect();
  });

  it('never expands or collapses the step window when thinking or tools start and stop running', async () => {
    const messagesEl = document.createElement('div');
    const scrollEl = document.createElement('div');
    scrollEl.appendChild(messagesEl);
    const contentEl = createAssistantMessageContent(messagesEl);

    const controller = new StepFoldController(messagesEl, scrollEl);

    const thinking = createThinkingStep(document, true);
    const runningTool = createToolStep(document, true);
    contentEl.appendChild(thinking);
    contentEl.appendChild(runningTool);

    await Promise.resolve();

    let header = contentEl.querySelector<HTMLButtonElement>('.grimoire-step-toggle-header');
    let container = contentEl.querySelector<HTMLElement>('.grimoire-step-group-container');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.classList.contains('is-running')).toBe(true);
    expect(header?.textContent).toBe('Working... (2 steps)');
    expect(container?.classList.contains('is-compact')).toBe(true);

    // Additional steps added during streaming join the group while keeping compact window
    for (let i = 0; i < 3; i += 1) {
      contentEl.appendChild(createToolStep(document, true));
    }
    await Promise.resolve();

    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.textContent).toBe('Working... (5 steps · showing recent)');
    expect(container?.children).toHaveLength(5);

    // Completing thinking & tools updates the header status without popping the window open/shut
    thinking.classList.remove('is-running');
    for (const tool of Array.from(container!.querySelectorAll('.grimoire-tool-step'))) {
      tool.classList.remove('is-running');
      tool.querySelector('.grimoire-tool-spinner')?.remove();
    }
    await Promise.resolve();

    header = contentEl.querySelector<HTMLButtonElement>('.grimoire-step-toggle-header');
    container = contentEl.querySelector<HTMLElement>('.grimoire-step-group-container');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.classList.contains('is-running')).toBe(false);
    expect(header?.textContent).toBe('5 steps · Show all');
    expect(container?.classList.contains('is-compact')).toBe(true);

    // Starting a new thinking block later does not expand the compact window either
    const secondThinking = createThinkingStep(document, true);
    contentEl.appendChild(secondThinking);
    await Promise.resolve();

    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.classList.contains('is-compact')).toBe(true);
    expect(header?.textContent).toBe('Working... (6 steps · showing recent)');

    controller.disconnect();
  });

  it('supports disabling and re-enabling step folding cleanly', async () => {
    const messagesEl = document.createElement('div');
    const contentEl = createAssistantMessageContent(messagesEl);
    contentEl.appendChild(createThinkingStep(document));
    contentEl.appendChild(createToolStep(document));

    const controller = new StepFoldController(messagesEl, null, true);
    expect(contentEl.querySelector('.grimoire-step-toggle-header')).not.toBeNull();
    expect(contentEl.querySelector('.grimoire-step-group-container')).not.toBeNull();

    controller.setEnabled(false);
    expect(contentEl.querySelector('.grimoire-step-toggle-header')).toBeNull();
    expect(contentEl.querySelector('.grimoire-step-group-container')).toBeNull();
    expect(contentEl.children).toHaveLength(2);

    // New steps appended while disabled remain unfolded
    contentEl.appendChild(createToolStep(document));
    await Promise.resolve();
    expect(contentEl.querySelector('.grimoire-step-group-container')).toBeNull();

    // Re-enabling regroups the contiguous run
    controller.setEnabled(true);
    expect(contentEl.querySelector('.grimoire-step-toggle-header')?.textContent).toBe('3 steps');
    expect(contentEl.querySelector('.grimoire-step-group-container')?.children).toHaveLength(3);

    controller.disconnect();
  });

  it('marks ThinkingBlockRenderer wrappers with is-running only while active', () => {
    const parentEl = document.createElement('div') as HTMLElement & {
      createDiv: (opts?: { cls?: string }) => HTMLElement;
    };
    const attachHelpers = (el: HTMLElement): any => {
      Object.assign(el, {
        createDiv(opts?: { cls?: string }) {
          const child = document.createElement('div');
          if (opts?.cls) child.className = opts.cls;
          el.appendChild(child);
          return attachHelpers(child);
        },
        createSpan(opts?: { cls?: string }) {
          const child = document.createElement('span');
          if (opts?.cls) child.className = opts.cls;
          el.appendChild(child);
          return attachHelpers(child);
        },
        setText(text: string) {
          el.textContent = text;
        },
        addClass(cls: string) {
          el.classList.add(cls);
          return el;
        },
        removeClass(cls: string) {
          el.classList.remove(cls);
          return el;
        },
      });
      return el;
    };
    attachHelpers(parentEl);

    const state = createThinkingBlock(parentEl, async () => undefined);
    expect(state.wrapperEl.classList.contains('is-running')).toBe(true);

    finalizeThinkingBlock(state);
    expect(state.wrapperEl.classList.contains('is-running')).toBe(false);
  });

  it('groups .grimoire-write-edit-block elements alongside tool and thinking steps', () => {
    const messagesEl = document.createElement('div');
    const contentEl = createAssistantMessageContent(messagesEl);
    contentEl.appendChild(createThinkingStep(document));
    const writeEdit = document.createElement('div');
    writeEdit.className = 'grimoire-write-edit-block';
    contentEl.appendChild(writeEdit);
    contentEl.appendChild(createToolStep(document));

    const controller = new StepFoldController(messagesEl);
    const header = contentEl.querySelector<HTMLButtonElement>('.grimoire-step-toggle-header');
    const container = contentEl.querySelector<HTMLElement>('.grimoire-step-group-container');

    expect(header?.textContent).toBe('3 steps');
    expect(container?.children).toHaveLength(3);
    expect(container?.contains(writeEdit)).toBe(true);

    controller.disconnect();
  });
});
