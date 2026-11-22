// The sheet over the page (architecture.md § Web page): Delete's or Stop session's question, Snooze…'s choices, a control's text as the dock's input
// dialog asks for it, or a drafted text the clipboard refused.
import type { ComponentChildren, VNode } from 'preact';
import { firstSnoozeDay, inputReady } from './render.js';
import type { Sheet } from './render.js';

/** Every sheet's frame: its title, its body and its buttons, over a backdrop that cancels it. */
function Frame({ title, children, buttons }: { title: string; children: ComponentChildren; buttons: ComponentChildren }) {
  return (
    <div class="sheet-backdrop" data-action="sheet-cancel">
      <div class="sheet glass" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <h2 id="sheet-title" class="sheet-title">
          {title}
        </h2>
        {children}
        <div class="sheet-buttons">{buttons}</div>
      </div>
    </div>
  );
}

/** The sheet over the page, or nothing: a question with Cancel and its action, Snooze…'s choices, date and comment, or a text to copy. */
export function renderSheet(sheet: Sheet | null, acting: boolean): VNode | null {
  if (sheet === null) {
    return null;
  }

  const cancel = (
    <button type="button" class="sheet-button secondary" data-action="sheet-cancel">
      Cancel
    </button>
  );
  const go = (label: string, disabled: boolean) => (
    <>
      {cancel}
      <button type="button" class="sheet-button primary" data-action="sheet-go" disabled={disabled}>
        {label}
      </button>
    </>
  );

  if (sheet.kind === 'confirm') {
    return (
      <Frame title={sheet.action.confirm?.question ?? sheet.action.label} buttons={go(sheet.action.confirm?.action ?? sheet.action.label, acting)}>
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
        <textarea class={`sheet-input${input.text === null ? '' : ' tall'}`} aria-label={input.question} value={sheet.text}></textarea>
        <p class="sheet-note">Ctrl+Enter to {input.action.toLowerCase().replace(/…$/, '')}.</p>
      </Frame>
    );
  }

  if (sheet.kind === 'text') {
    return (
      <Frame
        title={sheet.title}
        buttons={
          <button type="button" class="sheet-button primary" data-action="sheet-cancel">
            Close
          </button>
        }
      >
        <p class="sheet-detail">The browser did not allow the clipboard. Select the text and copy it.</p>
        <textarea class="sheet-text" readonly value={sheet.text}></textarea>
      </Frame>
    );
  }

  const first = firstSnoozeDay(sheet.choices);

  return (
    <Frame title={`Snooze ${sheet.title}`} buttons={go('Snooze', acting)}>
      <fieldset class="sheet-field">
        <legend>Snooze ends</legend>
        {sheet.choices.map((choice, index) => (
          <label class="sheet-choice">
            <input type="radio" name="snooze" value={String(index)} checked={sheet.picked === String(index)} />
            <span>{choice.description === '' ? choice.label : `${choice.label} · ${choice.description}`}</span>
          </label>
        ))}
        <label class="sheet-choice">
          <input type="radio" name="snooze" value="date" disabled={first === null} checked={sheet.picked === 'date'} />
          <span>On</span>
          <input type="date" class="snooze-date" disabled={first === null} min={first ?? undefined} value={sheet.date} aria-label="Snooze end date" />
        </label>
      </fieldset>
      <label class="sheet-field">
        <span class="sheet-label">Comment</span>
        <textarea class="snooze-comment" rows={3} placeholder="Comment (optional)" value={sheet.comment}></textarea>
      </label>
    </Frame>
  );
}
