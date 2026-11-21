import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTEXT_TAIL_BYTES, TranscriptContext, contextOfLine } from '../src/context.js';
import { claudeContext, claudeModel, codexContext, contextLevel, contextLines, renderContextMeter, tokens } from '../src/contextMeter.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'context-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const assistant = (read: number, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5') =>
  JSON.stringify({ type: 'assistant', ...extra, message: { model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 2, cache_creation_input_tokens: 300, cache_read_input_tokens: read, output_tokens: 40 } } });

describe('claudeModel', () => {
  it("knows Claude Code's windows by canonical ID, through dates, provider prefixes and the [1m] suffix, and no other model", () => {
    expect(claudeModel('claude-opus-5-5')).toEqual({ window: 1_000_000, maxOutput: 128_000, long: 1_000_000 });
    expect(claudeModel('claude-sonnet-4-5-20250929')?.window).toBe(200_000);
    expect(claudeModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')?.window).toBe(200_000);
    expect(claudeModel('claude-sonnet-4-6[1m]')?.window).toBe(1_000_000);
    // The suffix does not lengthen a model with no long window.
    expect(claudeModel('claude-opus-4-1[1m]')?.window).toBe(200_000);
    expect(claudeModel('gpt-5')).toBeNull();
    expect(claudeModel('opus')).toBeNull();
    expect(claudeModel(null)).toBeNull();
  });
});

describe('claudeContext', () => {
  it("puts the auto-compact threshold where Claude Code's panel does: the window less up to 20,000 reserved output and 13,000", () => {
    expect(claudeContext(124_000, 'claude-sonnet-4-6')).toEqual({ used: 124_000, window: 200_000, compactAt: 167_000, model: 'claude-sonnet-4-6' });
    // Observed: a claude-opus-5-5 session compacted by itself at 966,902 and 969,719 tokens (mechanics M105).
    expect(claudeContext(500_000, 'claude-opus-5-5').compactAt).toBe(967_000);
    expect(claudeContext(10_000, 'claude-3-5-haiku').compactAt).toBe(167_000);
    // A threshold the session compacted at by itself replaces the default only below it.
    expect(claudeContext(10_000, 'claude-opus-5-5', 300_000).compactAt).toBe(300_000);
    expect(claudeContext(10_000, 'claude-sonnet-4-6', 190_000).compactAt).toBe(167_000);
  });

  it('reads a size past the standard window as the long window, and an unknown model as an unknown window', () => {
    expect(claudeContext(250_000, 'claude-sonnet-4-6')).toMatchObject({ window: 1_000_000, compactAt: 967_000 });
    // A model with no long window keeps its own, full past it.
    expect(claudeContext(250_000, 'claude-opus-4-1')).toMatchObject({ window: 200_000 });
    expect(claudeContext(5_000, 'claude-next-9')).toEqual({ used: 5_000, window: null, compactAt: null, model: 'claude-next-9' });
  });
});

describe('contextLevel and contextLines', () => {
  it('fills toward the auto-compact threshold, warning from 80% of it and full from 95%', () => {
    expect(contextLevel(claudeContext(100_000, 'claude-sonnet-4-6'))).toBe('ok');
    expect(contextLevel(claudeContext(133_600, 'claude-sonnet-4-6'))).toBe('warn');
    expect(contextLevel(claudeContext(158_650, 'claude-sonnet-4-6'))).toBe('full');
    // Codex gives no threshold, so the window counts.
    expect(contextLevel(codexContext(200_000, 258_400))).toBe('ok');
    expect(contextLevel(codexContext(210_000, 258_400))).toBe('warn');
    expect(contextLevel(codexContext(210_000, null))).toBe('unknown');
    expect(contextLevel(null)).toBe('unknown');
  });

  it('says the size against the window, what is left until auto-compact, and to compact once it warns', () => {
    expect(contextLines(claudeContext(124_000, 'claude-sonnet-4-6'))).toEqual(['Context: 62% · 124k / 200k tokens', '26% left until auto-compact at about 167k.']);
    expect(contextLines(claudeContext(150_000, 'claude-sonnet-4-6'))).toEqual(['Context: 75% · 150k / 200k tokens', '10% left until auto-compact at about 167k.', 'Consider compacting the conversation soon.']);
    expect(contextLines(codexContext(62_000, 258_400))).toEqual(['Context: 24% · 62k / 258k tokens']);
    expect(contextLines(claudeContext(5_000, 'claude-next-9'))).toEqual(['Context: 5k tokens; the context window of claude-next-9 is unknown.']);
    expect(contextLines(null)).toEqual(["Context size unknown: it shows after the session's next reply."]);
    expect([tokens(950), tokens(1_499), tokens(967_000), tokens(1_000_000), tokens(1_250_000)]).toEqual(['950', '1k', '967k', '1M', '1.3M']);
  });
});

describe('renderContextMeter', () => {
  const attr = (html: string, name: string): string | null => new RegExp(`<button[^>]*\\s${name}="([^"]*)"`).exec(html)?.[1] ?? null;
  const actions = (html: string): string[] => [...html.matchAll(/data-context="([^"]+)"/g)].map((match) => match[1]!);

  it('draws only the ring, its details in its tooltip and accessible name, its arc as long as the fill and its level as a class', () => {
    const html = renderContextMeter(claudeContext(150_000, 'claude-sonnet-4-6'));

    expect(html).toMatch(/^<button[^>]*><svg[^>]*>.*<\/svg><\/button>$/);
    expect(html.replace(/<[^>]*>/g, '')).toBe('');
    expect(attr(html, 'class')).toBe('composer-tool context-ring warn');
    expect(attr(html, 'title')).toBe('Context: 75% · 150k / 200k tokens\n10% left until auto-compact at about 167k.\nConsider compacting the conversation soon.');
    expect(attr(html, 'aria-label')).toBe('Context: 75% · 150k / 200k tokens 10% left until auto-compact at about 167k. Consider compacting the conversation soon.');
    expect(attr(html, 'aria-expanded')).toBe('false');
    expect(Number(/class="context-arc"[^>]*stroke-dasharray="([\d.]+) /.exec(html)![1])).toBeCloseTo(2 * Math.PI * 6 * (150_000 / 167_000), 1);
  });

  it('draws an unknown size as the track alone', () => {
    const html = renderContextMeter(null);

    expect(attr(html, 'class')).toBe('composer-tool context-ring unknown');
    expect(html).not.toContain('context-arc');
    expect(html).toContain('context-track');
  });

  it('opens a menu with the details and Compact, which asks to confirm, and offers no Compact to a session the composer cannot talk to', () => {
    const view = claudeContext(124_000, 'claude-sonnet-4-6');
    const open = renderContextMeter(view, 'open', true);

    expect(attr(open, 'aria-expanded')).toBe('true');
    expect([...open.matchAll(/<div class="context-line">([^<]*)<\/div>/g)].map((match) => match[1])).toEqual(contextLines(view));
    expect(actions(open)).toEqual(['toggle', 'compact']);
    expect(actions(renderContextMeter(view, 'confirm', true))).toEqual(['toggle', 'compact-confirm', 'cancel']);
    expect(actions(renderContextMeter(view, 'open', false))).toEqual(['toggle']);
  });

  it('escapes a model name in its details', () => {
    expect(renderContextMeter(claudeContext(1, '<img src=x>'))).not.toContain('<img');
  });
});

describe('TranscriptContext', () => {
  it("reads the latest main-chain request's size, leaving out a subagent's, a made-up line and an error, and follows compactions", () => {
    const path = join(dir, 'a.jsonl');
    const reader = new TranscriptContext();

    expect(reader.read(path)).toBeNull();
    writeFileSync(path, [assistant(100_000), assistant(400_000, { isSidechain: true }), assistant(400_000, {}, '<synthetic>'), assistant(400_000, { isApiErrorMessage: true }), ''].join('\n'));
    expect(reader.read(path)).toEqual({ used: 100_342, window: 1_000_000, compactAt: 967_000, model: 'claude-opus-5-5' });
    // A line still being written waits for its newline.
    appendFileSync(path, assistant(200_000).slice(0, 40));
    expect(reader.read(path)?.used).toBe(100_342);
    appendFileSync(path, assistant(200_000).slice(40) + '\n');
    expect(reader.read(path)?.used).toBe(200_342);
    appendFileSync(path, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 200_342, postTokens: 30_000 } }) + '\n');
    expect(reader.read(path)).toMatchObject({ used: 30_000, model: 'claude-opus-5-5' });
    // An automatic compaction's size is the session's own threshold from then on, below the default.
    appendFileSync(path, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 300_000, postTokens: 25_000 } }) + '\n');
    expect(reader.read(path)).toEqual({ used: 25_000, window: 1_000_000, compactAt: 300_000, model: 'claude-opus-5-5' });
    // A boundary without the size after it leaves the size unknown until the next request.
    appendFileSync(path, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } }) + '\n');
    expect(reader.read(path)).toBeNull();
  });

  it('starts unknown on a new transcript file, and reads a long one from its end', () => {
    const first = join(dir, 'a.jsonl');
    const second = join(dir, 'b.jsonl');
    const reader = new TranscriptContext();

    writeFileSync(first, assistant(5_000) + '\n' + JSON.stringify({ type: 'user', message: { content: 'x'.repeat(CONTEXT_TAIL_BYTES) } }) + '\n');
    // The request lies before the end it reads.
    expect(reader.read(first)).toBeNull();
    writeFileSync(second, 'not json\n' + assistant(7_000) + '\n');
    expect(reader.read(second)?.used).toBe(7_342);
    expect(reader.read(null)).toBeNull();
  });

  it('reads no line that is not a request or a compaction', () => {
    expect(contextOfLine(JSON.stringify({ type: 'user', message: { content: 'usage' } }))).toBeNull();
    expect(contextOfLine('{"usage": ')).toBeNull();
    expect(contextOfLine(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: {} } }))).toBeNull();
  });
});
