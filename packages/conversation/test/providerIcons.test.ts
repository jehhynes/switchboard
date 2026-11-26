import { describe, expect, it } from 'vitest';
import { providerMark } from '../src/providerIcons.js';

describe('the provider marks', () => {
  it("draws Claude's and Codex's own marks in the text colour, named for screen readers and tooltips", () => {
    const claude = providerMark('claude');
    const codex = providerMark('codex');

    // Each mark is one image named by its provider, its drawing hidden from screen readers and filled with the text colour alone.
    const read = (markup: string) => ({
      span: /^<span ([^>]*)>/.exec(markup)?.[1],
      svg: /<svg ([^>]*)>/.exec(markup)?.[1],
      fills: [...markup.matchAll(/fill="([^"]*)"/g)].map((match) => match[1]),
      path: /<path [^>]*d="([^"]+)"/.exec(markup)?.[1],
    });
    const attrs = (text: string | undefined) => Object.fromEntries([...(text ?? '').matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));

    for (const [markup, name] of [[claude, 'Claude'], [codex, 'Codex']] as const) {
      const mark = read(markup);

      expect(attrs(mark.span)).toEqual({ class: 'provider', role: 'img', title: name, 'aria-label': name });
      expect(attrs(mark.svg)['aria-hidden']).toBe('true');
      expect(mark.fills).toEqual(['currentColor']);
      expect(mark.path!.length).toBeGreaterThan(50);
      expect(markup.endsWith('</svg></span>')).toBe(true);
    }

    // Two marks, not one drawn twice.
    expect(read(claude).path).not.toBe(read(codex).path);
  });

  it('falls back to the name as text for a provider with no mark, and to nothing for none', () => {
    expect(providerMark('gemini<x>')).toBe('<span class="provider" title="Session provider">gemini&#60;x&#62;</span>');
    expect(providerMark(undefined)).toBe('');
    expect(providerMark(null)).toBe('');
    expect(providerMark('')).toBe('');
  });
});
