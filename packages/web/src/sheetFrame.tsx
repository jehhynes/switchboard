// The frame every sheet over the page is drawn in (architecture.md § Web page, Sheets): a title bar, a body that scrolls, and a footer of
// buttons, over a backdrop that dismisses it.
import type { ComponentChildren } from 'preact';

export interface ModalFrameProps {
  title: ComponentChildren;
  /** The title's id, which names the dialog. */
  titleId: string;
  /** What dismisses the sheet: the `data-action` its page's click handler reads, or a handler. */
  dismiss: string | (() => void);
  /** The footer's buttons; none for a sheet the title bar's X closes. */
  buttons?: ComponentChildren | undefined;
  /** An X at the title bar's right, for a sheet whose footer has no Cancel or Close. */
  close?: boolean | undefined;
  /** A class for a sheet wider or laid out apart from the rest. */
  wide?: string | undefined;
  /** A class for the backdrop, as Settings' asks give theirs. */
  backdrop?: string | undefined;
  role?: 'dialog' | 'alertdialog';
  children?: ComponentChildren;
}

/** A sheet's frame: the title bar with its X where asked, the body, the footer, and a backdrop a press on which dismisses it. */
export function ModalFrame({ title, titleId, dismiss, buttons, close = false, wide, backdrop, role = 'dialog', children }: ModalFrameProps) {
  const action = typeof dismiss === 'string' ? { 'data-action': dismiss } : {};

  return (
    <div class={`sheet-backdrop${backdrop === undefined ? '' : ` ${backdrop}`}`} {...action} onClick={typeof dismiss === 'string' ? undefined : (event) => event.target === event.currentTarget && dismiss()}>
      <div class={`sheet${wide === undefined ? '' : ` ${wide}`}`} role={role} aria-modal="true" aria-labelledby={titleId}>
        <div class="sheet-head">
          <h2 id={titleId} class="sheet-title" title={typeof title === 'string' ? title : undefined}>
            {title}
          </h2>
          {close ? (
            <button type="button" class="icon sheet-close" {...action} onClick={typeof dismiss === 'string' ? undefined : dismiss} data-dismiss title="Close" aria-label="Close">
              <span class="codicon codicon-close" aria-hidden="true"></span>
            </button>
          ) : null}
        </div>
        <div class="sheet-body">{children}</div>
        {buttons === undefined ? null : <div class="sheet-foot">{buttons}</div>}
      </div>
    </div>
  );
}

/** A sheet of the list's header; its X and backdrop send `list-sheet-cancel`. */
export function SheetFrame({ title, children, buttons, wide, close }: { title: string; children: ComponentChildren; buttons?: ComponentChildren; wide?: 'hub-log-sheet' | 'held-sheet' | 'pair-sheet' | undefined; close?: boolean | undefined }) {
  return (
    <ModalFrame title={title} titleId="list-sheet-title" dismiss="list-sheet-cancel" buttons={buttons} close={close} wide={wide}>
      {children}
    </ModalFrame>
  );
}
