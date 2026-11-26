import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult } from '../src/exec.js';
import { parseUsage, readUsage, USAGE_INPUT, usageArgs } from '../src/usage.js';

// A get_usage answer as Claude Code 2.1.332 gave it (mechanics M172), with its values changed and no account fields.
const recorded = readFileSync(new URL('./fixtures/get-usage.jsonl', import.meta.url), 'utf8');
const answer = (response: unknown): string => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'usage', response } });

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseUsage', () => {
  it('ParseUsage_RecordedAnswer_ReadsFiveHourWeeklyAndEachModelsWeeklyWindow', () => {
    expect(parseUsage(recorded)).toEqual({
      windows: [
        { minutes: 300, limit: null, usedPercent: 42, resetsAt: Date.parse('2026-11-27T02:50:00.590Z') },
        { minutes: 10_080, limit: null, usedPercent: 63, resetsAt: Date.parse('2026-11-28T08:00:00.590Z') },
        { minutes: 10_080, limit: 'Fable', usedPercent: 5, resetsAt: Date.parse('2026-11-28T08:00:00.000Z') },
      ],
    });
  });

  it('ParseUsage_NoPlanUsageRefusalOrOtherShape_SaysWhy', () => {
    expect(parseUsage(answer({ rate_limits_available: false, rate_limits: null }))).toEqual({ error: 'Claude Code reports no plan usage for this sign-in, as for an API key.' });
    expect(parseUsage(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'usage', error: 'Unsupported control request subtype: get_usage' } }))).toEqual({
      error: 'Claude Code refused the usage request: Unsupported control request subtype: get_usage.',
    });
    const shape = "Claude Code answered the usage request in a form Switchboard does not read; the request is experimental and may have changed.";
    expect(parseUsage(answer({ rate_limits: { five_hour: { percent: 10 } } }))).toEqual({ error: shape });
    expect(parseUsage(answer({ rate_limits: [] }))).toEqual({ error: shape });
    // A window in another form fails the whole answer, even beside one that reads; a missing rate_limits is no "unavailable".
    const five = { utilization: 10, resets_at: '2026-11-27T02:50:00Z' };
    expect(parseUsage(answer({ rate_limits: { five_hour: five, seven_day: { used: 63 } } }))).toEqual({ error: shape });
    expect(parseUsage(answer({ rate_limits: { five_hour: five, seven_day: { utilization: 63, resets_at: 'soon' } } }))).toEqual({ error: shape });
    expect(parseUsage(answer({ rate_limits: { five_hour: five, model_scoped: [{ name: 'Fable', utilization: 1 }] } }))).toEqual({ error: shape });
    expect(parseUsage(answer({ rate_limits: { five_hour: five, model_scoped: {} } }))).toEqual({ error: shape });
    expect(parseUsage(answer({ rate_limits_available: true }))).toEqual({ error: shape });
    expect(parseUsage(answer({ rate_limits: { five_hour: null, seven_day: null } }))).toEqual({ error: shape });
    // An absent window, or a reset not known yet, is no change of form.
    expect(parseUsage(answer({ rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: null } }))).toEqual({ windows: [{ minutes: 300, limit: null, usedPercent: 0, resetsAt: null }] });
    expect(parseUsage(answer('text'))).toEqual({ error: shape });
    // Only the usage request's answer counts; without it the version may not offer the request.
    expect(parseUsage(recorded.split('\n')[0]! + '\nnot json\n')).toEqual({ error: 'Claude Code did not answer the usage request; this version may not offer it.' });
  });
});

describe('readUsage', () => {
  it('ReadUsage_FakeClaude_RunsIsolatedInAnEmptyFolderItRemoves', async () => {
    const settings = join(dir, 'settings.json');
    const runs: Array<{ file: string; args: string[]; options: ExecOptions; inside: string[] }> = [];

    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example', MODEL: 'kept out' }, hooks: { SessionStart: [] } }));
    const exec = async (file: string, args: string[], options: ExecOptions): Promise<ExecResult> => {
      runs.push({ file, args, options, inside: readdirSync(options.cwd!) });
      return { code: 0, stdout: recorded, stderr: '', missing: false, timedOut: false };
    };

    expect(await readUsage('C:/tools/claude.exe', settings, exec)).toMatchObject({ windows: [{ minutes: 300, usedPercent: 42 }, { minutes: 10_080 }, { limit: 'Fable' }] });
    const run = runs[0]!;

    expect(run.file).toBe('C:/tools/claude.exe');
    expect(run.args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--tools', '', '--strict-mcp-config']);
    expect(usageArgs()).not.toContain('--resume');
    expect(run.options.stdin).toBe(USAGE_INPUT);
    expect(USAGE_INPUT.trim().split('\n').map((line) => JSON.parse(line).request)).toEqual([{ subtype: 'initialize' }, { subtype: 'get_usage', skip_behaviors: true }]);
    expect(run.options.timeoutMs).toBe(30_000);
    expect(run.options.env).toMatchObject({ ANTHROPIC_BASE_URL: 'https://gateway.example' });
    expect(run.options.env).not.toHaveProperty('MODEL');
    expect(run.options.cwd).toContain('switchboard-usage-');
    expect(run.inside).toEqual([]);
    expect(existsSync(run.options.cwd!)).toBe(false);
  });

  it('ReadUsage_FailedOrTimedOutRun_GivesTheFailureAndStillRemovesTheFolder', async () => {
    const cwds: string[] = [];
    const failing = (result: Partial<ExecResult>) => async (_file: string, _args: string[], options: ExecOptions): Promise<ExecResult> => {
      cwds.push(options.cwd!);
      return { code: 1, stdout: '', stderr: '', missing: false, timedOut: false, ...result };
    };
    const settings = join(dir, 'none.json');

    expect(await readUsage('claude', settings, failing({ stderr: 'Not logged in.' }))).toEqual({ error: 'Not logged in.' });
    expect(await readUsage('claude', settings, failing({ code: null, timedOut: true }), 5_000)).toEqual({ error: 'claude did not finish within 5 seconds.' });
    expect(await readUsage('claude', settings, failing({ code: 0, stdout: '' }))).toEqual({ error: 'Claude Code did not answer the usage request; this version may not offer it.' });
    expect(cwds.every((cwd) => !existsSync(cwd))).toBe(true);
    // Unreadable settings stop the run, as they stop triage, so it never bypasses the operator's endpoint.
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(await readUsage('claude', join(dir, 'bad.json'), failing({}))).toEqual({ error: `Claude's settings at ${join(dir, 'bad.json')} are not valid JSON.` });
    expect(cwds).toHaveLength(3);
  });
});
