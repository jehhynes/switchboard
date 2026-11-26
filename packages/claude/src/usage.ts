import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageWindow } from '@switchboard/conversation';
import type { Exec } from './exec.js';
import { claudeEnvironment, failureOf } from './exec.js';
import { claudeRouting } from './routing.js';

/** How long a plan usage read may take; one took 1.2 s (mechanics M172). */
export const USAGE_TIMEOUT_MS = 30_000;

/**
 * A short-lived Claude Code process that answers one SDK control request, `get_usage`, and ends (mechanics M172): stream-json in and out, no
 * prompt and so no model request, no saved session, no settings files and so no hooks or plugins, no MCP servers and no tools.
 */
export function usageArgs(): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    // Each variadic option is followed by another flag, so later values are not read as its arguments.
    '--setting-sources',
    '',
    '--tools',
    '',
    '--strict-mcp-config',
  ];
}

/** The control requests the process reads from stdin: `initialize`, then `get_usage` without the scan of local transcripts. */
export const USAGE_INPUT = [
  JSON.stringify({ type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } }),
  JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }),
  '',
].join('\n');

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const SHAPE = "Claude Code answered the usage request in a form Switchboard does not read; the request is experimental and may have changed.";

/** A window from `get_usage`'s `{utilization, resets_at}`, null for an absent one, or `SHAPE` for one in another form. */
function usageWindow(value: unknown, minutes: number, limit: string | null): UsageWindow | null | typeof SHAPE {
  if (value === null || value === undefined) {
    return null;
  }

  const resets = isObject(value) && typeof value['resets_at'] === 'string' ? Date.parse(value['resets_at']) : NaN;

  if (!isObject(value) || typeof value['utilization'] !== 'number' || (value['resets_at'] !== null && Number.isNaN(resets))) {
    return SHAPE;
  }

  return { minutes, limit, usedPercent: value['utilization'], resetsAt: Number.isNaN(resets) ? null : resets };
}

/**
 * The plan usage windows in the `get_usage` answer of a `usageArgs` run's stdout (mechanics M172): the 5-hour and weekly windows and each
 * model's weekly window, named by its model; else why not. Reads only `rate_limits`; the answer's account fields are never kept.
 */
export function parseUsage(stdout: string): { windows: UsageWindow[] } | { error: string } {
  for (const line of stdout.split('\n')) {
    let message: unknown;

    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    const response = isObject(message) && message['type'] === 'control_response' && isObject(message['response']) ? message['response'] : null;

    if (response === null || response['request_id'] !== 'usage') {
      continue;
    }

    if (response['subtype'] !== 'success') {
      return { error: `Claude Code refused the usage request: ${typeof response['error'] === 'string' ? response['error'] : 'no reason given'}.` };
    }

    const answer = isObject(response['response']) ? response['response'] : null;

    if (answer === null) {
      return { error: SHAPE };
    }

    if (answer['rate_limits_available'] === false) {
      return { error: 'Claude Code reports no plan usage for this sign-in, as for an API key.' };
    }

    const limits = answer['rate_limits'];
    const models = isObject(limits) ? (limits['model_scoped'] ?? []) : null;

    // Every window the answer names must read, so a changed form fails rather than shows part of the usage.
    if (!isObject(limits) || !Array.isArray(models) || models.some((model) => !isObject(model) || typeof model['display_name'] !== 'string')) {
      return { error: SHAPE };
    }

    const windows = [
      usageWindow(limits['five_hour'], 300, null),
      usageWindow(limits['seven_day'], 10_080, null),
      ...models.map((model) => usageWindow(model, 10_080, String(model['display_name']))),
    ];

    if (windows.includes(SHAPE) || windows.every((window) => window === null)) {
      return { error: SHAPE };
    }

    return { windows: windows.filter((window): window is UsageWindow => window !== null && window !== SHAPE) };
  }

  return { error: 'Claude Code did not answer the usage request; this version may not offer it.' };
}

/**
 * Asks Claude Code for the plan usage once (mechanics M172), in an empty temporary folder it removes after, with the routing variables of the
 * operator's settings as triage gets them. Claude Code makes the network call with its own sign-in.
 */
export async function readUsage(claudePath: string, settingsPath: string, exec: Exec, timeoutMs = USAGE_TIMEOUT_MS): Promise<{ windows: UsageWindow[] } | { error: string }> {
  const routing = claudeRouting(settingsPath);

  if ('error' in routing) {
    return routing;
  }

  const cwd = mkdtempSync(join(tmpdir(), 'switchboard-usage-'));

  try {
    const result = await exec(claudePath, usageArgs(), { cwd, stdin: USAGE_INPUT, timeoutMs, env: { ...routing.env, ...claudeEnvironment(claudePath) } });
    const parsed = parseUsage(result.stdout);

    return 'windows' in parsed || result.code === 0 ? parsed : { error: failureOf(claudePath, result, timeoutMs, { cwd }) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
