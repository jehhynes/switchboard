import { useLayoutEffect } from 'preact/hooks';
import { describe, expect, it } from 'vitest';
import { mount, unmount } from '../src/island.js';

function Item({ name, gone }: { name: string; gone?: () => void }) {
  useLayoutEffect(() => gone, [gone]);
  return <li class="item">{name}</li>;
}

describe('Preact parts of the page', () => {
  it('draws a tree into its host and changes only the nodes that differ on the next draw', () => {
    const host = document.createElement('ul');

    mount(host, [<Item key="a" name="one" />, <Item key="b" name="two" />]);
    const first = host.querySelector('li')!;

    mount(host, [<Item key="a" name="one, changed" />, <Item key="b" name="two" />]);
    expect([...host.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one, changed', 'two']);
    expect(host.querySelector('li')).toBe(first);
  });

  it('shows text with markup as text', () => {
    const host = document.createElement('ul');

    mount(host, <Item name={'<img src=x onerror="alert(1)">'} />);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it("removes a host's tree and runs its cleanups", () => {
    const host = document.createElement('ul');
    let cleaned = 0;

    mount(host, <Item name="one" gone={() => void cleaned++} />);
    unmount(host);
    expect(host.childNodes).toHaveLength(0);
    expect(cleaned).toBe(1);
  });

});
