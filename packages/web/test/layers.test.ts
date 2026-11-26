import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlOf, modalLayers } from '../src/layers.js';
import type { Layers } from '../src/layers.js';

describe('the modal layers (architecture.md § Web page, Layers)', () => {
  let root: HTMLElement;
  let layers: Layers;
  const host = (id: string): HTMLElement => root.querySelector<HTMLElement>(`#${id}`)!;
  const dialog = (id: string, markup = '<p>Text</p><button class="first">First</button><button>Second</button>'): HTMLElement => {
    host(id).innerHTML = `<div class="backdrop"><div class="dialog" role="dialog" aria-modal="true">${markup}</div></div>`;
    layers.sync();
    return host(id).querySelector<HTMLElement>('.dialog')!;
  };
  const shut = (id: string): void => {
    host(id).replaceChildren();
    layers.sync();
  };
  const press = (element: Element): void => void element.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  const escape = (target: EventTarget): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

    target.dispatchEvent(event);
    return event;
  };
  const inert = (): string[] => [...root.children].filter((child) => child.hasAttribute('inert')).map((child) => child.id || child.className);

  beforeEach(() => {
    root = document.createElement('div');
    root.innerHTML = '<main id="main"><button class="opener"><span class="icon"></span></button><input class="field"></main><div id="list-sheet"></div><div id="sheet"></div><div id="connection"></div><div class="live"></div><div id="toast"><button class="dismiss">Dismiss</button></div><div id="settings"></div>';
    document.body.replaceChildren(root);
    layers = modalLayers(root);
  });

  afterEach(() => {
    layers.close();
  });

  it('makes everything but the top layer inert while it is open, keeping the toast, the connection screen and the live region live', () => {
    dialog('sheet');
    expect(inert()).toEqual(['main', 'list-sheet', 'settings']);
    dialog('settings');
    // The top layer is the last open: the sheet under it is inert too.
    expect(inert()).toEqual(['main', 'list-sheet', 'sheet']);
    shut('settings');
    expect(inert()).toEqual(['main', 'list-sheet', 'settings']);
    shut('sheet');
    expect(inert()).toEqual([]);
  });

  it("puts the focus on a new layer's first control, unless it placed the focus inside itself", () => {
    dialog('sheet');
    expect(document.activeElement?.className).toBe('first');
    shut('sheet');
    host('sheet').innerHTML = '<div role="dialog" aria-modal="true"><button>One</button><textarea class="own"></textarea></div>';
    host('sheet').querySelector<HTMLElement>('.own')!.focus();
    layers.sync();
    expect(document.activeElement?.className).toBe('own');
  });

  it("starts a layer past its title bar's X, in document order, and on the X only when it is the layer's one control", () => {
    // The footer's button is listed first by a selector list in jsdom; the radio comes first in the document.
    dialog('sheet', '<div class="sheet-head"><button class="sheet-close">X</button></div><div class="sheet-body"><input type="radio" class="pick"></div><div class="sheet-foot"><button class="go">Go</button></div>');
    expect(document.activeElement?.className).toBe('pick');
    shut('sheet');
    dialog('sheet', '<div class="sheet-head"><button class="sheet-close">X</button></div><div class="sheet-body"><p>Nothing to press.</p></div>');
    expect(document.activeElement?.className).toBe('sheet-close');
  });

  it('gives the focus back to the control that opened a layer once the layer closes with the focus in it, even one pressed without taking the focus', () => {
    const opener = root.querySelector<HTMLElement>('.opener')!;

    // A press on the icon inside the button, which Safari does not focus.
    press(opener.querySelector('.icon')!);
    dialog('sheet');
    expect(document.activeElement?.className).toBe('first');
    shut('sheet');
    expect(document.activeElement).toBe(opener);

    // Chosen by the keyboard.
    const field = root.querySelector<HTMLElement>('.field')!;

    field.focus();
    dialog('sheet');
    shut('sheet');
    expect(document.activeElement).toBe(field);
  });

  it('leaves the focus where a closing part put it, and gives none to an opener that is gone or disabled', () => {
    const opener = root.querySelector<HTMLButtonElement>('.opener')!;
    const field = root.querySelector<HTMLElement>('.field')!;

    press(opener);
    dialog('sheet');
    host('sheet').replaceChildren();
    field.focus();
    layers.sync();
    expect(document.activeElement).toBe(field);

    press(opener);
    dialog('sheet');
    opener.disabled = true;
    shut('sheet');
    expect(document.activeElement).toBe(document.body);

    opener.disabled = false;
    press(opener);
    dialog('sheet');
    opener.remove();
    shut('sheet');
    expect(document.activeElement).toBe(document.body);
  });

  it('gives the focus back inside the layer under a nested one, and keeps the opener of a dialog drawn anew in place of another', () => {
    const outer = dialog('settings', '<button class="ask">Close</button><button>Other</button>');
    const ask = outer.querySelector<HTMLElement>('.ask')!;

    press(ask);
    outer.insertAdjacentHTML('beforeend', '<div class="inner" role="alertdialog" aria-modal="true"><button class="keep">Keep editing</button></div>');
    layers.sync();
    expect(document.activeElement?.className).toBe('keep');
    outer.querySelector('.inner')!.remove();
    layers.sync();
    expect(document.activeElement).toBe(ask);
    shut('settings');

    const opener = root.querySelector<HTMLElement>('.opener')!;

    press(opener);
    dialog('sheet');
    // Another kind of sheet replaces the first: its focus is its own, and closing it gives the focus back to the first one's opener.
    dialog('sheet', '<button class="second">Second</button>');
    expect(document.activeElement).toBe(document.body);
    shut('sheet');
    expect(document.activeElement).toBe(opener);
  });

  it('takes an Escape outside the top layer to the top layer alone, and leaves one inside it and one with no layer open as they are', () => {
    const seen: string[] = [];

    root.addEventListener('keydown', (event) => seen.push(`root:${(event.target as HTMLElement).className}`));
    document.body.addEventListener('keydown', () => seen.push('body'));

    // No layer: the event goes on.
    expect(escape(document.body).defaultPrevented).toBe(false);
    expect(seen).toEqual(['body']);
    seen.length = 0;

    const top = dialog('sheet');

    // From the page's body, where the focus falls after a press on a dialog's text, and from the toast, which stays live.
    const original = escape(document.body);

    // Only the one sent to the layer goes on, through the layer's host and up.
    expect(original.defaultPrevented).toBe(true);
    expect(seen).toEqual(['root:dialog', 'body']);
    seen.length = 0;
    escape(root.querySelector('#toast .dismiss')!);
    expect(seen).toEqual(['root:dialog', 'body']);
    seen.length = 0;
    // From inside it, once, as it was.
    expect(escape(top.querySelector('.first')!).defaultPrevented).toBe(false);
    expect(seen).toEqual(['root:first', 'body']);
  });

  it('names the opener of a menu row as the menu: the list row it belongs to, else the open menu button', () => {
    root.innerHTML = '<div class="list-row"><div class="row" tabindex="0"></div><ul role="menu"><li><button class="in-row">Snooze…</button></li></ul></div><button class="actions" aria-haspopup="menu" aria-expanded="true"></button><ul role="menu"><li><button class="in-head">Delete</button></li></ul>';
    expect(controlOf(root.querySelector('.in-row'), root)).toBe(root.querySelector('.row'));
    expect(controlOf(root.querySelector('.in-head'), root)).toBe(root.querySelector('.actions'));
    expect(controlOf(document, root)).toBeNull();
  });

  it('stops following the page once closed, or once its root leaves the document', () => {
    dialog('sheet');
    root.remove();
    expect(escape(document.body).defaultPrevented).toBe(false);
    document.body.append(root);
    layers.close();
    expect(escape(document.body).defaultPrevented).toBe(false);
  });
});
