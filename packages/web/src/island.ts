// Draws a Preact tree into a host element of the page (architecture.md § Web page).
import { render } from 'preact';
import type { ComponentChild } from 'preact';

/** Draws a Preact tree into a host element, changing only what differs from the tree drawn there before. */
export function mount(host: Element, tree: ComponentChild): void {
  render(tree, host);
}

/** Removes the tree drawn into a host element, running its components' cleanups. */
export function unmount(host: Element): void {
  render(null, host);
}
