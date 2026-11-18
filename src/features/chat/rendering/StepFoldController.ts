import { setIcon } from 'obsidian';

import { markDecorative } from '@/shared/components/activatable';

const STEP_SELECTOR =
  '.grimoire-tool-step, .grimoire-write-edit-block, .grimoire-thinking-block, .grimoire-subagent-list, .grimoire-subagent-block';
const HEADER_CLASS = 'grimoire-step-toggle-header';
const CONTAINER_CLASS = 'grimoire-step-group-container';
const VISIBLE_STEP_WINDOW = 4;
const NEAR_BOTTOM_THRESHOLD_PX = 40;

let nextGroupId = 0;

function isStepElement(el: Element | null): el is HTMLElement {
  return Boolean(el && typeof el.matches === 'function' && el.matches(STEP_SELECTOR));
}

function isStepRunning(stepEl: Element): boolean {
  if (stepEl.classList.contains('is-running')) {
    return true;
  }
  return Boolean(stepEl.querySelector('.grimoire-tool-spinner, .is-running, .status-running'));
}

function formatHeaderLabel(stepsCount: number, running: boolean, expanded: boolean): string {
  if (expanded) {
    return running
      ? `Working... (${stepsCount} steps) · Show recent`
      : `${stepsCount} steps · Show recent`;
  }
  if (stepsCount > VISIBLE_STEP_WINDOW) {
    return running
      ? `Working... (${stepsCount} steps · showing recent)`
      : `${stepsCount} steps · Show all`;
  }
  return running ? `Working... (${stepsCount} steps)` : `${stepsCount} steps`;
}

/**
 * Groups consecutive intermediate execution steps (thinking blocks, tool calls,
 * subagents) inside assistant messages into a compact scrolling window of the
 * most recent steps, with a header toggle between recent steps and all steps.
 */
export class StepFoldController {
  private observer: MutationObserver | null = null;
  private syncing = false;
  private destroyed = false;
  private enabled: boolean;

  constructor(
    private readonly messagesEl: HTMLElement,
    private readonly scrollEl: HTMLElement | null = null,
    enabled = true,
  ) {
    this.enabled = enabled;
    const ObserverCtor = this.messagesEl.ownerDocument?.defaultView?.MutationObserver;
    if (typeof ObserverCtor === 'function') {
      this.observer = new ObserverCtor(() => {
        this.syncNow();
      });
      if (this.enabled) {
        this.startObserving();
      }
    }
    if (this.enabled) {
      this.syncNow();
    }
  }

  disconnect(): void {
    this.destroyed = true;
    this.observer?.disconnect();
    this.observer = null;
  }

  setEnabled(enabled: boolean): void {
    if (this.destroyed || this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (!enabled) {
      this.observer?.disconnect();
      this.unwrapAll();
      return;
    }
    this.startObserving();
    this.syncNow();
  }

  syncNow(): void {
    if (this.destroyed || !this.enabled || this.syncing || !this.messagesEl.children) {
      return;
    }

    const wasNearBottom = this.isNearBottom();
    this.syncing = true;
    let heightReduced = false;

    try {
      const contentEls = this.collectAssistantContentElements();
      for (const contentEl of contentEls) {
        if (this.syncContentElement(contentEl)) {
          heightReduced = true;
        }
      }
    } finally {
      this.observer?.takeRecords();
      this.syncing = false;
    }

    if (wasNearBottom && heightReduced && this.scrollEl) {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
    }
  }

  private startObserving(): void {
    this.observer?.observe(this.messagesEl, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private unwrapAll(): void {
    if (!this.messagesEl.children) {
      return;
    }
    this.syncing = true;
    try {
      for (const contentEl of this.collectAssistantContentElements()) {
        for (const child of Array.from(contentEl.children)) {
          if (child.classList.contains(HEADER_CLASS)) {
            child.remove();
          } else if (child.classList.contains(CONTAINER_CLASS)) {
            this.unwrapContainer(child);
          }
        }
      }
    } finally {
      this.observer?.takeRecords();
      this.syncing = false;
    }
  }

  private collectAssistantContentElements(): Element[] {
    const result: Element[] = [];
    for (const msgEl of Array.from(this.messagesEl.children)) {
      if (!msgEl.classList.contains('grimoire-message-assistant')) {
        continue;
      }
      for (const child of Array.from(msgEl.children)) {
        if (child.classList.contains('grimoire-message-content')) {
          result.push(child);
        }
      }
    }
    return result;
  }

  private isNearBottom(): boolean {
    if (!this.scrollEl) {
      return false;
    }
    const distanceFromBottom =
      this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight;
    return distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX;
  }

  private syncContentElement(contentEl: Element): boolean {
    this.cleanupOrphanedControls(contentEl);
    this.absorbAdjacentSteps(contentEl);
    const wrappedNew = this.groupContiguousStepRuns(contentEl);
    return this.updateGroups(contentEl, wrappedNew);
  }

  private cleanupOrphanedControls(contentEl: Element): void {
    const children = Array.from(contentEl.children);
    for (const child of children) {
      if (child.classList.contains(HEADER_CLASS)) {
        const next = child.nextElementSibling;
        if (!next || !next.classList.contains(CONTAINER_CLASS)) {
          child.remove();
        }
      } else if (child.classList.contains(CONTAINER_CLASS)) {
        const prev = child.previousElementSibling;
        if (!prev || !prev.classList.contains(HEADER_CLASS)) {
          this.unwrapContainer(child);
        }
      }
    }
  }

  private absorbAdjacentSteps(contentEl: Element): void {
    const containers = Array.from(contentEl.children).filter((child) =>
      child.classList.contains(CONTAINER_CLASS),
    );

    for (const container of containers) {
      if (!container.parentElement) {
        continue;
      }
      const header = container.previousElementSibling;
      if (header && header.classList.contains(HEADER_CLASS)) {
        let prev = header.previousElementSibling;
        while (prev && isStepElement(prev)) {
          const toMove = prev;
          prev = prev.previousElementSibling;
          container.insertBefore(toMove, container.firstChild);
        }
      }

      let next = container.nextElementSibling;
      while (next) {
        if (isStepElement(next)) {
          const toMove = next;
          next = next.nextElementSibling;
          container.appendChild(toMove);
          continue;
        }
        if (
          next.classList.contains(HEADER_CLASS) &&
          next.nextElementSibling?.classList.contains(CONTAINER_CLASS)
        ) {
          const nextHeader = next;
          const nextContainer = next.nextElementSibling;
          next = nextContainer.nextElementSibling;
          for (const nestedStep of Array.from(nextContainer.children)) {
            container.appendChild(nestedStep);
          }
          nextHeader.remove();
          nextContainer.remove();
          continue;
        }
        break;
      }
    }
  }

  private groupContiguousStepRuns(contentEl: Element): boolean {
    const children = Array.from(contentEl.children);
    let run: HTMLElement[] = [];
    let wrappedAny = false;

    const flushRun = (): void => {
      if (run.length >= 2) {
        this.wrapStepRun(contentEl, run);
        wrappedAny = true;
      }
      run = [];
    };

    for (const child of children) {
      if (isStepElement(child)) {
        run.push(child);
      } else {
        flushRun();
      }
    }
    flushRun();
    return wrappedAny;
  }

  private wrapStepRun(contentEl: Element, steps: HTMLElement[]): void {
    const doc = contentEl.ownerDocument;
    const containerId = `grimoire-step-group-${++nextGroupId}`;

    const header = doc.createElement('button');
    header.type = 'button';
    header.className = HEADER_CLASS;
    header.setAttribute('aria-controls', containerId);
    header.setAttribute('aria-expanded', 'false');

    const chevronEl = doc.createElement('span');
    chevronEl.className = 'grimoire-step-toggle-chevron';
    markDecorative(chevronEl);
    setIcon(chevronEl, 'chevron-right');

    const labelEl = doc.createElement('span');
    labelEl.className = 'grimoire-step-toggle-label';

    header.appendChild(chevronEl);
    header.appendChild(labelEl);

    const container = doc.createElement('div');
    container.id = containerId;
    container.className = `${CONTAINER_CLASS} is-compact`;

    header.addEventListener('click', () => {
      const wasNearBottom = this.isNearBottom();
      const currentlyExpanded = header.getAttribute('aria-expanded') === 'true';
      const nextExpanded = !currentlyExpanded;
      const stepsCount = Array.from(container.children).filter(isStepElement).length;
      const running = header.classList.contains('is-running');
      this.setGroupExpanded(header, container, nextExpanded, stepsCount, running);
      if (!nextExpanded) {
        container.scrollTop = container.scrollHeight;
      }
      if (wasNearBottom && this.scrollEl) {
        this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
      }
    });

    const anchor = steps[0];
    contentEl.insertBefore(header, anchor);
    contentEl.insertBefore(container, anchor);
    for (const step of steps) {
      container.appendChild(step);
    }
    container.scrollTop = container.scrollHeight;
  }

  private updateGroups(contentEl: Element, wrappedNew: boolean): boolean {
    let anyCompactUpdated = wrappedNew;
    const children = Array.from(contentEl.children);

    for (const child of children) {
      if (!child.classList.contains(CONTAINER_CLASS)) {
        continue;
      }
      const header = child.previousElementSibling;
      if (!header || !header.classList.contains(HEADER_CLASS)) {
        continue;
      }

      const steps = Array.from(child.children).filter(isStepElement);
      if (steps.length < 2) {
        this.unwrapContainer(child);
        header.remove();
        continue;
      }

      const running = steps.some(isStepRunning);
      const expanded = header.getAttribute('aria-expanded') === 'true';
      const prevCount = Number(header.getAttribute('data-step-count') ?? '0');
      const countGrew = steps.length > prevCount;
      header.setAttribute('data-step-count', String(steps.length));

      this.setGroupExpanded(header, child, expanded, steps.length, running);

      if (!expanded && (countGrew || !header.hasAttribute('data-window-initialized'))) {
        header.setAttribute('data-window-initialized', 'true');
        child.scrollTop = child.scrollHeight;
        if (steps.length > VISIBLE_STEP_WINDOW) {
          anyCompactUpdated = true;
        }
      }
    }

    return anyCompactUpdated;
  }

  private setGroupExpanded(
    header: Element,
    container: Element,
    expanded: boolean,
    stepsCount: number,
    running: boolean,
  ): void {
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    header.classList.toggle('is-expanded', expanded);
    header.classList.toggle('is-running', running);
    container.classList.toggle('is-compact', !expanded);

    const labelEl = header.querySelector('.grimoire-step-toggle-label');
    const nextLabel = formatHeaderLabel(stepsCount, running, expanded);
    if (labelEl && labelEl.textContent !== nextLabel) {
      labelEl.textContent = nextLabel;
    }
  }

  private unwrapContainer(container: Element): void {
    const parent = container.parentElement;
    if (!parent) {
      container.remove();
      return;
    }
    while (container.firstChild) {
      parent.insertBefore(container.firstChild, container);
    }
    container.remove();
  }
}
