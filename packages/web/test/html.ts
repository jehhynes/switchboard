import { render } from 'preact';
import type { ComponentChild } from 'preact';

/** The HTML a Preact tree draws, for tests that read a part's markup. */
export function html(tree: ComponentChild): string {
  const host = document.createElement('div');

  render(tree, host);
  return host.innerHTML;
}
