import { frameUrl } from './iframeUrl.js';
/** A page layer over the website frame, in viewport pixels; the frame is cut out under it so the layer shows and takes the pointer. */
export interface FrameHole {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}
export const FRAME_HOLES_MAX = 16;
export interface HostPlacement {
  url: string;
  left: number;
  top: number;
  width: number;
  height: number;
  reload: boolean;
  holes: FrameHole[];
  /** How much a modal backdrop darkens the frame, 0 to 1. */
  dim: number;
  /** A modal layer is open: the frame passes the pointer to the page and cannot take focus. */
  modal: boolean;
}
function frameHoles(value: unknown, width: number, height: number): FrameHole[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FRAME_HOLES_MAX) return null;
  const holes: FrameHole[] = [];
  for (const hole of value) {
    if (typeof hole !== 'object' || hole === null) return null;
    const { left, top, width: w, height: h, radius } = hole as Record<string, unknown>;
    if (![left, top, w, h, radius].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    if ((w as number) <= 0 || (h as number) <= 0 || (w as number) > width + 2 || (h as number) > height + 2 || Math.abs(left as number) > width + 2 || Math.abs(top as number) > height + 2 || (radius as number) < 0 || (radius as number) > 1000) return null;
    holes.push({ left: left as number, top: top as number, width: w as number, height: h as number, radius: radius as number });
  }
  return holes;
}
/** Only the verified Switchboard child may send a placement; validate its payload before navigating the sibling website frame. */
export function hostPlacement(value: unknown, width: number, height: number, origin?: string): HostPlacement | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (data['type'] !== 'switchboard-iframe' || !frameUrl(data['url'], origin)) return null;
  const { left, top, width: w, height: h } = data;
  if (
    ![left, top, w, h].every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    (left as number) < -1 ||
    (top as number) < -1 ||
    (w as number) <= 0 ||
    (h as number) <= 0 ||
    (left as number) + (w as number) > width + 1 ||
    (top as number) + (h as number) > height + 1
  )
    return null;
  const holes = frameHoles(data['holes'], width, height);
  const dim = data['dim'] ?? 0;
  const modal = data['modal'] ?? false;
  if (holes === null || typeof dim !== 'number' || !(dim >= 0 && dim <= 1) || typeof modal !== 'boolean') return null;
  return { url: data['url'], left: left as number, top: top as number, width: w as number, height: h as number, reload: data['reload'] === true, holes, dim, modal };
}

export interface HostControllerDeps {
  origin: string;
  appWindow(): unknown;
  now(): number;
  show(view: HostPlacement | null): void;
  title(value: string): void;
  reconcile(item: number | null, urls: string[]): void;
  leave(): void;
  viewport(): { width: number; height: number };
  /** Tells the page this host cuts holes for its layers, so the page stops hiding the frame under them. */
  ack(): void;
}
/** Only the authenticated Switchboard child can control the sibling frame. */
export class IframeHostController {
  #allowed = false;
  #reported = 0;
  #seq = -1;
  #epoch = '';
  #oldEpochs = new Set<string>();
  constructor(private readonly deps: HostControllerDeps) {}
  allow(): void {
    if (this.#allowed) return;
    this.#allowed = true;
    this.#reported = this.deps.now();
  }
  block(): void {
    this.#allowed = false;
    this.deps.show(null);
  }
  message(event: { source: unknown; origin: string; data: unknown }): boolean {
    if (
      !this.#allowed ||
      event.source === null ||
      event.source !== this.deps.appWindow() ||
      event.origin !== this.deps.origin ||
      typeof event.data !== 'object' ||
      event.data === null
    )
      return false;
    const data = event.data as Record<string, unknown>;
    if (data['type'] === 'switchboard-iframe-disabled') {
      this.deps.show(null);
      this.deps.leave();
      return true;
    }
    if (data['type'] !== 'switchboard-iframe') return false;
    const seq = data['seq'], epoch = data['epoch'];
    if (typeof epoch !== 'string' || epoch.length < 1 || epoch.length > 100 || this.#oldEpochs.has(epoch) || !Number.isSafeInteger(seq) || (epoch === this.#epoch && (seq as number) <= this.#seq)) return false;
    const item = data['item'];
    const tabs = data['tabs'];
    if (!(item === null || (Number.isSafeInteger(item) && (item as number) > 0)) || !Array.isArray(tabs) || new Set(tabs).size !== tabs.length || !tabs.every((url) => frameUrl(url, this.deps.origin))) { this.deps.show(null); return false; }
    if (data['url'] !== undefined && (!frameUrl(data['url'], this.deps.origin) || !tabs.includes(data['url']))) { this.deps.show(null); return false; }
    const { width, height } = this.deps.viewport();
    const placement = hostPlacement(data, width, height, this.deps.origin);
    if (data['url'] !== undefined && placement === null) { this.deps.show(null); return false; }
    if (epoch !== this.#epoch) { if (this.#epoch !== '') this.#oldEpochs.add(this.#epoch); this.#epoch = epoch; }
    this.#seq = seq as number;
    this.deps.reconcile(item as number | null, tabs as string[]);
    this.#reported = this.deps.now();
    if (typeof data['title'] === 'string' && data['title'].length <= 160) this.deps.title(data['title']);
    this.deps.show(placement);
    this.deps.ack();
    return true;
  }
  tick(): void {
    if (this.#allowed && this.deps.now() - this.#reported > 15_000) this.deps.show(null);
  }
}
