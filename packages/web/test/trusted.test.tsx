import { describe, expect, it } from 'vitest';
import { mount } from '../src/island.js';
import { trusted } from '../src/trusted.js';

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
});
