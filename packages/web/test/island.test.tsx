import { useLayoutEffect } from 'preact/hooks';
import { describe, expect, it } from 'vitest';
import { ISLAND, mount, unmount } from '../src/island.js';
import { morph } from '../src/morph.js';

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

  it("keeps an island's Preact children when morph redraws the region around it, and still updates the island's attributes", () => {
    const region = document.createElement('div');

    morph(region, `<p class="before">1</p><ul class="list" ${ISLAND}></ul>`);
    const island = region.querySelector('ul')!;

    mount(island, <Item name="kept" />);
    const item = island.querySelector('li')!;

    morph(region, `<p class="before">2</p><ul class="list wide" ${ISLAND}></ul>`);
    expect(region.querySelector('ul')).toBe(island);
    expect(island.className).toBe('list wide');
    expect(island.querySelector('li')).toBe(item);
    expect(region.querySelector('p')!.textContent).toBe('2');

    // Without the mark the same element's children follow the HTML.
    morph(region, '<p class="before">2</p><ul class="list wide"></ul>');
    expect(island.childNodes).toHaveLength(0);
  });

  it('unmounts an island when morph drops its mark or removes it, so its cleanups run and a later mount draws again', () => {
    const region = document.createElement('div');
    let cleaned = 0;

    morph(region, `<ul class="list" ${ISLAND}></ul>`);
    const island = region.querySelector('ul')!;

    mount(island, <Item name="one" gone={() => void cleaned++} />);
    morph(region, '<ul class="list"><li>plain</li></ul>');
    expect(cleaned).toBe(1);
    expect(island.textContent).toBe('plain');

    morph(region, `<ul class="list" ${ISLAND}></ul>`);
    mount(island, <Item name="two" gone={() => void cleaned++} />);
    expect(island.textContent).toBe('two');

    morph(region, `<p>gone</p>`);
    expect(cleaned).toBe(2);
    expect(region.querySelector('ul')).toBeNull();
  });
});
