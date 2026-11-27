import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTEXT_TAIL_BYTES, TranscriptContext, contextOfLine, transcriptDetails } from '../src/context.js';
import { claudeContext, claudeModel, clockTime, codexContext, contextLevel, contextLines, renderContextMeter, timeAgo, tokens, windowName } from '../src/contextMeter.js';
import type { ContextDetails } from '../src/contextMeter.js';

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
    expect(contextLines(claudeContext(150_000, 'claude-sonnet-4-6'))).toEqual(['Context: 75% · 150k / 200k tokens', '10% left until auto-compact at about 167k.', 'Context is nearly full. Run /compact soon.']);
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
    expect(attr(html, 'title')).toBe('Context: 75% · 150k / 200k tokens\n10% left until auto-compact at about 167k.\nContext is nearly full. Run /compact soon.');
    expect(attr(html, 'aria-label')).toBe('Context: 75% · 150k / 200k tokens 10% left until auto-compact at about 167k. Context is nearly full. Run /compact soon.');
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
    expect([...open.matchAll(/<div class="context-line">([^<]*)<\/div>/g)].map((match) => match[1])).toEqual(['Context: 62% · 124k / 200k tokens', '26% left until auto-compact at about 167k.']);
    expect(actions(open)).toEqual(['toggle', 'details', 'compact']);
    expect(actions(renderContextMeter(view, 'confirm', true))).toEqual(['toggle', 'compact-confirm', 'cancel']);
    expect(actions(renderContextMeter(view, 'open', false))).toEqual(['toggle', 'details']);
  });

  describe('details', () => {
    const now = new Date(2026, 10, 26, 18, 0).getTime();
    const text = (html: string): string[] => [...html.matchAll(/<div class="context-(?:row(?: sub)?|line|heading|error)"[^>]*>(.*?)<\/div>/g)].map((match) => match[1]!.replace(/<\/span><span>/g, ': ').replace(/<[^>]+>/g, ''));
    const claude: ContextDetails = {
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
      parts: { cacheRead: 598_000, cacheWrite: 14_000, input: 2_000, output: 4_000, reasoning: null },
      compacted: { at: now - 2 * 3_600_000, trigger: 'auto' },
      windows: [
        { minutes: 300, limit: null, usedPercent: 79, resetsAt: new Date(2026, 10, 26, 21, 50).getTime() },
        { minutes: 10_080, limit: 'Fable', usedPercent: 0.4, resetsAt: new Date(2026, 10, 28, 3, 0).getTime() },
      ],
      limit: null,
    };

    it('offers Show details, says it is loading, shows a failure with Try again, and leaves Compact where it was', () => {
      const view = claudeContext(124_000, 'claude-sonnet-4-6');

      expect(renderContextMeter(view, 'open', true, { state: 'loading' }, now)).toContain('<div class="context-line" role="status">Loading details…</div>');
      expect(actions(renderContextMeter(view, 'open', true, { state: 'loading' }, now))).toEqual(['toggle', 'compact']);
      const failed = renderContextMeter(view, 'open', true, { state: 'failed', error: 'Claude Code did not answer <b>' }, now);

      expect(failed).toContain('<div class="context-error" role="alert">Claude Code did not answer &#60;b&#62;</div>');
      expect(failed).toContain('data-context="details">Try again</button>');
      expect(actions(renderContextMeter(view, 'open', true, { state: 'shown', details: claude }, now))).toEqual(['toggle', 'compact']);
      // Closed, the meter is the ring alone whatever the details hold.
      expect(renderContextMeter(view, 'closed', true, { state: 'shown', details: claude }, now)).not.toContain('context-details');
    });

    it("shows a Claude session's last request by kind, its model, effort and last compaction, and its plan usage windows", () => {
      expect(text(renderContextMeter(null, 'open', false, { state: 'shown', details: claude }, now)).slice(1)).toEqual([
        'Last request',
        'Cache read: 598k',
        'Cache write: 14k',
        'Input: 2k',
        'Output: 4k',
        'Model: claude-opus-5-5',
        'Effort: medium',
        'Last compacted: by itself, 2 h ago',
        'Usage limit',
        '5-hour: 79%',
        'Resets: 9:50 PM',
        'Weekly (Fable): 0%',
        'Resets: Sat, Nov 28, 3:00 AM',
      ]);
      // A window with no reset time has no Resets row.
      expect(text(renderContextMeter(null, 'open', false, { state: 'shown', details: { ...claude, windows: [{ minutes: 300, limit: null, usedPercent: 79, resetsAt: null }] } }, now)).slice(-2)).toEqual(['Usage limit', '5-hour: 79%']);
    });

    it("leaves out each row without data, says a Codex thread's usage has not come yet, and shows the limit the session is stopped at", () => {
      const codex: ContextDetails = { provider: 'codex', model: null, effort: null, parts: { cacheRead: 50_000, cacheWrite: null, input: 10_000, output: 2_000, reasoning: 500 }, compacted: null, windows: [], limit: null };

      expect(text(renderContextMeter(null, 'open', false, { state: 'shown', details: codex }, now)).slice(1)).toEqual([
        'Last request',
        'Cache read: 50k',
        'Input: 10k',
        'Output: 2k',
        'Reasoning, in output: 500',
        'Usage limit',
        'Codex sends its plan usage during a turn; none has come since Switchboard started.',
      ]);
      const stopped = { ...codex, parts: null, limit: { kind: 'usage' as const, resetsAt: new Date(2026, 10, 26, 16, 20).getTime() } };

      expect(text(renderContextMeter(null, 'open', false, { state: 'shown', details: stopped }, now)).slice(1)).toEqual(['Usage limit', 'Usage limit reached · resets 4:20 PM']);
      expect(text(renderContextMeter(null, 'open', false, { state: 'shown', details: { ...stopped, limit: { kind: 'throttle', resetsAt: null } } }, now)).at(-1)).toBe('Rate limited · reset time unknown');
      expect(text(renderContextMeter(null, 'open', false, { state: 'shown', details: { ...claude, windows: null, compacted: { at: now, trigger: null } } }, now)).slice(-3)).toEqual([
        'Last compacted: just now',
        'Usage limit',
        'Claude reports plan usage only at a limit; this session is not at one.',
      ]);
    });

    it('names a window by its length, and says a time and an age briefly', () => {
      expect([300, 60, 10_080, 2_880, 90, null, 0].map((minutes) => windowName({ minutes, limit: null, usedPercent: 0, resetsAt: null }))).toEqual(['5-hour', '1-hour', 'Weekly', '2-day', '90-minute', 'Usage', 'Usage']);
      expect(clockTime(new Date(2026, 10, 26, 9, 5).getTime(), now)).toBe('9:05 AM');
      expect(clockTime(new Date(2026, 10, 27, 9, 5).getTime(), now)).toBe('Fri, Nov 27, 9:05 AM');
      expect([30_000, 12 * 60_000, 47 * 3_600_000, 49 * 3_600_000].map((ago) => timeAgo(now - ago, now))).toEqual(['just now', '12 min ago', '1 d ago', '2 d ago']);
    });
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

  it("reads the details from the transcript's end: the latest request's model, effort and tokens, and the latest compaction", () => {
    const fixture = new URL('./fixtures/transcripts/context-details.jsonl', import.meta.url);

    // The latest main-chain request has no effort, so none shows; a subagent's and an API error's lines are left out.
    expect(transcriptDetails(fileURLToPath(fixture))).toEqual({
      model: 'claude-opus-5-5',
      effort: null,
      parts: { cacheRead: 6_000, cacheWrite: 1_500, input: 2, output: 300, reasoning: null },
      compacted: { at: Date.parse('2026-11-26T18:10:00.000Z'), trigger: 'manual' },
    });
    const path = join(dir, 'a.jsonl');

    writeFileSync(path, assistant(1_000, { effort: 'max' }) + '\n' + JSON.stringify({ type: 'user', message: { content: 'x'.repeat(CONTEXT_TAIL_BYTES) } }) + '\n' + assistant(2_000, { effort: 'low' }) + '\n');
    // A compaction or effort before the end it reads is not there.
    expect(transcriptDetails(path)).toMatchObject({ effort: 'low', compacted: null, parts: { cacheRead: 2_000 } });
    expect(transcriptDetails(join(dir, 'missing.jsonl'))).toEqual({ model: null, effort: null, parts: null, compacted: null });
    expect(transcriptDetails(null)).toEqual({ model: null, effort: null, parts: null, compacted: null });
  });

  it('reads no line that is not a request or a compaction', () => {
    expect(contextOfLine(JSON.stringify({ type: 'user', message: { content: 'usage' } }))).toBeNull();
    expect(contextOfLine('{"usage": ')).toBeNull();
    expect(contextOfLine(JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: {} } }))).toBeNull();
  });
});
