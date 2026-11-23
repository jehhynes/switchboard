import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export const HUB_LOG_POLL_MS = 2_000;
const MAX_LINES = 20_000;
type Tail = { text: string; more: boolean; limited: boolean; missing: boolean };

/** The file's own timestamps and text, never interpreted as markup. */
export function filteredLog(text: string, filter: string): string {
  const query = filter.toLocaleLowerCase();
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).filter((line) => line.toLocaleLowerCase().includes(query)).join('');
}

export function HubLog({ fetch: read }: { fetch: typeof fetch }) {
  const [lines, setLines] = useState(500);
  const [tail, setTail] = useState<Tail | null>(null);
  const [filter, setFilter] = useState('');
  const [wrap, setWrap] = useState(false);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const output = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const shown = filteredLog(tail?.text ?? '', filter);

  useEffect(() => {
    let closed = false;
    let pending: AbortController | null = null;
    let needsRead = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (): Promise<void> => {
      if (closed || pending !== null || document.hidden) return;
      const controller = new AbortController();
      pending = controller;
      needsRead = true;
      setBusy(true);
      try {
        const response = await read(`/v1/page/hub-log?lines=${lines}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        if (closed || pending !== controller) return;
        if (!response.ok) throw new Error(body.error ?? 'The hub log could not be read.');
        setTail(body as Tail);
        setError(null);
      } catch (error) {
        if (!closed && pending === controller) setError((error as Error).message);
      } finally {
        if (!closed && pending === controller) {
          pending = null;
          needsRead = false;
          setBusy(false);
          if (live && !document.hidden) timer = setTimeout(() => void load(), HUB_LOG_POLL_MS);
        }
      }
    };
    const visibility = (): void => {
      clearTimeout(timer);
      if (document.hidden) {
        pending?.abort();
        pending = null;
        setBusy(false);
      } else if (live || needsRead) void load();
    };
    void load();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      closed = true;
      clearTimeout(timer);
      pending?.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [read, lines, live]);

  useLayoutEffect(() => {
    if (live && follow.current && output.current !== null) output.current.scrollTop = output.current.scrollHeight;
  }, [shown, live, wrap]);

  useEffect(() => {
    setCopied('');
  }, [shown]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied('Copied');
    } catch {
      setCopied('Copy failed. Select the log text to copy it.');
    }
  };

  return (
    <div class="hub-log">
      <p class="sheet-detail">hub.log · timestamps as written in the file</p>
      <div class="hub-log-tools">
        <input class="sheet-input" type="search" aria-label="Filter hub log" placeholder="Filter log…" value={filter} onInput={(event) => setFilter(event.currentTarget.value)} />
        <label><input type="checkbox" checked={wrap} onChange={(event) => setWrap(event.currentTarget.checked)} /> Wrap</label>
        <label><input type="checkbox" checked={live} onChange={(event) => { follow.current = true; setLive(event.currentTarget.checked); }} /> Live follow</label>
        <button type="button" class="sheet-button secondary" onClick={() => void copy()} disabled={tail === null}>Copy filtered log</button>
      </div>
      <p class="hub-log-note" role="status">{error ?? (tail === null ? 'Loading…' : tail.missing ? 'The hub log has not been created yet.' : tail.text === '' ? tail.limited ? 'No complete lines fit in the tail.' : 'The hub log is empty.' : shown === '' ? 'No matching lines.' : `${(shown.match(/\n/g)?.length ?? 0) + (shown.endsWith('\n') ? 0 : 1)} lines shown`)}{copied === '' ? '' : ` · ${copied}`}</p>
      {tail?.limited ? <p class="sheet-detail">The tail reached the 4 MiB read limit. Earlier or oversized lines are omitted.</p> : null}
      <pre class={`hub-log-output${wrap ? ' wrap' : ''}`} ref={output} tabIndex={0} aria-label="Hub log text" onScroll={(event) => {
        const node = event.currentTarget;
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}>{shown}</pre>
      <div class="hub-log-tools">
        <button type="button" class="sheet-button secondary" disabled={busy || tail?.more !== true || lines >= MAX_LINES || tail.limited} onClick={() => {
          follow.current = false;
          setLines(Math.min(MAX_LINES, lines + 500));
        }}>Load 500 more lines</button>
        {lines >= MAX_LINES && tail?.more ? <span class="sheet-detail">Showing the newest 20,000 lines.</span> : null}
      </div>
    </div>
  );
}
