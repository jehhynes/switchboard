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
    for (const frame of this.frames.values()) frame.hidden = true;
    if (view === null || !this.#urls.has(view.url)) return;
    let frame = this.frames.get(view.url);
    if (frame === undefined) {
      frame = document.createElement('iframe');
      frame.className = 'browser';
      frame.title = 'GitHub';
      frame.referrerPolicy = 'no-referrer';
      frame.allow = 'clipboard-write; fullscreen';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
      this.frames.set(view.url, frame);
      this.host.append(frame);
      frame.src = view.url;
    } else if (view.reload) frame.src = view.url;
    Object.assign(frame.style, { left: `${view.left}px`, top: `${view.top}px`, width: `${view.width}px`, height: `${view.height}px` });
    frame.hidden = false;
  }
}
