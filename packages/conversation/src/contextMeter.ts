/**
 * The composer's context meter (architecture.md § Context meter), drawn by the web page: a small ring that
 * fills with the share of the session's context in use, toward its auto-compact threshold, with the numbers in its tooltip and a Compact action
 * in its menu. Also the hub's reading of a context size against the model's window. Imports nothing, for browser bundles.
 */

/**
 * A session's context size as the hub reads it (architecture.md § Context meter): `used` tokens in its latest request; `window` the model's
 * context window and `compactAt` the size at which it compacts by itself, each null when not known; `model` the model that answered, null when
 * not known.
 */
export interface ContextView {
  used: number;
  window: number | null;
  compactAt: number | null;
  model: string | null;
}

/** The latest request's tokens by kind (architecture.md § Context meter); together they make its size. Codex reports no cache write. */
export interface ContextParts {
  cacheRead: number;
  cacheWrite: number | null;
  input: number;
  output: number;
  /** Codex's reasoning tokens, part of `output`; null for Claude. */
  reasoning: number | null;
}

/** A plan usage window: its length in minutes, null when not reported, the limit it belongs to when not the default, the share used and its reset. */
export interface UsageWindow {
  minutes: number | null;
  limit: string | null;
  usedPercent: number;
  resetsAt: number | null;
}

/**
 * The context meter's details, which the page asks for on demand (`context-details`, architecture.md § Context meter): the model and effort,
 * the latest request's tokens by kind, the last compaction the hub knows of, the plan usage windows, and the limit the session is stopped at.
 * `windows` is null where Switchboard reads no plan usage, as for Claude, and empty for Codex until its first update after the hub started.
 */
export interface ContextDetails {
  provider: 'claude' | 'codex';
  model: string | null;
  effort: string | null;
  parts: ContextParts | null;
  compacted: { at: number; trigger: 'auto' | 'manual' | null } | null;
  windows: UsageWindow[] | null;
  limit: { kind: 'usage' | 'throttle'; resetsAt: number | null } | null;
}

/** The details' state in the menu, which each front end keeps: not asked for, being read, shown, or failed with the reason. */
export type ContextDetailsState = { state: 'none' } | { state: 'loading' } | { state: 'shown'; details: ContextDetails } | { state: 'failed'; error: string };

/** A Claude model's context window and the output it reserves, as Claude Code's model table gives them (mechanics M105). */
interface ClaudeModel {
  window: number;
  maxOutput: number;
  /** The window with the `[1m]` suffix or the 1M beta, where larger than `window`. */
  long: number;
}

const K200 = 200_000;
const M1 = 1_000_000;
const CLAUDE_MODELS: Record<string, ClaudeModel> = {
  'claude-3-5-haiku': { window: K200, maxOutput: 32_000, long: K200 },
  'claude-3-7-sonnet': { window: K200, maxOutput: 32_000, long: M1 },
  'claude-haiku-4-5': { window: K200, maxOutput: 32_000, long: K200 },
  'claude-sonnet-4': { window: K200, maxOutput: 32_000, long: M1 },
  'claude-sonnet-4-0': { window: K200, maxOutput: 32_000, long: M1 },
  'claude-sonnet-4-5': { window: K200, maxOutput: 32_000, long: M1 },
  'claude-sonnet-4-6': { window: K200, maxOutput: 32_000, long: M1 },
  'claude-opus-4': { window: K200, maxOutput: 32_000, long: K200 },
  'claude-opus-4-0': { window: K200, maxOutput: 32_000, long: K200 },
  'claude-opus-4-1': { window: K200, maxOutput: 32_000, long: K200 },
  'claude-opus-4-5': { window: K200, maxOutput: 32_000, long: K200 },
  'claude-opus-4-6': { window: K200, maxOutput: 64_000, long: M1 },
  'claude-opus-4-7': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-opus-4-8': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-opus-5': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-opus-5-5': { window: M1, maxOutput: 128_000, long: M1 },
  'claude-sonnet-5': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-sonnet-5-5': { window: M1, maxOutput: 128_000, long: M1 },
  'claude-haiku-5-5': { window: M1, maxOutput: 128_000, long: M1 },
  'claude-fable-5': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-fable-5-1': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-fable-5-2': { window: M1, maxOutput: 128_000, long: M1 },
  'claude-mythos-5': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-mythos-5-1': { window: M1, maxOutput: 64_000, long: M1 },
  'claude-mythos-5-2': { window: M1, maxOutput: 128_000, long: M1 },
};

/** Claude Code compacts by itself this far below the window: the output it reserves, at most 20,000 tokens, and a 13,000-token margin. */
const RESERVED_OUTPUT = 20_000;
const COMPACT_MARGIN = 13_000;

/** The share of the window, or of the auto-compact threshold, from which the ring turns to the warning colour and the menu advises compacting. */
export const CONTEXT_WARN = 0.8;
/** The share from which the ring turns to the error colour. */
export const CONTEXT_FULL = 0.95;

/**
 * A Claude model's entry: its ID without a provider prefix (`anthropic.`, `us.anthropic.`), a date suffix or a `[1m]` suffix; with the suffix,
 * its long window. Null for a model Switchboard does not know.
 */
export function claudeModel(model: string | null | undefined): ClaudeModel | null {
  if (typeof model !== 'string') {
    return null;
  }

  const long = /\[1m\]\s*$/i.test(model);
  const id = model.trim().toLowerCase().replace(/\[1m\]$/, '').replace(/^(?:[a-z]{2}\.)?anthropic\./, '').replace(/[-@]\d{8}(?:-v\d+(?::\d+)?)?$/, '').replace(/-v\d+(?::\d+)?$/, '');
  const known = CLAUDE_MODELS[id];

  return known === undefined ? null : long ? { ...known, window: known.long } : known;
}

/**
 * A Claude session's context: `used` tokens of its latest request against its model's window, which a size past the standard window shows is the
 * long one, and its auto-compact threshold: `autoAt`, the size the session last compacted at by itself, where its transcript has one, since
 * settings Switchboard does not read can move it, else the one Claude Code's own panel uses, the window less the reserved output and the margin.
 */
export function claudeContext(used: number, model: string | null, autoAt: number | null = null): ContextView {
  const known = claudeModel(model);

  if (known === null) {
    return { used, window: null, compactAt: autoAt, model };
  }

  const window = used > known.window ? Math.max(known.window, known.long) : known.window;

  const standard = window - Math.min(known.maxOutput, RESERVED_OUTPUT) - COMPACT_MARGIN;

  return { used, window, compactAt: autoAt !== null && autoAt < standard ? autoAt : standard, model };
}

/** A Codex thread's context: the tokens of its latest request against the window Codex reports; Codex does not say when it compacts. */
export function codexContext(used: number, window: number | null, model: string | null = null): ContextView {
  return { used, window: window !== null && window > 0 ? window : null, compactAt: null, model };
}

/** How full the context is, 0 to 1, toward the auto-compact threshold where known, else the window; null with neither. */
export function contextFill(view: ContextView): number | null {
  const limit = view.compactAt ?? view.window;

  return limit === null || limit <= 0 ? null : Math.min(1, Math.max(0, view.used / limit));
}

/** `warn` from `CONTEXT_WARN` and `full` from `CONTEXT_FULL` of the fill; `unknown` without a reading or a window. */
export function contextLevel(view: ContextView | null | undefined): 'unknown' | 'ok' | 'warn' | 'full' {
  const fill = view == null ? null : contextFill(view);

  return fill === null ? 'unknown' : fill >= CONTEXT_FULL ? 'full' : fill >= CONTEXT_WARN ? 'warn' : 'ok';
}

/** A token count as the meter shows it: 950, 12k, 124k, 1.2M, 1M. */
export function tokens(count: number): string {
  if (count < 1_000) {
    return String(Math.round(count));
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1_000)}k`;
  }

  return `${Number((count / 1_000_000).toFixed(1))}M`;
}

/**
 * The meter's details, one line each: the size against the window, how much is left until auto-compact, and the advice to compact once the
 * context is `warn` full or more; for a size it cannot read, why.
 */
export function contextLines(view: ContextView | null | undefined): string[] {
  if (view == null) {
    return ['Context size unknown: it shows after the session\'s next reply.'];
  }

  if (view.window === null) {
    return [`Context: ${tokens(view.used)} tokens; the context window of ${view.model ?? 'this model'} is unknown.`];
  }

  const lines = [`Context: ${Math.round((view.used / view.window) * 100)}% · ${tokens(view.used)} / ${tokens(view.window)} tokens`];

  if (view.compactAt !== null) {
    const left = Math.max(0, Math.round((1 - view.used / view.compactAt) * 100));

    lines.push(`${left}% left until auto-compact at about ${tokens(view.compactAt)}.`);
  }

  if (contextLevel(view) === 'warn' || contextLevel(view) === 'full') {
    lines.push('Context is nearly full. Run /compact soon.');
  }

  return lines;
}

const escape = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** The ring's circumference: a circle of radius 6 in a 16 by 16 box. */
const RING = 2 * Math.PI * 6;

/** The menu's state, which each front end keeps: closed, open, or open asking to confirm Compact. */
export type ContextMenuState = 'closed' | 'open' | 'confirm';

/** A usage window's name by its length, as Codex's own panel names them: 5-hour, Weekly, else hours or days; with its limit when not the default. */
export function windowName(window: UsageWindow): string {
  const minutes = window.minutes;
  const length =
    minutes === null || minutes <= 0
      ? 'Usage'
      : minutes === 10_080
        ? 'Weekly'
        : minutes % 1_440 === 0
          ? `${minutes / 1_440}-day`
          : minutes % 60 === 0
            ? `${minutes / 60}-hour`
            : `${minutes}-minute`;

  return window.limit === null ? length : `${length} (${window.limit})`;
}

/** A time as the details show it: `4:20 PM` today, else with its weekday, `Fri 8:00 AM`. */
export function clockTime(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

/** How long ago a time was: `just now`, `12 min ago`, `2 h ago`, `3 d ago`. */
export function timeAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 2_880 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1_440)} d ago`;
}

const row = (name: string, value: string, sub = false): string =>
  `<div class="context-row${sub ? ' sub' : ''}"><span>${escape(name)}</span><span>${escape(value)}</span></div>`;

/** The details' rows (architecture.md § Context meter): each row left out when its data is missing. */
function detailsHtml(details: ContextDetails, now: number): string {
  const parts = details.parts;
  const request =
    parts === null
      ? ''
      : [
          '<div class="context-row">Last request</div>',
          row('Cache read', tokens(parts.cacheRead), true),
          ...(parts.cacheWrite === null ? [] : [row('Cache write', tokens(parts.cacheWrite), true)]),
          row('Input', tokens(parts.input), true),
          row('Output', tokens(parts.output), true),
          ...(parts.reasoning === null ? [] : [row('Reasoning, in output', tokens(parts.reasoning), true)]),
        ].join('');
  const compacted = details.compacted;
  const how = compacted?.trigger === 'auto' ? 'by itself, ' : compacted?.trigger === 'manual' ? 'on request, ' : '';
  const facts = [
    ...(details.model === null ? [] : [row('Model', details.model)]),
    ...(details.effort === null ? [] : [row('Effort', details.effort)]),
    ...(compacted === null ? [] : [row('Last compacted', `${how}${timeAgo(compacted.at, now)}`)]),
  ].join('');
  const limit = details.limit;
  const stopped =
    limit === null
      ? ''
      : `<div class="context-line">${limit.kind === 'throttle' ? 'Rate limited' : 'Usage limit reached'} · ${limit.resetsAt === null ? 'reset time unknown' : `resets ${escape(clockTime(limit.resetsAt, now))}`}</div>`;
  const windows = (details.windows ?? []).map((window) =>
    row(windowName(window), `${Math.round(window.usedPercent)}%${window.resetsAt === null ? '' : ` · resets ${clockTime(window.resetsAt, now)}`}`),
  );
  const note =
    windows.length > 0 || limit !== null
      ? ''
      : details.windows === null
        ? '<div class="context-line">Claude reports plan usage only at a limit; this session is not at one.</div>'
        : '<div class="context-line">Codex sends its plan usage during a turn; none has come since Switchboard started.</div>';

  return `<div class="context-details">${request}${facts}<div class="context-heading">Usage limit</div>${stopped}${windows.join('')}${note}</div>`;
}

/**
 * The context meter (architecture.md § Context meter): an icon button with a ring that fills toward the auto-compact threshold, in the
 * description colour, the warning colour from `CONTEXT_WARN` and the error colour from `CONTEXT_FULL`, dashed while the size is unknown; its
 * details are its tooltip and accessible name. A click opens its menu: the details, Show details, which the front end answers by asking the hub
 * for `ContextDetails` once, and, for a session the composer can talk to (`compact`), Compact, which asks to confirm before the front end sends
 * `/compact`. Nothing without a session.
 */
export function renderContextMeter(view: ContextView | null | undefined, menu: ContextMenuState = 'closed', compact = false, details: ContextDetailsState = { state: 'none' }, now = Date.now()): string {
  const level = contextLevel(view);
  const fill = view == null ? null : contextFill(view);
  const lines = contextLines(view);
  const title = lines.join('\n');
  const arc =
    fill === null
      ? ''
      : `<circle class="context-arc" cx="8" cy="8" r="6" fill="none" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(RING * fill).toFixed(2)} ${RING.toFixed(2)}" transform="rotate(-90 8 8)"/>`;
  const ring = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><circle class="context-track" cx="8" cy="8" r="6" fill="none" stroke-width="2"/>${arc}</svg>`;
  const button = `<button class="composer-tool context-ring ${level}" type="button" data-context="toggle" title="${escape(title)}" aria-label="${escape(lines.join(' '))}" aria-haspopup="dialog" aria-expanded="${menu !== 'closed'}">${ring}</button>`;

  if (menu === 'closed') {
    return button;
  }

  const shown =
    details.state === 'shown'
      ? detailsHtml(details.details, now)
      : details.state === 'loading'
        ? '<div class="context-line" role="status">Loading details…</div>'
        : details.state === 'failed'
          ? `<div class="context-error" role="alert">${escape(details.error)}</div>`
          : '';
  const more =
    details.state === 'none' ? '<button class="context-action" type="button" data-context="details">Show details</button>' : details.state === 'failed' ? '<button class="context-action" type="button" data-context="details">Try again</button>' : '';
  const action = !compact
    ? more === ''
      ? ''
      : `<div class="context-actions">${more}</div>`
    : menu === 'confirm'
      ? '<div class="context-confirm">Compact now? The session summarizes the conversation so far and keeps only the summary.</div><div class="context-actions"><button class="context-action primary" type="button" data-context="compact-confirm">Compact</button><button class="context-action" type="button" data-context="cancel">Cancel</button></div>'
      : `<div class="context-actions">${more}<button class="context-action" type="button" data-context="compact">Compact…</button></div>`;

  return `${button}<div class="glass context-menu" role="dialog" aria-label="Context">${lines.map((line) => `<div class="context-line">${escape(line)}</div>`).join('')}${shown}${action}</div>`;
}
