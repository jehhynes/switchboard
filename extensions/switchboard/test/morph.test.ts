import { describe, expect, it } from 'vitest';
import { morph } from '../src/webview/morph.js';

describe('morph', () => {
  const list = (keys: string[]) => keys.map((key) => `<button data-key="${key}">${key}</button>`).join('');

  it('keeps the focus on a keyed node that a reorder moves', () => {
    const root = document.createElement('div');

    document.body.replaceChildren(root);
    morph(root, list(['a', 'b']));

    const b = root.querySelector<HTMLButtonElement>('[data-key="b"]')!;

    b.focus();
    morph(root, list(['b', 'a']));

    expect(root.firstElementChild).toBe(b);
    expect(document.activeElement).toBe(b);
  });

  it('removes a gone keyed node without moving the ones after it', () => {
    const root = document.createElement('div');

    document.body.replaceChildren(root);
    morph(root, list(['a', 'b', 'c']));

    const b = root.querySelector('[data-key="b"]');
    const observer = new MutationObserver(() => {});

    observer.observe(root, { childList: true });
    morph(root, list(['b', 'c']));

    const records = observer.takeRecords();

    expect(root.firstElementChild).toBe(b);
    expect(records.flatMap((record) => [...record.addedNodes])).toEqual([]);
    expect(records.flatMap((record) => [...record.removedNodes]).map((node) => node.textContent)).toEqual(['a']);
  });

  it('keeps a text selection in a node that a reorder moves', () => {
    const root = document.createElement('div');

    document.body.replaceChildren(root);
    morph(root, '<p data-key="x">first</p><p data-key="y">second</p>');

    const text = root.querySelector('[data-key="y"]')!.firstChild!;

    document.getSelection()!.setBaseAndExtent(text, 0, text, 3);
    morph(root, '<p data-key="y">second</p><p data-key="x">first</p>');

    expect(document.getSelection()!.toString()).toBe('sec');
  });

  it('keeps a backward selection backward', () => {
    const root = document.createElement('div');

    document.body.replaceChildren(root);
    morph(root, '<p data-key="x">first</p><p data-key="y">second</p>');

    const text = root.querySelector('[data-key="y"]')!.firstChild!;
    const selection = document.getSelection()!;

    selection.setBaseAndExtent(text, 5, text, 1);
    morph(root, '<p data-key="y">second</p><p data-key="x">first</p>');

    expect([selection.anchorOffset, selection.focusOffset, selection.toString()]).toEqual([5, 1, 'econ']);
  });
});
