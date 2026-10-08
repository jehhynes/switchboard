import type { Card } from '@switchboard/core/group';
import { openUri } from './open.js';
import type { SnoozeMenus } from './snooze.js';

const ITEM = 'switchboard-menu-item';
const SVG = (path: string) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" class="octicon"><path d="${path}"/></svg>`;
// Codicons (CC BY 4.0): vscode, and clockface and debug-restart as the panel's Snooze and Restore controls show them.
const VSCODE = SVG(
  'M15.434 1.72887L12.14 0.144875C12.002 0.078875 11.855 0.046875 11.709 0.046875C11.353 0.046875 11.18 0.211875 11.155 0.228875C11.073 0.270875 11.005 0.337875 11.004 0.338875L4.698 6.08888L1.951 4.00488C1.832 3.91388 1.69 3.86987 1.548 3.86987C1.387 3.86987 1.226 3.92788 1.1 4.04288L0.219 4.84387C0.074 4.97587 0.001 5.15688 0.001 5.33687C0.001 5.51687 0.073 5.69688 0.218 5.82888L2.6 8.00088L0.217 10.1719C0.072 10.3039 0 10.4839 0 10.6639C0 10.8439 0.073 11.0249 0.218 11.1569L1.099 11.9579C1.226 12.0729 1.386 12.1309 1.547 12.1309C1.688 12.1309 1.83 12.0859 1.95 11.9959L4.697 9.91187L11.003 15.6619C11.003 15.6619 11.072 15.7299 11.155 15.7719C11.179 15.7889 11.353 15.9529 11.709 15.9529C11.855 15.9529 12.003 15.9209 12.141 15.8549L15.435 14.2709C15.781 14.1049 16.001 13.7539 16.001 13.3699V2.62888C16.001 2.24487 15.781 1.89488 15.435 1.72787L15.434 1.72887ZM7.217 7.99988L12.002 4.36987V11.6299L7.217 7.99988Z',
);
const CLOCKFACE = SVG(
  'M2 8C2 4.68629 4.68629 2 8 2C11.3137 2 14 4.68629 14 8C14 11.3137 11.3137 14 8 14C4.68629 14 2 11.3137 2 8ZM8 1C4.13401 1 1 4.13401 1 8C1 11.866 4.13401 15 8 15C11.866 15 15 11.866 15 8C15 4.13401 11.866 1 8 1ZM8 4.5C8 4.22386 7.77614 4 7.5 4C7.22386 4 7 4.22386 7 4.5V8.5C7 8.77614 7.22386 9 7.5 9H10.5C10.7761 9 11 8.77614 11 8.5C11 8.22386 10.7761 8 10.5 8H8V4.5Z',
);
const DEBUG_RESTART = SVG(
  'M14 8C14 8.81 13.842 9.596 13.528 10.336C13.224 11.053 12.791 11.694 12.241 12.243C11.694 12.791 11.053 13.224 10.337 13.528C9.59602 13.841 8.81002 14 8.00002 14C7.19002 14 6.40402 13.842 5.66402 13.528C4.94702 13.224 4.30602 12.791 3.75702 12.242C3.20802 11.693 2.77602 11.053 2.47202 10.337C2.31002 9.956 2.48802 9.516 2.86902 9.354C3.25102 9.19 3.69002 9.37 3.85202 9.751C4.08102 10.288 4.40502 10.77 4.81802 11.181C5.23002 11.595 5.71202 11.919 6.24902 12.148C7.35602 12.615 8.64302 12.615 9.75202 12.148C10.288 11.919 10.77 11.595 11.181 11.183C11.595 10.77 11.919 10.288 12.148 9.751C12.381 9.197 12.501 8.608 12.501 8C12.501 7.392 12.382 6.803 12.148 6.248C11.919 5.712 11.595 5.23 11.182 4.819C10.77 4.405 10.288 4.081 9.75102 3.852C8.64402 3.385 7.35702 3.385 6.24802 3.852C5.71202 4.081 5.23002 4.405 4.81902 4.817C4.60802 5.027 4.42002 5.256 4.25702 5.5H6.24902C6.66302 5.5 6.99902 5.836 6.99902 6.25C6.99902 6.664 6.66302 7 6.24902 7H2.74902C2.33502 7 1.99902 6.664 1.99902 6.25V2.75C1.99902 2.336 2.33502 2 2.74902 2C3.16302 2 3.49902 2.336 3.49902 2.75V4.032C3.58202 3.938 3.66802 3.845 3.75802 3.757C4.30502 3.209 4.94602 2.776 5.66202 2.472C7.14402 1.845 8.85402 1.845 10.335 2.472C11.052 2.776 11.693 3.209 12.242 3.758C12.791 4.307 13.223 4.947 13.527 5.663C13.84 6.404 13.999 7.19 13.999 8H14Z',
);

/** The board card whose More actions button opened `list`: the button and the menu share the tooltip id in `aria-labelledby`. */
export function menuCard(doc: Document, list: Element): { card: Element; button: Element } | null {
  const label = list.getAttribute('aria-labelledby');

  for (const button of doc.querySelectorAll('[data-board-card-id] button[aria-haspopup="true"]')) {
    if (label !== null && button.getAttribute('aria-labelledby') === label) {
      return { card: button.closest('[data-board-card-id]')!, button };
    }
  }

  return null;
}

/** A Switchboard item made from a copy of one of GitHub's plain items, so it keeps GitHub's current styling. */
function menuItem(template: Element, label: string, icon: string, run: () => void): Element {
  const item = template.cloneNode(true) as Element;

  for (const attribute of ['id', 'aria-labelledby', 'aria-keyshortcuts', 'aria-disabled', 'data-is-disabled', 'data-variant']) {
    item.removeAttribute(attribute);
  }

  for (const element of item.querySelectorAll('[id]')) {
    element.removeAttribute('id');
  }

  item.querySelector('[data-component="ActionList.TrailingVisual"]')?.remove();
  item.classList.add(ITEM);
  item.setAttribute('tabindex', '-1');
  item.setAttribute('aria-label', label);
  item.querySelector('[data-component="ActionList.Item.Label"]')!.textContent = label;

  const visual = item.querySelector('[data-component="ActionList.LeadingVisual"]');

  if (visual !== null) {
    visual.innerHTML = icon;
  }

  item.addEventListener('click', (event) => {
    event.stopPropagation();
    run();
  });
  item.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter' || (event as KeyboardEvent).key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      run();
    }
  });

  return item;
}

/**
 * Keeps Switchboard's items after a divider at the bottom of a card's More actions menu, for a card whose issue the hub lists:
 * Open in Switchboard (PRD R69), and outside Done, Snooze in Switchboard or, on a snoozed card, Unsnooze in Switchboard (PRD R66).
 * Items that already match the card are left alone, so a pass that changes nothing makes no mutation. A menu without a plain
 * GitHub item to copy gets none.
 */
export function addMenuItems(doc: Document, list: Element, card: (url: string) => Card | undefined, snooze: SnoozeMenus, open: (uri: string) => void): void {
  const owner = menuCard(doc, list);
  const template = list.querySelector(`:scope > li[role="menuitem"]:not([aria-haspopup]):not([data-variant]):not(.${ITEM})`);
  const url = owner?.card.querySelector('h3[id^="board-card-title-"]')?.closest('a')?.href;
  const found = url === undefined ? undefined : card(url);
  const target = owner !== null && template !== null && url !== undefined && found !== undefined ? { button: owner.button, template, url, found } : null;
  const wanted = target === null ? '' : target.found.group === 'done' ? 'open' : target.found.snoozed ? 'open unsnooze' : 'open snooze';

  if ((list.getAttribute('data-switchboard-items') ?? '') === wanted) {
    return;
  }

  for (const element of list.querySelectorAll(`:scope > .${ITEM}, :scope > .${ITEM}-divider`)) {
    element.remove();
  }

  list.setAttribute('data-switchboard-items', wanted);

  if (target === null) {
    return;
  }

  const { button } = target;

  // GitHub's menu closes on Escape and returns focus to its button, under which a snooze popup opens.
  const closeGitHubMenu = (): void => void list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const divider = list.querySelector(':scope > li[data-component="ActionList.Divider"]')?.cloneNode(true) as Element | undefined;
  const items: Element[] = [
    menuItem(target.template, 'Open in Switchboard', VSCODE, () => {
      closeGitHubMenu();
      open(openUri(target.url));
    }),
  ];

  if (target.found.group !== 'done') {
    items.push(
      target.found.snoozed
        ? menuItem(target.template, 'Unsnooze in Switchboard', DEBUG_RESTART, () => {
            closeGitHubMenu();
            snooze.unsnooze(target.url, button);
          })
        : menuItem(target.template, 'Snooze in Switchboard…', CLOCKFACE, () => {
            closeGitHubMenu();
            snooze.choose(target.url, button);
          }),
    );
  }

  divider?.classList.add(`${ITEM}-divider`);
  list.append(...(divider === undefined ? [] : [divider]), ...items);
}

/** Watches for GitHub opening a card's More actions menu in its portal and adds Switchboard's items before it paints. */
export function watchCardMenus(doc: Document, card: (url: string) => Card | undefined, snooze: SnoozeMenus, open: (uri: string) => void): { stop(): void } {
  const observer = new MutationObserver(() => {
    for (const list of doc.querySelectorAll('ul[role="menu"][aria-labelledby]')) {
      addMenuItems(doc, list, card, snooze, open);
    }
  });

  observer.observe(doc.body, { childList: true, subtree: true });

  return { stop: () => observer.disconnect() };
}
