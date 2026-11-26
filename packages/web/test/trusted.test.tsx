import { describe, expect, it, vi } from 'vitest';
import { mount } from '../src/island.js';
import { trusted } from '../src/trusted.js';
import { KEPT_ENTRIES, KEPT_LONGEST } from '../src/lru.js';

describe('trusted markup', () => {
  it('draws a renderer\'s HTML as nodes, keeping attributes, presence-only ones set and SVG in its namespace, and drops event handlers', () => {
    const host = document.createElement('div');

    mount(host, <div class="body">{trusted('<p class="a" data-x="1">One <b>two</b></p><button disabled onclick="alert(1)">Go</button><svg viewBox="0 0 1 1"><path d="M0 0"/></svg>')}</div>);
    expect(host.querySelector('p')!.outerHTML).toBe('<p class="a" data-x="1">One <b>two</b></p>');
    expect(host.querySelector('button')!.disabled).toBe(true);
    expect(host.querySelector('button')!.hasAttribute('onclick')).toBe(false);
    expect(host.querySelector('path')!.namespaceURI).toBe('http://www.w3.org/2000/svg');
  });

  it('keeps the nodes a redraw of the same HTML does not change, so a selection in them stays', () => {
    const host = document.createElement('div');

    mount(host, <div>{trusted('<p>One</p><p>Two</p>')}</div>);
    const second = host.querySelectorAll('p')[1]!;

    mount(host, <div>{trusted('<p>One, changed</p><p>Two</p>')}</div>);
    expect(host.querySelectorAll('p')[1]).toBe(second);
    expect(host.textContent).toBe('One, changedTwo');
    expect(trusted('')).toBeNull();
  });

  it('never turns one keyed node into another, so a focused control is replaced rather than changed under the focus', () => {
    const host = document.createElement('div');

    mount(host, <div>{trusted('<button data-key="stop">Stop</button>')}</div>);
    const stop = host.querySelector('button')!;

    mount(host, <div>{trusted('<button data-key="talk-here">Talk here</button>')}</div>);
    expect(stop.isConnected).toBe(false);
    expect(host.querySelector('button')!.textContent).toBe('Talk here');
  });

  /** How many strings `run` had `trusted` parse anew: each parse makes a template. */
  const parses = (run: () => void): number => {
    const create = vi.spyOn(document, 'createElement');

    try {
      run();
      return create.mock.calls.filter(([tag]) => tag === 'template').length;
    } finally {
      create.mockRestore();
    }
  };

  it('Trusted_RedrawOfAFourThousandItemConversation_ParsesNothingAgain', () => {
    // A 4000-item conversation's draw: a body and a meta line per reply, about 4050 strings, walked in the same order each draw.
    const strings = Array.from({ length: 4050 }, (_, i) => `<p>long ${i}</p>`);

    expect(parses(() => strings.forEach((one) => trusted(one)))).toBe(4050);
    expect(parses(() => strings.forEach((one) => trusted(one)))).toBe(0);
  });

  it('Trusted_StringUsedAgain_OutlivesStringsParsedBeforeItsLastUse', () => {
    trusted('<p>kept</p>');
    trusted('<p>first gone</p>');
    Array.from({ length: KEPT_ENTRIES - 2 }, (_, i) => trusted(`<p>filler ${i}</p>`));
    // Used again, it becomes the newest, so the next new string drops the oldest unused one instead.
    trusted('<p>kept</p>');
    trusted('<p>one more</p>');

    expect(parses(() => trusted('<p>kept</p>'))).toBe(0);
    expect(parses(() => trusted('<p>first gone</p>'))).toBe(1);
  });

  it('Trusted_HtmlLongerThanTheLongestKept_IsParsedEachTime', () => {
    const long = `<p>${'x'.repeat(KEPT_LONGEST)}</p>`;
    const short = '<p>short, kept</p>';

    expect(parses(() => trusted(long))).toBe(1);
    expect(parses(() => trusted(long))).toBe(1);
    trusted(short);
    expect(parses(() => trusted(short))).toBe(0);
  });
});
