import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { snoozeChoices } from '@switchboard/core/snooze';
import type { PageAction } from '@switchboard/protocol';
import { grow } from '../src/grow.js';
import { renderSheet } from '../src/sheet.js';
import type { Sheet } from '../src/render.js';
import { ModalFrame } from '../src/sheetFrame.js';
import { renderHeaderSheet } from '../src/listHeader.js';
import type { HeaderSheet } from '../src/listHeader.js';

describe('the sheets over the page (architecture.md § Web page, Sheets)', () => {
  let host: HTMLElement;
  const draw = (node: Parameters<typeof render>[0]): void => {
    act(() => render(node, host));
  };
  const texts = (selector: string): string[] => [...host.querySelectorAll(selector)].map((one) => one.textContent ?? '');

  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  afterEach(() => {
    act(() => render(null, host));
  });

  it('draws a title bar, a body and a footer, with the X only where asked and no footer without buttons', () => {
    draw(<ModalFrame title="Pair a device" titleId="t" dismiss="list-sheet-cancel" close buttons={<button class="sheet-button">New code</button>}><p>Body</p></ModalFrame>);
    const sheet = host.querySelector('.sheet[role="dialog"][aria-modal="true"]')!;

    expect([...sheet.children].map((one) => one.className)).toEqual(['sheet-head', 'sheet-body', 'sheet-foot']);
    expect(sheet.getAttribute('aria-labelledby')).toBe('t');
    expect(host.querySelector('#t.sheet-title')?.textContent).toBe('Pair a device');
    const close = host.querySelector<HTMLElement>('.sheet-head > .sheet-close')!;
    expect(close.getAttribute('aria-label')).toBe('Close');
    expect(close.dataset['action']).toBe('list-sheet-cancel');
    expect(close.hasAttribute('data-dismiss')).toBe(true);
    expect(host.querySelector<HTMLElement>('.sheet-backdrop')!.dataset['action']).toBe('list-sheet-cancel');

    draw(<ModalFrame title="Log" titleId="t" dismiss="list-sheet-cancel" close><p>Body</p></ModalFrame>);
    expect(host.querySelector('.sheet-foot')).toBeNull();
    draw(<ModalFrame title="Delete it?" titleId="t" dismiss="sheet-cancel" buttons={<button>Cancel</button>}><p>Body</p></ModalFrame>);
    expect(host.querySelector('.sheet-close')).toBeNull();
  });

  it('dismisses through a handler from the X and a press on the backdrop, not from a press inside the sheet', () => {
    const dismiss = vi.fn();

    draw(<ModalFrame title="Save changes?" titleId="t" dismiss={dismiss} close role="alertdialog" backdrop="settings-ask"><p class="inside">Body</p></ModalFrame>);
    expect(host.querySelector('.sheet-backdrop.settings-ask > .sheet[role="alertdialog"]')).not.toBeNull();
    host.querySelector<HTMLElement>('.inside')!.click();
    expect(dismiss).not.toHaveBeenCalled();
    host.querySelector<HTMLElement>('.sheet-backdrop')!.click();
    host.querySelector<HTMLElement>('.sheet-close')!.click();
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it("offers Snooze's wake times, then On with its date, then Never, each a label with its detail under the legend Wake on", () => {
    // Monday 5 October 2026, 9:54.
    const choices = snoozeChoices(new Date(2026, 9, 5, 9, 54));
    const sheet: Sheet = { kind: 'snooze', row: 'item:1', label: 'Snooze…', title: 'Fix it', choices, picked: '0', date: '', comment: '' };

    draw(renderSheet(sheet, false));
    expect(host.querySelector('.sheet-title')?.textContent).toBe('Snooze');
    expect(host.querySelector('.sheet-subtitle')?.textContent).toBe('Fix it');
    expect(host.querySelector('legend')?.textContent).toBe('Wake on');
    expect(texts('.sheet-card > .sheet-choice .sheet-choice-label')).toEqual(['Tomorrow', 'In 2 days', 'In 3 days', 'Next week', 'In 2 weeks', 'In 4 weeks', 'On', 'Never']);
    expect(texts('.sheet-card > .sheet-choice')).toContain('NeverUntil you unsnooze it');
    expect(texts('.sheet-card > .sheet-choice')[0]).toBe('TomorrowTue, Oct 6, 6:00 AM');
    // Never sends no wake time: its radio is the choice whose until is null.
    expect(choices[Number(host.querySelector<HTMLInputElement>('.sheet-card > .sheet-choice:last-child input')!.value)]!.until).toBeNull();
    expect(host.querySelector('.sheet-choice .snooze-date')?.closest('.sheet-choice')?.textContent).toBe('On');
    // A form keeps its footer Cancel as its one dismiss control.
    expect(host.querySelector('.sheet-close')).toBeNull();
    expect(texts('.sheet-foot [data-dismiss]')).toEqual(['Cancel']);
    expect(host.querySelector('.sheet-foot .danger')).toBeNull();
  });

  it('draws Delete and Stop session in the danger colour and other questions plainly, starting none with an X', () => {
    const action = (name: string, label: string): PageAction => ({ label, action: name, icon: 'trash', group: 'state', confirm: { question: `${label} Fix it?`, detail: 'It goes for good.', action: label }, input: null });

    for (const [name, label, danger] of [['delete', 'Delete', true], ['stop', 'Stop session', true], ['mark-done', 'Mark done', false]] as const) {
      draw(renderSheet({ kind: 'confirm', row: 'item:1', action: action(name, label) }, false));
      expect([label, host.querySelector('[data-action="sheet-go"]')?.classList.contains('danger')]).toEqual([label, danger]);
      expect(host.querySelector('.sheet-close')).toBeNull();
    }
  });

  it("gives the copy-by-hand sheet an X beside its Close, and grows the input dialog's and Snooze's text boxes", () => {
    draw(renderSheet({ kind: 'text', title: 'Copy Reply', text: 'The draft' }, false));
    expect(host.querySelector('.sheet-head .sheet-close')).not.toBeNull();
    expect(texts('.sheet-foot [data-dismiss]')).toEqual(['Close']);
    expect(host.querySelector<HTMLTextAreaElement>('textarea.sheet-text')?.value).toBe('The draft');
    const input = { question: 'Add a comment', detail: 'Shown in History.', action: 'Add comment', text: null, choice: null };

    draw(renderSheet({ kind: 'input', row: 'item:1', label: 'Add comment…', input, text: '', picked: '' }, false));
    expect(host.querySelector('textarea.sheet-input')?.getAttribute('rows')).toBe('3');
    expect(host.querySelector('.sheet-close')).toBeNull();
  });

  it('sizes a text box to its text and borders, and leaves one with no layout alone', () => {
    const box = document.createElement('textarea');
    let height = 0;

    box.style.borderTop = '1px solid';
    box.style.borderBottom = '2px solid';
    Object.defineProperty(box, 'scrollHeight', { get: () => height });
    document.body.append(box);
    grow(box);
    expect(box.style.height).toBe('');
    height = 120;
    grow(box);
    expect(box.style.height).toBe('123px');
    height = 40;
    grow(box);
    expect(box.style.height).toBe('43px');
  });

  it("closes the header's tool sheets with an X and keeps the forms' Cancel and the folder browser's Back", () => {
    const tools: HeaderSheet[] = [
      { kind: 'devices', pairing: null, devices: [], busy: false, error: null, copied: null },
      { kind: 'held', rows: [], busy: false, refreshing: false, listError: null, error: null, result: null, stopping: null },
      { kind: 'log' },
      { kind: 'extension', remote: false },
      { kind: 'shortcut' },
      { kind: 'holder', busy: false, error: null },
    ] as HeaderSheet[];
    const read = async () => new Response('');

    for (const sheet of tools) {
      draw(renderHeaderSheet(sheet, null, 0, read));
      expect([sheet.kind, host.querySelector('.sheet-head .sheet-close') !== null, texts('.sheet-foot [data-dismiss]')]).toEqual([sheet.kind, true, []]);
    }
  });
});
