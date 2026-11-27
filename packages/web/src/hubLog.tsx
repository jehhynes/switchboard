import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

export const HUB_LOG_POLL_MS = 2_000;
/** Lines each poll reads; new lines beyond it in one poll leave a gap the view says. */
export const HUB_LOG_POLL_LINES = 500;
/** Lines each Load earlier lines adds, and the most the view keeps. */
const STEP = 500;
export const HUB_LOG_MAX_LINES = 20_000;
/** Lines compared to find where a read meets the lines held, so repeated text is not taken for the same place. */
const MATCH = 5;
const COPIED_MS = 3_000;
/** `file` names the file read and `size` its length, so a rotated, replaced or cut file starts the view again. */
type Tail = { text: string; more: boolean; limited: boolean; missing: boolean; file?: string; size?: number; withheld?: string; earlierWithheld?: boolean };

/** The logs the view can show, each read through the same route. */
export const LOG_SOURCES = [{ value: 'hub', label: 'Switchboard', writer: 'Switchboard' }, { value: 'voice', label: 'Voice', writer: 'the voice process' }, { value: 'holder', label: 'Terminal holder', writer: 'the terminal holder' }] as const;
type Source = (typeof LOG_SOURCES)[number]['value'];

/** A read's lines without their line endings, and whether the last one has no newline yet. */
export function splitLines(text: string): { rows: string[]; partial: boolean } {
  if (text === '') return { rows: [], partial: false };
  const rows = text.split(/\r?\n/);
  const partial = rows.at(-1) !== '';
  if (!partial) rows.pop();
  return { rows, partial };
}

function sameRun(a: readonly string[], aEnd: number, b: readonly string[], bEnd: number, count: number): boolean {
  for (let k = 0; k < count; k++) if (a[aEnd - k] !== b[bEnd - k]) return false;
  return true;
}

/** The held lines with the read's newer ones appended, or the read alone (`gap`) when it does not reach the held lines' end. */
export function mergeTail(held: readonly string[], read: readonly string[]): { rows: string[]; added: number; gap: boolean } {
  if (held.length === 0) return { rows: [...read], added: read.length, gap: false };
  // Near the read's start the run is as long as the read allows. Where repeated lines leave two places that match, which one is the held end
  // cannot be known, so the read starts the view again rather than drop lines.
  let found = -1;
  for (let i = read.length - 1; i >= 0; i--) {
    if (sameRun(read, i, held, held.length - 1, Math.min(MATCH, held.length, i + 1))) {
      if (found !== -1) {
        found = -1;
        break;
      }
      found = i;
    }
  }
  if (found !== -1) return { rows: [...held, ...read.slice(found + 1)], added: read.length - 1 - found, gap: false };
  return { rows: [...read], added: read.length, gap: true };
}

/** The lines a longer read holds before the held ones' first, or null when it does not reach them (the file was rotated or truncated). */
export function earlierLines(held: readonly string[], read: readonly string[]): string[] | null {
  if (held.length === 0) return [...read];
  const count = Math.min(MATCH, held.length);
  for (let j = 0; j + count <= read.length; j++) {
    if (sameRun(read, j + count - 1, held, count - 1, count)) return read.slice(0, j);
  }
  return null;
}

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

export type Level = 'error' | 'warn' | 'info' | 'debug';
const LEVELS: ReadonlyArray<{ level: Level; label: string }> = [{ level: 'error', label: 'Errors' }, { level: 'warn', label: 'Warnings' }, { level: 'info', label: 'Info' }, { level: 'debug', label: 'Details' }];
const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (?:(error|warn|info|debug) +)?(.*)$/;

/** A log line: its time, level and area from `<ISO> <level> <area>: <text>`; a line before levels counts as info, and one with no timestamp, such as a stack frame, belongs to the line above. */
export type LogRow = { raw: string; at: Date | null; level: Level; area: string; text: string; continued: boolean };

export function parseRows(lines: readonly string[]): LogRow[] {
  const rows: LogRow[] = [];
  let last: LogRow | null = null;
  for (const raw of lines) {
    const found = LINE.exec(raw);
    if (found === null) {
      rows.push({ raw, at: last?.at ?? null, level: last?.level ?? 'info', area: last?.area ?? '', text: raw, continued: true });
      continue;
    }
    const text = found[3]!;
    last = { raw, at: new Date(found[1]!), level: (found[2] as Level | undefined) ?? 'info', area: (/^(work item|[a-z]+)\b/i.exec(text)?.[1] ?? '').toLowerCase(), text, continued: false };
    rows.push(last);
  }
  return rows;
}

/** The local time of the newest line with a timestamp, or null. */
function lastTime(rows: readonly string[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const stamp = STAMP.exec(rows[i]!)?.[1];
    if (stamp !== undefined) return new Date(stamp).toLocaleTimeString();
  }
  return null;
}

/** The view's lines: `drawn` is what shows; `latest` what the hub last answered, which differs from `drawn` only while not following. */
type Model = {
  drawn: string[];
  latest: string[];
  /** The last line read has no newline yet, so the next read replaces it. */
  partial: boolean;
  /** Lines in `latest` not drawn yet; with `gap`, lines were skipped and `latest` replaces `drawn` on Jump to latest. */
  waiting: number;
  gap: boolean;
  /** The first line held is the file's first. */
  atStart: boolean;
  limited: boolean;
  missing: boolean;
  loaded: boolean;
  note: string | null;
  file: string;
  size: number;
  /** Why the hub gives this log no lines yet, such as voice.log before the voice process runs this build. */
  withheld: string | null;
  /** The hub leaves out the lines older builds wrote, which can hold draft and spoken text. */
  earlierWithheld: boolean;
};

const EMPTY: Model = { drawn: [], latest: [], partial: false, waiting: 0, gap: false, atStart: false, limited: false, missing: false, loaded: false, note: null, file: '', size: 0, withheld: null, earlierWithheld: false };

export function HubLog({ fetch: read }: { fetch: typeof fetch }) {
  const [, redraw] = useState(0);
  const model = useRef<Model>(EMPTY);
  const [filter, setFilter] = useState('');
  const [source, setSource] = useState<Source>('hub');
  const [wrap, setWrap] = useState(false);
  const [paused, setPaused] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const output = useRef<HTMLDivElement>(null);
  const wantEarlier = useRef(false);
  const kick = useRef<() => void>(() => {});
  /** The output's height before earlier lines were drawn above, so the line in view stays put. */
  const anchor = useRef<number | null>(null);
  const following = !paused && !scrolledUp;
  const followingRef = useRef(following);
  followingRef.current = following;

  const [levels, setLevels] = useState<ReadonlySet<Level>>(() => new Set<Level>(['error', 'warn', 'info']));
  const [area, setArea] = useState('');
  const m = model.current;
  const parsed = useMemo(() => parseRows(m.drawn), [m.drawn]);
  const areas = useMemo(() => [...new Set(parsed.map((row) => row.area).filter((one) => one !== ''))].sort(), [parsed]);
  const errors = parsed.filter((row) => row.level === 'error' && !row.continued).length;
  const query = filter.toLocaleLowerCase();
  const selecting = query !== '' || levels.size < LEVELS.length || area !== '';
  const shownRows = selecting ? parsed.filter((row) => levels.has(row.level) && (area === '' || row.area === area) && (query === '' || row.raw.toLocaleLowerCase().includes(query))) : parsed;
  const shown = shownRows.map((row) => row.raw);

  const update = (next: Model): void => {
    model.current = next;
    redraw((n) => n + 1);
  };

  /** Draws the lines that wait, and follows again. */
  const toLatest = (): void => {
    const now = model.current;
    setPaused(false);
    setScrolledUp(false);
    update({ ...now, drawn: now.latest, waiting: 0, gap: false, note: now.gap ? 'Some lines were skipped while paused; showing the newest.' : null });
  };

  const apply = (tail: Tail, earlier: boolean): void => {
    const now = model.current;
    const { rows, partial } = splitLines(tail.text);
    const base = { ...now, limited: tail.limited, missing: tail.missing, loaded: true, file: tail.file ?? '', size: tail.size ?? 0, withheld: tail.withheld ?? null, earlierWithheld: tail.earlierWithheld === true };
    const replaced = now.loaded && !now.missing && !tail.missing && ((tail.file ?? '') !== now.file || (tail.size ?? 0) < now.size);
    if (tail.missing || (!now.loaded && !earlier) || replaced) {
      update({ ...base, drawn: rows, latest: rows, partial, waiting: 0, gap: false, atStart: !tail.more, note: replaced && !earlier ? 'The log was replaced or cut; showing the new file.' : null });
      if (replaced && !earlier) {
        setPaused(false);
        setScrolledUp(false);
      }
      return;
    }
    if (earlier) {
      const before = earlierLines(now.drawn, rows);
      if (before === null) {
        update({ ...base, note: 'Earlier lines are no longer in the file; it was replaced or cut since they were read.' });
        return;
      }
      // The read starts at the file's first line only when nothing earlier is left.
      const atStart = !tail.more || tail.limited;
      const shared = now.latest[0] === now.drawn[0];
      anchor.current = output.current?.scrollHeight ?? null;
      update({ ...base, drawn: [...before, ...now.drawn], latest: shared ? [...before, ...now.latest] : now.latest, atStart, note: null });
      return;
    }
    const held = now.partial ? now.latest.slice(0, -1) : now.latest;
    const merged = mergeTail(held, rows);
    const added = merged.added - (now.partial && !merged.gap ? 1 : 0);
    let latest = merged.rows;
    let atStart = merged.gap ? !tail.more : now.atStart;
    if (latest.length > HUB_LOG_MAX_LINES) {
      latest = latest.slice(-HUB_LOG_MAX_LINES);
      atStart = false;
    }
    if (followingRef.current) {
      update({ ...base, drawn: latest, latest, partial, waiting: 0, gap: false, atStart, note: merged.gap && now.drawn.length > 0 ? 'Some lines were skipped; showing the newest.' : now.note });
    } else {
      update({ ...base, latest, partial, waiting: now.gap || merged.gap ? Math.max(now.waiting + Math.max(added, 0), 1) : now.waiting + Math.max(added, 0), gap: now.gap || merged.gap, atStart: merged.gap ? now.atStart : atStart });
    }
  };

  useEffect(() => {
    let closed = false;
    let pending: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      if (closed || pending !== null || document.hidden) return;
      clearTimeout(timer);
      const earlier = wantEarlier.current;
      const lines = earlier ? Math.min(HUB_LOG_MAX_LINES, model.current.latest.length + STEP) : HUB_LOG_POLL_LINES;
      const controller = new AbortController();
      pending = controller;
      setBusy(true);
      try {
        const response = await read(`/v1/page/hub-log?lines=${lines}${source === 'hub' ? '' : `&log=${source}`}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (closed || pending !== controller) return;
        if (!response.ok) throw new Error(body.error ?? 'The Switchboard log could not be read.');
        if (earlier) wantEarlier.current = false;
        apply(body as Tail, earlier);
        setError(null);
        setCheckedAt(Date.now());
      } catch (error) {
        if (!closed && pending === controller) setError((error as Error).message);
      } finally {
        if (!closed && pending === controller) {
          pending = null;
          setBusy(false);
          if (!document.hidden) timer = setTimeout(() => void load(), wantEarlier.current ? 0 : HUB_LOG_POLL_MS);
        }
      }
    };
    const visibility = (): void => {
      clearTimeout(timer);
      if (document.hidden) {
        pending?.abort();
        pending = null;
        setBusy(false);
      } else void load();
    };
    kick.current = () => void load();
    void load();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      closed = true;
      clearTimeout(timer);
      pending?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [read, source]);

  useLayoutEffect(() => {
    const node = output.current;
    if (node === null) return;
    if (anchor.current !== null) {
      node.scrollTop += node.scrollHeight - anchor.current;
      anchor.current = null;
    } else if (following) node.scrollTop = node.scrollHeight;
  }, [m.drawn, following, wrap, filter, levels, area]);

  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (copied === '') return;
    const timer = setTimeout(() => setCopied(''), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shown.map((line) => `${line}\n`).join(''));
      setCopied('Copied');
    } catch {
      setCopied('Copy failed. Select the log text to copy it.');
    }
  };

  const canLoadEarlier = m.loaded && !m.missing && !m.atStart && !m.limited && m.latest.length < HUB_LOG_MAX_LINES;
  const time = lastTime(m.drawn);
  const live = error !== null
    ? <span class="hub-log-failing">Not updating — {error}; retrying</span>
    : following
      ? <span>● Live{time === null ? '' : ` — last line ${time}`}{checkedAt === null ? '' : `, checked ${Math.max(0, Math.round((clock - checkedAt) / 1000))} s ago`}</span>
      : m.waiting > 0
        ? <span>Paused — {m.gap ? 'new lines, some skipped' : `${m.waiting.toLocaleString()} new line${m.waiting === 1 ? '' : 's'}`}</span>
        : <span>Paused — no new lines</span>;
  const writer = LOG_SOURCES.find((one) => one.value === source)!.writer;
  const empty = !m.loaded ? 'Loading…' : m.withheld !== null ? m.withheld : m.missing ? `No log yet. It appears when ${writer} writes its first line.` : m.drawn.length === 0 ? m.limited ? 'No complete lines fit in the last 4 MiB.' : `The log is empty. Lines appear here as ${writer} writes them.` : null;
  const matches = empty !== null ? empty : !selecting ? `${m.drawn.length.toLocaleString()} lines` : shown.length === 0 ? 'No lines match in the loaded lines.' : `${shown.length.toLocaleString()} of ${m.drawn.length.toLocaleString()} lines match`;
  const further = selecting && canLoadEarlier ? ' · Load earlier lines to search further' : '';
  // From the latest set, so clicks between renders all count.
  const toggle = (level: Level): void => setLevels((now) => {
    const next = new Set(now);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    return next;
  });
  let day = '';

  return (
    <div class="hub-log">
      <div class="hub-log-tools">
        <select class="sheet-input hub-log-source" aria-label="Log" value={source} onChange={(event) => {
          wantEarlier.current = false;
          anchor.current = null;
          model.current = EMPTY;
          setPaused(false);
          setScrolledUp(false);
          setError(null);
          setCheckedAt(null);
          setArea('');
          setSource(event.currentTarget.value as Source);
        }}>
          {LOG_SOURCES.map((one) => <option value={one.value}>{one.label}</option>)}
        </select>
        <input class="sheet-input" type="search" aria-label="Filter log" placeholder="Filter log…" value={filter} onInput={(event) => setFilter(event.currentTarget.value)} />
        <label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.currentTarget.checked)} /> Wrap</label>
        <button type="button" class="sheet-button secondary" onClick={() => void copy()} disabled={shown.length === 0}>Copy shown lines</button>
      </div>
      <div class="hub-log-tools hub-log-levels" role="group" aria-label="Show lines">
        {LEVELS.map(({ level, label }) => <button type="button" class={`hub-log-chip level-${level}`} aria-pressed={levels.has(level)} onClick={() => toggle(level)}>{label}</button>)}
        <select class="sheet-input hub-log-area" aria-label="Area" value={area} onChange={(event) => setArea(event.currentTarget.value)}>
          <option value="">All areas</option>
          {areas.map((one) => <option value={one}>{one}</option>)}
        </select>
        {errors === 0 ? null : <button type="button" class="hub-log-errors" onClick={() => setLevels(new Set<Level>(['error']))}>{errors === 1 ? '1 error' : `${errors.toLocaleString()} errors`} in loaded lines</button>}
      </div>
      <div class="hub-log-live">
        <p class="hub-log-note" role="status">{live}{' · '}{matches}{further}{copied === '' ? '' : ` · ${copied}`}</p>
        {following
          ? <button type="button" class="sheet-button secondary" onClick={() => setPaused(true)}>Pause</button>
          : <button type="button" class="sheet-button secondary" onClick={toLatest}>{m.waiting > 0 ? 'Jump to latest' : 'Resume'}</button>}
      </div>
      {m.note === null ? null : <p class="sheet-detail">{m.note}</p>}
      {m.earlierWithheld && m.atStart ? <p class="sheet-detail">Lines from before this build are not shown, since they can hold draft and spoken text.</p> : null}
      {m.limited ? <p class="sheet-detail">Only the last 4 MiB is shown; earlier and very long lines are left out.</p> : null}
      <div class={`hub-log-output${wrap ? ' wrap' : ''}`} ref={output} tabIndex={0} role="log" aria-label="Switchboard log text" onScroll={(event) => {
        const node = event.currentTarget;
        const atEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        if (atEnd && scrolledUp) {
          setScrolledUp(false);
          // Also when only a partial last line changed, which counts as no new line.
          if (!paused && model.current.latest !== model.current.drawn) toLatest();
        } else if (!atEnd && !scrolledUp) setScrolledUp(true);
      }}>
        {canLoadEarlier || (m.latest.length >= HUB_LOG_MAX_LINES && !m.atStart)
          ? <div class="hub-log-earlier">
            {m.latest.length >= HUB_LOG_MAX_LINES
              ? <span class="sheet-detail">Showing the newest {HUB_LOG_MAX_LINES.toLocaleString()} lines.</span>
              : <button type="button" class="sheet-button secondary" disabled={busy && wantEarlier.current} onClick={() => {
                wantEarlier.current = true;
                kick.current();
              }}>Load earlier lines</button>}
          </div>
          : null}
        {shownRows.map((row) => {
          const date = row.at === null ? '' : row.at.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          const divider = date !== '' && date !== day && !row.continued ? <div class="hub-log-day">{date}</div> : null;
          if (date !== '' && !row.continued) day = date;
          return (
            <>
              {divider}
              {row.continued || row.at === null
                ? <div class={`hub-log-line continued level-${row.level}`}>{row.raw}</div>
                : <div class={`hub-log-line level-${row.level}`} title={row.at.toISOString()}><span class="hub-log-time">{row.at.toLocaleTimeString()}</span> <span class="hub-log-level">{row.level.padEnd(5)}</span> {row.text}</div>}
            </>
          );
        })}
      </div>
    </div>
  );
}
