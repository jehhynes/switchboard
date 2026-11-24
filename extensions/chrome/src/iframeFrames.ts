import type { FrameHole, HostPlacement } from './iframeHostView.js';

/**
 * The clip-path that cuts `holes` (viewport pixels) out of a frame at `left`, `top` sized `width` by `height`, or '' with none. The even-odd
 * rule fills a point inside an odd number of subpaths, so overlapping holes would fill again: a hole inside another's shape is dropped, and
 * holes that still overlap are split into disjoint square-cornered rectangles covering their union; the others keep their rounded corners.
 */
export function holesClip(left: number, top: number, width: number, height: number, holes: FrameHole[]): string {
  const inside = holes
    .map((hole) => {
      const x = Math.max(0, hole.left - left), y = Math.max(0, hole.top - top);
      const right = Math.min(width, hole.left - left + hole.width), bottom = Math.min(height, hole.top - top + hole.height);
      // A corner the frame's edge cuts off stays square, so no wedge of the frame shows beside a layer that runs past its edge.
      const l = x === hole.left - left, t = y === hole.top - top, rr = right === hole.left - left + hole.width, b = bottom === hole.top - top + hole.height;
      const r = hole.radius;
      return { x, y, w: right - x, h: bottom - y, r: [l && t ? r : 0, rr && t ? r : 0, rr && b ? r : 0, l && b ? r : 0] as const };
    })
    .filter((hole) => hole.w > 0 && hole.h > 0);
  type Box = typeof inside[number];
  /** Whether point (px, py) lies inside `a`'s rounded shape. */
  const within = (a: Box, px: number, py: number): boolean => {
    if (px < a.x || py < a.y || px > a.x + a.w || py > a.y + a.h) return false;
    const corners = [[a.x, a.y, a.r[0]], [a.x + a.w, a.y, a.r[1]], [a.x + a.w, a.y + a.h, a.r[2]], [a.x, a.y + a.h, a.r[3]]] as const;
    return corners.every(([cx, cy, radius]) => {
      const r = Math.min(radius, a.w / 2, a.h / 2);
      const dx = Math.abs(px - cx), dy = Math.abs(py - cy);
      if (r <= 0 || dx >= r || dy >= r) return true;
      return (r - dx) ** 2 + (r - dy) ** 2 <= r * r;
    });
  };
  // A box counts as inside another only when its square corners lie in the other's rounded shape, so a layer in a rounded corner is never dropped.
  const contains = (a: Box, b: Box): boolean => [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].every(([px, py]) => within(a, px!, py!));
  const kept = inside.filter((hole, i) => !inside.some((other, j) => j !== i && contains(other, hole) && (!contains(hole, other) || j < i)));
  if (kept.length === 0) return '';
  const crosses = (a: Box, b: Box): boolean => a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  // Holes that cross none keep their rounded corners; those that cross are split into square-cornered rectangles covering their union.
  const alone = kept.filter((a) => !kept.some((b) => crosses(a, b)));
  const crossing = kept.filter((a) => !alone.includes(a));
  const n = (value: number): string => String(Math.round(value * 100) / 100);
  /** A rectangle with its top-left, top-right, bottom-right and bottom-left radii. */
  const rect = (x: number, y: number, w: number, h: number, radii: readonly [number, number, number, number] = [0, 0, 0, 0]): string => {
    const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, w / 2, h / 2)));
    if (tl === 0 && tr === 0 && br === 0 && bl === 0) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
    const arc = (r: number, toX: number, toY: number): string => (r > 0 ? `A${n(r)} ${n(r)} 0 0 1 ${n(toX)} ${n(toY)}` : '');
    return `M${n(x + tl!)} ${n(y)}H${n(x + w - tr!)}${arc(tr!, x + w, y + tr!)}V${n(y + h - br!)}${arc(br!, x + w - br!, y + h)}H${n(x + bl!)}${arc(bl!, x, y + h - bl!)}V${n(y + tl!)}${arc(tl!, x + tl!, y)}Z`;
  };
  const cut = alone.map((hole) => rect(hole.x, hole.y, hole.w, hole.h, hole.r));
  if (crossing.length > 0) {
    const xs = [...new Set(crossing.flatMap((hole) => [hole.x, hole.x + hole.w]))].sort((a, b) => a - b);
    const ys = [...new Set(crossing.flatMap((hole) => [hole.y, hole.y + hole.h]))].sort((a, b) => a - b);
    for (let row = 0; row + 1 < ys.length; row++) {
      let start: number | null = null;
      for (let col = 0; col + 1 <= xs.length; col++) {
        const covered = col + 1 < xs.length && crossing.some((hole) => hole.x <= xs[col]! && hole.x + hole.w >= xs[col + 1]! && hole.y <= ys[row]! && hole.y + hole.h >= ys[row + 1]!);
        if (covered && start === null) start = xs[col]!;
        if (!covered && start !== null) { cut.push(rect(start, ys[row]!, xs[col]! - start, ys[row + 1]! - ys[row]!)); start = null; }
      }
    }
  }
  return `path(evenodd, "${[rect(0, 0, width, height), ...cut].join(' ')}")`;
}

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
      // The page's layers lie in its frame under this one: cut out, they show and take the pointer. Under a modal layer the whole frame passes
      // the pointer to the page, whose backdrop takes the press, and cannot hold the focus.
      frame.style.clipPath = visible ? holesClip(selected.left, selected.top, selected.width, selected.height, selected.holes) : '';
      frame.style.filter = visible && selected.dim > 0 ? `brightness(${Math.round((1 - selected.dim) * 1000) / 1000})` : '';
      frame.style.pointerEvents = visible && selected.modal ? 'none' : '';
      frame.toggleAttribute('inert', !visible || selected.modal);
      if (visible) frame.removeAttribute('aria-hidden');
      else frame.setAttribute('aria-hidden', 'true');
    }
  }
}
