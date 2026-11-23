export interface HostPlacement {
  url: string;
  left: number;
  top: number;
  width: number;
  height: number;
  reload: boolean;
}
/** Only the verified Switchboard child may send a placement; validate its payload before navigating the sibling GitHub frame. */
export function hostPlacement(value: unknown, width: number, height: number): HostPlacement | null {
  if (typeof value !== 'object' || value === null) return null;
  const data = value as Record<string, unknown>;
  if (data['type'] !== 'switchboard-iframe' || typeof data['url'] !== 'string' || data['url'].length > 2048) return null;
  try {
    const url = new URL(data['url']);
    if (url.origin !== 'https://github.com' || url.username !== '' || url.password !== '') return null;
  } catch {
    return null;
  }
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
  return { url: data['url'], left: left as number, top: top as number, width: w as number, height: h as number, reload: data['reload'] === true };
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
    this.#allowed = true;
    this.#reported = this.deps.now();
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
    if (!(item === null || (Number.isSafeInteger(item) && (item as number) > 0)) || !Array.isArray(tabs) || tabs.length > 10 || new Set(tabs).size !== tabs.length || !tabs.every((url) => {
      if (typeof url !== 'string' || url.length > 2048) return false;
      try { const value = new URL(url); return value.origin === 'https://github.com' && value.username === '' && value.password === ''; } catch { return false; }
    })) { this.deps.show(null); return false; }
    if (data['url'] !== undefined && !tabs.includes(data['url'])) { this.deps.show(null); return false; }
    const { width, height } = this.deps.viewport();
    const placement = hostPlacement(data, width, height);
    if (data['url'] !== undefined && placement === null) { this.deps.show(null); return false; }
    if (epoch !== this.#epoch) { if (this.#epoch !== '') this.#oldEpochs.add(this.#epoch); this.#epoch = epoch; }
    this.#seq = seq as number;
    this.deps.reconcile(item as number | null, tabs as string[]);
    this.#reported = this.deps.now();
    if (typeof data['title'] === 'string' && data['title'].length <= 160) this.deps.title(data['title']);
    this.deps.show(placement);
    return true;
  }
  tick(): void {
    if (this.#allowed && this.deps.now() - this.#reported > 15_000) this.deps.show(null);
  }
}
