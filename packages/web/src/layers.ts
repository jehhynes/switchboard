// The page's modal layers (architecture.md § Web page, Layers): each open dialog (`aria-modal`) is a layer over the page. The top layer makes
// the rest of the page inert, takes the focus when it opens, takes every Escape, and gives the focus back to the control that opened it when it
// closes. The toast, the connection screen and the live region stay live over it.

/** The controls that can take the focus. */
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
/** A control that can open a layer, as a click, a key or the focus finds it; a row of the list has a tab stop of -1 while another row holds it. */
const CONTROL = 'button, a[href], input, select, textarea, [tabindex], [role="tab"]';

export interface Layers {
  /** Takes in the dialogs opened and closed since the last call; each part that draws a dialog calls it once the dialog is drawn or removed. */
  sync(): void;
  /** Stops following the page. */
  close(): void;
}

/** The page's children that stay live over every layer: the toast, so its Dismiss works and it is still read out, the connection screen and the live region. */
const live = (child: Element): boolean => child.id === 'toast' || child.id === 'connection' || child.classList.contains('live');

/**
 * The control a press, a key or the focus on `target` means. In a menu, which is gone by the time its row's dialog closes, it is what opened
 * the menu: the list row the menu belongs to, else the menu button that is open.
 */
export function controlOf(target: EventTarget | null, root: ParentNode): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const menu = target.closest('[role="menu"]');

  if (menu !== null) {
    return menu.closest('.list-row')?.querySelector<HTMLElement>('.row') ?? root.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
  }

  return target.closest<HTMLElement>(CONTROL);
}

/** Follows the modal dialogs drawn under `root`; `root`'s children are the hosts each dialog is drawn into. */
export function modalLayers(root: HTMLElement): Layers {
  const stack: Array<{ dialog: HTMLElement; opener: HTMLElement | null }> = [];
  // The control last pressed, chosen by a key or given the focus: the opener of the next dialog to open.
  let last: HTMLElement | null = null;
  const listening = new AbortController();
  const note = (event: Event): void => {
    last = controlOf(event.target, root) ?? last;
  };

  document.addEventListener('pointerdown', note, { capture: true, signal: listening.signal });
  document.addEventListener('focusin', note, { capture: true, signal: listening.signal });
  document.addEventListener('keydown', (event) => {
    // A page taken out of the document, as a test's, leaves the keys alone.
    if (!root.isConnected) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      note(event);
    }

    const top = stack.at(-1)?.dialog;

    // An Escape outside the top layer, as with the focus fallen to the page's body or on the toast, goes to the top layer alone.
    if (event.key === 'Escape' && top !== undefined && !(event.target instanceof Node && top.contains(event.target))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      top.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    }
  }, { capture: true, signal: listening.signal });

  const usable = (element: HTMLElement | null): element is HTMLElement => element !== null && element.isConnected && element.closest('[inert]') === null && !element.matches(':disabled');
  const sync = (): void => {
      const open = [...root.querySelectorAll<HTMLElement>('[aria-modal="true"]')];
      const kept = stack.filter((layer) => open.includes(layer.dialog));
      const closed = stack.filter((layer) => !open.includes(layer.dialog));
      const added = open.filter((dialog) => !stack.some((layer) => layer.dialog === dialog));
      // A dialog drawn anew in place of one that closed, as a sheet that changes its kind, keeps the opener of the one it replaced.
      const replaced = closed.length > 0 && added.length > 0 ? closed[0]!.opener : null;

      stack.splice(0, stack.length, ...kept, ...added.map((dialog) => ({ dialog, opener: replaced ?? (last !== null && !dialog.contains(last) ? last : null) })));

      const top = stack.at(-1)?.dialog ?? null;
      const host = top === null ? null : [...root.children].find((child) => child.contains(top)) ?? null;

      for (const child of root.children) {
        child.toggleAttribute('inert', host !== null && child !== host && !live(child));
      }

      const focused = document.activeElement;

      if (top !== null && added.includes(top) && replaced === null && !(focused !== null && top.contains(focused))) {
        // A layer that opens without placing the focus itself starts on its first control.
        top.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      } else if (closed.length > 0 && added.length === 0 && (focused === null || focused === document.body || !focused.isConnected)) {
        // The focus fell with the layer that closed: it goes back to what opened that layer, if that is still there to take it.
        const opener = closed.at(-1)!.opener;

        if (usable(opener) && (top === null || top.contains(opener))) {
          opener.focus();
        }
      }
  };

  return {
    sync,
    close: () => {
      listening.abort();
    },
  };
}
