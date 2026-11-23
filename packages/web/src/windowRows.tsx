import type { VNode } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PageRow } from '@switchboard/protocol';
import { rowKey } from './render.js';

const ESTIMATE = 72;
const BUFFER = 240;

/** A visible row's position before changing spacer heights. */
function visibleAnchor(ul: HTMLUListElement): { key: string; top: number } | null {
  const scroller = ul.closest<HTMLElement>('#list');
  if (scroller === null) return null;
  const pane = scroller.getBoundingClientRect();
  const rows = [...ul.querySelectorAll<HTMLElement>(':scope > [data-window-row]')];
  const current = rows.find((li) => li.contains(document.activeElement)) ?? rows.find((li) => li.querySelector('.selected') !== null);
  for (const li of current === undefined ? rows : [current, ...rows]) {
    const box = li.getBoundingClientRect();
    if (box.bottom > pane.top && box.top < pane.bottom) return { key: li.dataset['windowRow']!, top: box.top };
  }
  return null;
}

/** Done's rows share the list's scroller. Measured heights keep the normal row layout, including wrapping on a narrow list. */
export function WindowRows({ rows, selected, renderRow }: {
  rows: readonly PageRow[];
  selected: number | null;
  renderRow(row: PageRow, index: number): VNode;
}): VNode {
  const host = useRef<HTMLUListElement>(null);
  const heights = useRef(new Map<string, number>());
  const anchor = useRef<ReturnType<typeof visibleAnchor>>(null);
  const width = useRef<number | null>(null);
  const settled = useRef<{ anchor: ReturnType<typeof visibleAnchor>; scroll: number } | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 720, revision: 0 });
  const position = useRef(viewport);
  position.current = viewport;
  const [focused, setFocused] = useState<string | null>(null);
  const resize = (ul: HTMLUListElement, scroller: HTMLElement): boolean => {
    const next = ul.getBoundingClientRect().width;
    if (next === width.current) return false;
    if (width.current !== null) {
      anchor.current ??= settled.current?.scroll === scroller.scrollTop ? settled.current.anchor : visibleAnchor(ul);
      heights.current.clear();
    }
    width.current = next;
    return true;
  };
  const offsets = [0];

  for (const row of rows) offsets.push(offsets.at(-1)! + (heights.current.get(rowKey(row)) ?? ESTIMATE));

  const visible: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if ((offsets[index + 1]! >= viewport.top - BUFFER && offsets[index]! <= viewport.top + viewport.height + BUFFER)
      || (row.workItemId !== null && row.workItemId === selected) || rowKey(row) === focused || rowKey(row) === anchor.current?.key) visible.push(index);
  }

  useLayoutEffect(() => {
    const ul = host.current!;
    const scroller = ul.closest<HTMLElement>('#list');
    if (scroller === null) return;
    let frame: number | null = null;
    const update = (): void => {
      frame = null;
      const box = ul.getBoundingClientRect();
      if (box.width === 0 || scroller.clientHeight === 0) return;
      const resized = resize(ul, scroller);
      const top = scroller.getBoundingClientRect().top - box.top;
      if (!resized && position.current.top === top && position.current.height === scroller.clientHeight) return;
      anchor.current ??= visibleAnchor(ul);
      setViewport((old) => ({ top, height: scroller.clientHeight, revision: old.revision + Number(resized) }));
    };
    const schedule = (): void => { frame ??= requestAnimationFrame(update); };
    // Focus keys use the same identity as the list renderer.
    const onFocus = (): void => {
      const li = document.activeElement?.closest<HTMLElement>('[data-window-row]');
      setFocused(li !== null && li !== undefined && ul.contains(li) ? li.dataset['windowRow'] ?? null : null);
    };
    ul.addEventListener('focusin', onFocus);
    ul.addEventListener('focusout', onFocus);
    scroller.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(scroller);
    observer?.observe(ul);
    update();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      ul.removeEventListener('focusin', onFocus);
      ul.removeEventListener('focusout', onFocus);
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  useLayoutEffect(() => {
    const ul = host.current!;
    const saved = anchor.current;
    anchor.current = null;
    if (saved === null) return;
    const li = [...ul.querySelectorAll<HTMLElement>(':scope > [data-window-row]')].find((one) => one.dataset['windowRow'] === saved.key);
    const scroller = ul.closest<HTMLElement>('#list');
    if (li !== undefined && scroller !== null) scroller.scrollTop += li.getBoundingClientRect().top - saved.top;
  });

  useLayoutEffect(() => {
    const ul = host.current!;
    const button = selected === null ? null : ul.querySelector<HTMLElement>('.row.selected');
    if (button === null) return;
    button.scrollIntoView?.({ block: 'nearest' });
    // A selection's intentional jump replaces the anchor from measuring the newly mounted row.
    const li = button.closest<HTMLElement>('[data-window-row]')!;
    anchor.current = { key: li.dataset['windowRow']!, top: li.getBoundingClientRect().top };
  }, [selected]);

  useLayoutEffect(() => {
    const ul = host.current!;
    const measure = (): void => {
      const scroller = ul.closest<HTMLElement>('#list');
      if (scroller !== null && (ul.getBoundingClientRect().width === 0 || scroller.clientHeight === 0)) return;
      let changed = scroller !== null && resize(ul, scroller);
      const saved = visibleAnchor(ul);
      for (const li of ul.querySelectorAll<HTMLElement>(':scope > [data-window-row]')) {
        const height = li.getBoundingClientRect().height;
        const key = li.dataset['windowRow']!;
        if (height > 0 && heights.current.get(key) !== height) {
          heights.current.set(key, height);
          changed = true;
        }
      }
      if (changed) anchor.current ??= saved;
      const top = scroller === null ? viewport.top : scroller.getBoundingClientRect().top - ul.getBoundingClientRect().top;
      const height = scroller?.clientHeight ?? viewport.height;
      if (scroller !== null) settled.current = { anchor: saved, scroll: scroller.scrollTop };
      if (!changed && position.current.top === top && position.current.height === height) anchor.current = null;
      setViewport((old) => !changed && old.top === top && old.height === height ? old : { top, height, revision: old.revision + Number(changed) });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const li of ul.querySelectorAll<HTMLElement>(':scope > [data-window-row]')) observer?.observe(li);
    return () => observer?.disconnect();
  });

  const children: VNode[] = [];
  let end = 0;
  const gap = (from: number, to: number): void => {
    if (to > from) children.push(<li key={`gap:${from}`} aria-hidden="true" role="presentation" style={{ height: `${offsets[to]! - offsets[from]!}px`, pointerEvents: 'none' }} />);
  };
  for (const index of visible) {
    gap(end, index);
    children.push(renderRow(rows[index]!, index));
    end = index + 1;
  }
  gap(end, rows.length);
  return <ul class="rows" ref={host} style={{ overflowAnchor: 'none' }}>{children}</ul>;
}
