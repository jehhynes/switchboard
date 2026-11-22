// The persona dialog (architecture.md § Web page, § Personas): the roster with each persona's voice, style and personality, opened from the
// header's view options menu; a pick pins the persona to the session at once, and Clear pin takes a pin off.
import type { VNode } from 'preact';
import type { SessionView } from '@switchboard/protocol';
import type { View } from './render.js';

const capitalized = (text: string): string => (text === '' ? text : text[0]!.toUpperCase() + text.slice(1));

/** The dialog over the page while `menu` is open, as Settings is: centred on a desktop, the whole screen on a phone; nothing otherwise. */
export function renderPersonaDialog(current: SessionView['persona'] | undefined, menu: View['personas']): VNode | null {
  if (menu === null) {
    return null;
  }

  const body =
    menu.error !== null ? (
      <p class="persona-message">{menu.error}</p>
    ) : menu.items === null ? (
      <p class="persona-message">Loading…</p>
    ) : (
      <ul class="persona-list" aria-label="Personas">
        {menu.items.map((one) => {
          const chosen = current?.id === one.id;

          return (
            <li key={one.id}>
              <button type="button" class={`persona-option${chosen ? ' current' : ''}`} data-action="persona-pick" data-persona={one.id} aria-current={chosen ? 'true' : undefined}>
                <span class="menu-gutter" aria-hidden="true">
                  {chosen ? <span class="codicon codicon-check"></span> : null}
                </span>
                <span class="persona-text">
                  <span class="persona-name">
                    {one.name}
                    {chosen ? <span class="persona-tag">{current!.pinned ? 'Current, pinned' : 'Current'}</span> : null}
                  </span>
                  {one.voice === undefined ? null : <span class="persona-meta">{`Voice ${capitalized(one.voice)} · Style ${capitalized(one.style ?? 'none')}`}</span>}
                  {one.personality === undefined ? null : one.personality === '' ? <span class="persona-meta">No personality</span> : <span class="persona-personality">{one.personality}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );

  return (
    // A press on the backdrop, not on the dialog, closes it as Close does.
    <div class="persona-backdrop" data-action="persona-close">
      <div class="persona-dialog glass" role="dialog" aria-modal="true" aria-labelledby="persona-title">
        <div class="persona-head">
          <h2 id="persona-title" class="persona-title">
            Persona
          </h2>
          <button type="button" class="icon persona-close" data-action="persona-close" aria-label="Close" title="Close">
            <span class="codicon codicon-close" aria-hidden="true"></span>
          </button>
        </div>
        <div class="persona-body">
          {current?.tonePending === true ? <p class="persona-note">{`The session takes ${current.name}'s tone when it next resumes.`}</p> : null}
          {body}
        </div>
        {current?.pinned === true ? (
          <div class="persona-bar">
            <p class="persona-note">{`${current.name} is pinned to this session. Clear pin gives it its playbook's persona again, or one no other session has.`}</p>
            <button type="button" class="sheet-button secondary" data-action="persona-pick" data-persona="">
              Clear pin
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
