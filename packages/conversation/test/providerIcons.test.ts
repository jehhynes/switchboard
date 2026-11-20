import { describe, expect, it } from 'vitest';
import { providerMark } from '../src/providerIcons.js';

describe('the provider marks', () => {
  it("draws Claude's and Codex's own marks in the text colour, named for screen readers and tooltips", () => {
    const claude = providerMark('claude');
    const codex = providerMark('codex');

    expect(claude).toMatch(/^<span class="provider" role="img" title="Claude" aria-label="Claude"><svg viewBox="0 0 24 24"[^>]*aria-hidden="true"[^>]*><path fill="currentColor" d="M4\.709 /);
    expect(codex).toMatch(/^<span class="provider" role="img" title="Codex" aria-label="Codex"><svg [^>]*><path fill="currentColor" d="M13\.798 /);
    expect(claude).not.toContain('#D97757');
    expect(codex).not.toContain('white');
  });

  it('falls back to the name as text for a provider with no mark, and to nothing for none', () => {
    expect(providerMark('gemini<x>')).toBe('<span class="provider" title="Session provider">gemini&#60;x&#62;</span>');
    expect(providerMark(undefined)).toBe('');
    expect(providerMark(null)).toBe('');
    expect(providerMark('')).toBe('');
  });
});
