import type { ComponentChildren } from 'preact';

/** Header sheets share a title, body, action row and cancelling backdrop. */
export function SheetFrame({ title, children, buttons, wide }: { title: string; children: ComponentChildren; buttons: ComponentChildren; wide?: 'hub-log-sheet' | 'held-sheet' }) {
  return <div class="sheet-backdrop" data-action="list-sheet-cancel">
    <div class={`sheet glass${wide === undefined ? '' : ` ${wide}`}`} role="dialog" aria-modal="true" aria-labelledby="list-sheet-title">
      <h2 id="list-sheet-title" class="sheet-title">{title}</h2>
      {children}
      <div class="sheet-buttons">{buttons}</div>
    </div>
  </div>;
}
