// Draws a Preact tree into a host element of the page (architecture.md § Web page).
import { Component, render } from 'preact';
import type { ComponentChild, FunctionComponent } from 'preact';

/** Draws a Preact tree into a host element, changing only what differs from the tree drawn there before. */
export function mount(host: Element, tree: ComponentChild): void {
  render(tree, host);
}

/** Removes the tree drawn into a host element, running its components' cleanups. */
export function unmount(host: Element): void {
  render(null, host);
}

/**
 * A component drawn again only when one of its props changed, compared by `===` as Preact's `memo` does, so a draw that changed nothing in it
 * neither renders nor compares its nodes again. Its props must hold everything it draws from.
 */
export function kept<P extends object>(draw: FunctionComponent<P>): new () => Component<P> {
  return class extends Component<P> {
    override shouldComponentUpdate(next: P): boolean {
      const keys = Object.keys(next) as Array<keyof P>;

      return keys.length !== Object.keys(this.props).length || keys.some((key) => next[key] !== this.props[key]);
    }

    override render(): ComponentChild {
      return draw(this.props);
    }
  };
}
