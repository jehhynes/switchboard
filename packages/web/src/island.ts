// Where the page's Preact parts meet its string-drawn parts while the page moves to Preact (architecture.md § Web page).
import { render } from 'preact';
import type { ComponentChild } from 'preact';

/** Marks an element whose children Preact draws: `morph` keeps its children, so a string-drawn region can hold a Preact part. */
export const ISLAND = 'data-island';

/** Draws a Preact tree into a host element, changing only what differs from the tree drawn there before. */
export function mount(host: Element, tree: ComponentChild): void {
  render(tree, host);
}

/** Removes the tree drawn into a host element, running its components' cleanups. */
export function unmount(host: Element): void {
  render(null, host);
}
