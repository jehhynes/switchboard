// The sheet over the page (architecture.md § Web page): Delete's or Stop session's question, Snooze…'s choices, a control's text as an input
// dialog asks for it, or a drafted text the clipboard refused.
import type { ComponentChildren, VNode } from 'preact';
import { GrowingText } from './grow.js';
import { firstSnoozeDay, inputReady } from './render.js';
import type { Sheet } from './render.js';
import { ModalFrame } from './sheetFrame.js';

/** The row actions whose question asks before something that cannot be undone, so their button is drawn in the danger colour. */
const DESTRUCTIVE: ReadonlySet<string> = new Set(['delete', 'stop']);

/** Every row sheet's frame; its backdrop and X send `sheet-cancel`. */
function Frame({ title, subtitle, children, buttons, close }: { title: string; subtitle?: string | undefined; children: ComponentChildren; buttons: ComponentChildren; close?: boolean | undefined }) {
  return (
    <ModalFrame title={title} subtitle={subtitle} titleId="sheet-title" dismiss="sheet-cancel" buttons={buttons} close={close}>
      {children}
    </ModalFrame>
  );
}

/** The sheet over the page, or nothing: a question with Cancel and its action, Snooze…'s choices, date and comment, or a text to copy. */
export function renderSheet(sheet: Sheet | null, acting: boolean): VNode | null {
  if (sheet === null) {
    return null;
  }

  const cancel = (
    <button type="button" class="sheet-button secondary" data-action="sheet-cancel" data-dismiss>
      Cancel
    </button>
  );
  const go = (label: string, disabled: boolean, danger = false) => (
    <>
      {cancel}
      <button type="button" class={`sheet-button primary${danger ? ' danger' : ''}`} data-action="sheet-go" disabled={disabled}>
        {label}
      </button>
    </>
  );

  if (sheet.kind === 'confirm') {
    return (
      <Frame title={sheet.action.confirm?.question ?? sheet.action.label} buttons={go(sheet.action.confirm?.action ?? sheet.action.label, acting, DESTRUCTIVE.has(sheet.action.action))}>
        <p class="sheet-detail">{sheet.action.confirm?.detail ?? ''}</p>
      </Frame>
    );
  }

  if (sheet.kind === 'input') {
    const { input } = sheet;

    return (
      <Frame title={input.question} buttons={go(input.action, acting || !inputReady(sheet))}>
        <p class="sheet-detail">{input.detail}</p>
        {input.choice === null ? null : (
          <label class="sheet-field">
            <span class="sheet-label">{input.choice.label}</span>
            <select class="sheet-select">
              {input.choice.values.map((value) => (
                <option value={value} selected={value === sheet.picked}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
        <GrowingText class={`sheet-input${input.text === null ? '' : ' tall'}`} rows={input.text === null ? 3 : 6} aria-label={input.question} value={sheet.text} />
        <p class="sheet-note keys">Ctrl+Enter to {input.action.toLowerCase().replace(/…$/, '')}.</p>
      </Frame>
    );
  }

  if (sheet.kind === 'text') {
    return (
      <Frame
        title={sheet.title}
        close
        buttons={
          <button type="button" class="sheet-button primary" data-action="sheet-cancel" data-dismiss>
            Close
          </button>
        }
      >
        <p class="sheet-detail">The browser did not allow the clipboard. Select the text and copy it.</p>
        <GrowingText class="sheet-text" rows={6} readonly value={sheet.text} />
      </Frame>
    );
  }

  const first = firstSnoozeDay(sheet.choices);
  // The timed choices, then a picked date, then the snooze that only Unsnooze ends.
  const timed = sheet.choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.until !== null);
  const open = sheet.choices.map((choice, index) => ({ choice, index })).filter(({ choice }) => choice.until === null);
  const row = ({ choice, index }: { choice: (typeof sheet.choices)[number]; index: number }) => (
    <label class="sheet-choice">
      <input type="radio" name="snooze" value={String(index)} checked={sheet.picked === String(index)} />
      <span class="sheet-choice-label">{choice.label}</span>
      {choice.description === '' ? null : <span class="sheet-choice-detail">{choice.description}</span>}
    </label>
  );

  return (
    <Frame title="Snooze" subtitle={sheet.title} buttons={go('Snooze', acting)}>
      <fieldset class="sheet-field">
        <legend class="sheet-label">Wake on</legend>
        <div class="sheet-card">
          {timed.map(row)}
          <label class="sheet-choice">
            <input type="radio" name="snooze" value="date" disabled={first === null} checked={sheet.picked === 'date'} />
            <span class="sheet-choice-label">On</span>
            <input type="date" class="snooze-date" disabled={first === null} min={first ?? undefined} value={sheet.date} aria-label="Snooze end date" />
          </label>
          {open.map(row)}
        </div>
      </fieldset>
      <label class="sheet-field">
        <span class="sheet-label">Comment</span>
        <GrowingText class="snooze-comment" rows={2} placeholder="Optional, such as what it waits for" value={sheet.comment} />
      </label>
    </Frame>
  );
}
