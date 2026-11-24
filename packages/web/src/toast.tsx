// The page's toast (architecture.md § Web page, Toast): one message at a time at the page's top, a refusal or failure in
// the warning colours, any other message, such as a copy that worked or a work item that started needing the operator, in neutral ones.
import type { VNode } from 'preact';
import { mount, unmount } from './island.js';

/** `warning` for a refusal or failure, `info` for a message that reports no problem. */
export type ToastTone = 'warning' | 'info';

export interface ToastMessage {
  text: string;
  tone: ToastTone;
  /** The work item a click on the message opens, for the needs-you message; null for none. */
  workItemId: number | null;
}

/** How long a message shows on a visible page with the pointer off it, carried over from the retired dock's status toast. */
export const TOAST_SHOWN_MS = 10_000;
/** How often the page counts that time. */
const TOAST_TICK_MS = 1_000;

/** The toast: the message, a link to its work item when it has one, and Dismiss; nothing without a message. */
export function renderToast(message: ToastMessage | null): VNode | null {
  if (message === null) {
    return null;
  }

  return (
    <div class={`toast ${message.tone}`} role={message.tone === 'warning' ? 'alert' : 'status'}>
      {message.workItemId === null ? (
        <span class="toast-text">{message.text}</span>
      ) : (
        <button type="button" class="toast-text toast-open" data-action="toast-open" title="Open this work item">
          {message.text}
        </button>
      )}
      <button type="button" class="icon dismiss" data-action="toast-dismiss" title="Dismiss" aria-label="Dismiss">
        <span class="codicon codicon-close" aria-hidden="true"></span>
      </button>
    </div>
  );
}

export interface ToastDeps {
  /** Opens a work item, as a click on its row does. */
  open(workItemId: number): void;
}

export interface Toast {
  /** Shows a message in place of the one shown; the same message again starts its time again. */
  show(text: string, tone?: ToastTone, workItemId?: number | null): void;
  /** Hides the message, or only a message of `tone`. */
  clear(tone?: ToastTone): void;
  /** The message shown, or null. */
  current(): ToastMessage | null;
  close(): void;
}

let active: Toast | null = null;

/**
 * Shows a message in the page's toast: a refusal or failure as `warning`, the default, any other as `info`. For modules that do not hold the
 * page's toast, such as its requests; does nothing before the page starts or after it closes.
 */
export function showToast(text: string, tone: ToastTone = 'warning'): void {
  active?.show(text, tone);
}

/** Hides the page's toast, or only a message of `tone`. */
export function clearToast(tone?: ToastTone): void {
  active?.clear(tone);
}

/**
 * The page's toast, drawn into `host`: it hides once it has shown for `TOAST_SHOWN_MS` on a visible page with the pointer off it, the pointer
 * leaving it starting that time again, and Dismiss hides it at once.
 */
export function toast(host: HTMLElement, deps: ToastDeps): Toast {
  let message: ToastMessage | null = null;
  let shown = 0;
  let hovered = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const draw = (): void => mount(host, renderToast(message));
  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const hide = (): void => {
    message = null;
    stop();
    draw();
  };
  const tick = (): void => {
    shown = hovered || document.hidden ? 0 : shown + TOAST_TICK_MS;

    if (shown >= TOAST_SHOWN_MS) {
      hide();
    }
  };
  const click = (event: Event): void => {
    const action = (event.target as HTMLElement).closest?.<HTMLElement>('[data-action]')?.dataset['action'];
    const workItemId = message?.workItemId ?? null;

    if (action === 'toast-dismiss') {
      hide();
    } else if (action === 'toast-open') {
      hide();

      if (workItemId !== null) {
        deps.open(workItemId);
      }
    }
  };
  /** Starts the time again from now, with a new count, so a message shown or left between two counts still gets its whole time. */
  const restart = (): void => {
    shown = 0;
    stop();
    timer = setInterval(tick, TOAST_TICK_MS);
  };
  const over = (): void => void (hovered = true);
  // The 1-second count could miss a short hover, so leaving the toast starts its time again.
  const leave = (): void => {
    hovered = false;

    if (message !== null) {
      restart();
    }
  };

  host.addEventListener('click', click);
  host.addEventListener('pointerover', over);
  host.addEventListener('pointerleave', leave);

  const box: Toast = {
    show: (text, tone = 'warning', workItemId = null) => {
      message = { text, tone, workItemId };
      restart();
      draw();
    },
    clear: (tone) => {
      if (message !== null && (tone === undefined || message.tone === tone)) {
        hide();
      }
    },
    current: () => message,
    close: () => {
      stop();
      message = null;
      host.removeEventListener('click', click);
      host.removeEventListener('pointerover', over);
      host.removeEventListener('pointerleave', leave);
      unmount(host);

      if (active === box) {
        active = null;
      }
    },
  };

  active = box;
  return box;
}
