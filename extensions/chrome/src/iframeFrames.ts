import type { HostPlacement } from './iframeHostView.js';

/** Frames stay attached while hidden, so tab changes preserve their documents. */
export class IframeFrames {
  #item: number | null = null;
  #urls = new Set<string>();
  readonly frames = new Map<string, HTMLIFrameElement>();
  constructor(private readonly host: HTMLElement) {}
  reconcile(item: number | null, urls: string[]): void {
    this.#urls = new Set(urls);
    for (const [url, frame] of this.frames) {
      if (item !== this.#item || !this.#urls.has(url)) {
        frame.remove();
        this.frames.delete(url);
      }
    }
    this.#item = item;
  }
  show(view: HostPlacement | null): void {
    const selected = view !== null && this.#urls.has(view.url) ? view : null;
    if (selected !== null) {
      let frame = this.frames.get(selected.url);
      if (frame === undefined) {
        frame = document.createElement('iframe');
        frame.className = 'browser';
        frame.title = new URL(selected.url).hostname;
        frame.referrerPolicy = 'no-referrer';
        frame.allow = 'clipboard-write; fullscreen';
        frame.style.visibility = 'hidden';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
        this.frames.set(selected.url, frame);
        frame.src = selected.url;
        this.host.append(frame);
      } else if (selected.reload) frame.src = selected.url;
      Object.assign(frame.style, { left: `${selected.left}px`, top: `${selected.top}px`, width: `${selected.width}px`, height: `${selected.height}px` });
    }
    for (const [url, frame] of this.frames) {
      const visible = url === selected?.url;
      // display:none resets an iframe's scroll position in Edge; keep its viewport while hidden.
      frame.style.visibility = visible ? 'visible' : 'hidden';
      frame.toggleAttribute('inert', !visible);
      if (visible) frame.removeAttribute('aria-hidden');
      else frame.setAttribute('aria-hidden', 'true');
    }
  }
}
