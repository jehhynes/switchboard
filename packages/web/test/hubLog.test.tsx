import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import { earlierLines, HubLog, HUB_LOG_POLL_MS, mergeTail, parseRows, splitLines } from '../src/hubLog.js';

let host: HTMLElement;
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
/** The file only grows unless a test says otherwise. */
let size = 0;
const reply = (text: string, more = false, extra: Record<string, unknown> = {}) => ({ ok: true, json: async () => ({ text, more, limited: false, missing: false, file: 'f1', size: size += text.length, ...extra }) }) as Response;
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label);
const click = async (label: string) => { await act(() => { button(label)!.click(); }); };
const output = () => host.querySelector<HTMLElement>('[role=log]')!;
const lines = () => [...host.querySelectorAll('.hub-log-line')].map((node) => node.textContent);
const status = () => host.querySelector('[role=status]')!.textContent!;
const tick = async (ms = HUB_LOG_POLL_MS) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-11-22T12:00:${String(from + i).padStart(2, '0')}.000Z line ${from + i}\n`).join('');
/** jsdom lays nothing out: each line is 20 px tall in a 100 px window. */
const layout = () => {
  const node = output();
  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => node.querySelectorAll('.hub-log-line').length * 20 });
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: 100 });
};
const scrollTo = async (top: number) => { await act(() => { output().scrollTop = top; output().dispatchEvent(new Event('scroll')); }); };

beforeEach(() => {
  size = 0;
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.replaceChildren(host);
});
afterEach(() => {
  act(() => render(null, host));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the hub log lines', () => {
  it('splits a read into lines and marks a last line with no newline yet', () => {
    expect(splitLines('a\r\nb\n')).toEqual({ rows: ['a', 'b'], partial: false });
    expect(splitLines('a\nb')).toEqual({ rows: ['a', 'b'], partial: true });
    expect(splitLines('')).toEqual({ rows: [], partial: false });
  });

  it('appends only the lines after the held end, tells repeated lines apart, and reports a gap when the read does not reach it', () => {
    expect(mergeTail(['a', 'b', 'c'], ['b', 'c', 'd', 'e'])).toEqual({ rows: ['a', 'b', 'c', 'd', 'e'], added: 2, gap: false });
    expect(mergeTail(['a', 'b'], ['a', 'b'])).toEqual({ rows: ['a', 'b'], added: 0, gap: false });
    // "x" repeats: the held end could be either x, so the read starts the view again rather than guess.
    expect(mergeTail(['1', 'x', 'x', '2', 'x'], ['x', 'x', '2', 'x', 'x', '2', 'x', 'new'])).toMatchObject({ gap: true });
    expect(mergeTail(['1', 'x', '2'], ['x', '2', 'y', 'new'])).toEqual({ rows: ['1', 'x', '2', 'y', 'new'], added: 2, gap: false });
    expect(mergeTail(['a', 'b'], ['y', 'z'])).toEqual({ rows: ['y', 'z'], added: 2, gap: true });
    expect(mergeTail(['a', 'b', 'c'], ['c'])).toEqual({ rows: ['a', 'b', 'c'], added: 0, gap: false });
    expect(mergeTail(['a', 'b'], ['b', 'x', 'b'])).toEqual({ rows: ['a', 'b', 'x', 'b'], added: 2, gap: false });
    // The held end recurs among the new lines: which is the held one is unknown, so nothing is dropped silently.
    expect(mergeTail(['b'], ['b', 'x', 'b'])).toEqual({ rows: ['b', 'x', 'b'], added: 3, gap: true });
    expect(mergeTail(['p', 'q'], ['p', 'q', 'r', 'p', 'q'])).toMatchObject({ gap: true });
    // One line at the read's start could be the held end too.
    expect(mergeTail(['p', 'q'], ['q', 'r', 'p', 'q'])).toMatchObject({ gap: true });
  });

  it('finds the lines before the held start in a longer read, or none when the read no longer holds them', () => {
    expect(earlierLines(['c', 'd'], ['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b']);
    expect(earlierLines(['c', 'd'], ['c', 'd'])).toEqual([]);
    expect(earlierLines(['c', 'd'], ['x', 'y'])).toBeNull();
  });
});

describe('the hub log levels', () => {
  it('reads the time, level and area, counts a line before levels as info, and gives a stack frame the line above\'s', () => {
    const rows = parseRows(['2026-11-26T01:04:18.000Z warn  sessions: could not list', '    at read (x.js:1)', '2026-11-26T01:04:19.000Z voice target abc', '2026-11-26T01:04:20.000Z debug session bfd12580 (work item 3): sent', '2026-11-26T01:04:21.000Z info  work item 4: artifact updated: a.md', 'no stamp at the start']);
    expect(rows.map((row) => [row.level, row.area, row.continued])).toEqual([['warn', 'sessions', false], ['warn', 'sessions', true], ['info', 'voice', false], ['debug', 'session', false], ['info', 'work item', false], ['info', 'work item', true]]);
    expect(rows[0]!.text).toBe('sessions: could not list');
    expect(rows[1]!.at).toEqual(rows[0]!.at);
  });
});

describe('the hub log sheet', () => {
  it('shows local times with a date line, colours warnings and errors, hides details until asked, and filters by level and area', async () => {
    const text = [
      '2026-11-25T10:00:00.000Z info  hub: restarted on build b1',
      '2026-11-25T10:00:01.000Z debug voice: now for session s1',
      '2026-11-26T10:00:02.000Z warn  sessions: could not list running Codex sessions',
      '2026-11-26T10:00:03.000Z error hub: unexpected error: boom',
      '    at main (hub.js:1)',
      '2026-11-26T10:00:04.000Z voice: an old line with no level',
    ].join('\n') + '\n';
    const read = vi.fn().mockResolvedValue(reply(text));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    // Details are off by default: the debug line is hidden.
    expect(lines()).toHaveLength(5);
    expect(host.textContent).not.toContain('now for session');
    const first = host.querySelector('.hub-log-line')!;
    expect(first.querySelector('.hub-log-time')!.textContent).toBe(new Date('2026-11-25T10:00:00.000Z').toLocaleTimeString());
    expect(first.getAttribute('title')).toBe('2026-11-25T10:00:00.000Z');
    expect([...host.querySelectorAll('.hub-log-day')].map((node) => node.textContent)).toEqual(['2026-11-25T10:00:00.000Z', '2026-11-26T10:00:02.000Z'].map((at) => new Date(at).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })));
    expect(host.querySelector('.hub-log-line.level-warn')!.textContent).toContain('could not list');
    expect(host.querySelector('.hub-log-line.level-error:not(.continued)')!.textContent).toContain('boom');
    expect(host.querySelector('.continued')!.classList.contains('level-error')).toBe(true);
    await click('Details');
    expect(lines()).toHaveLength(6);
    expect(status()).toContain('6 lines');
    await click('1 error in loaded lines');
    expect(lines()).toEqual([expect.stringContaining('boom'), '    at main (hub.js:1)']);
    expect(status()).toContain('2 of 6 lines match');
    // Clicks between renders all count.
    await act(() => { for (const label of ['Errors', 'Info', 'Warnings', 'Details']) button(label)!.click(); });
    expect(['Errors', 'Warnings', 'Info', 'Details'].map((label) => button(label)!.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'true', 'true']);
    const select = host.querySelector<HTMLSelectElement>('select[aria-label=Area]')!;
    expect([...select.options].map((one) => one.value)).toEqual(['', 'hub', 'sessions', 'voice']);
    await act(() => { select.value = 'voice'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(lines()).toEqual([expect.stringContaining('now for session'), expect.stringContaining('an old line with no level')]);
    // Copy keeps the file's own text.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await click('Copy shown lines');
    expect(writeText).toHaveBeenCalledWith('2026-11-25T10:00:01.000Z debug voice: now for session s1\n2026-11-26T10:00:04.000Z voice: an old line with no level\n');
  });

  it('reads 500 lines, shows text as text, filters with a match count, wraps, and copies the shown lines', async () => {
    const read = vi.fn().mockResolvedValue(reply('2026-11-22T12:01:00Z ready\r\n2026-11-22T12:02:00Z ERROR <img src=x>\r\n', true));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    expect(read).toHaveBeenCalledWith('/v1/page/hub-log?lines=500', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain('ERROR <img src=x>');
    expect(host.querySelector('img')).toBeNull();
    const filter = host.querySelector<HTMLInputElement>('input[type=search]')!;
    await act(() => { filter.value = 'error'; filter.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('ERROR <img src=x>');
    expect(status()).toContain('1 of 2 lines match · Load earlier lines to search further');
    await act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    expect(output().classList.contains('wrap')).toBe(true);
    await click('Copy shown lines');
    expect(writeText).toHaveBeenCalledWith('2026-11-22T12:02:00Z ERROR <img src=x>\n');
    expect(status()).toContain('Copied');
    // A poll that brings new text leaves the note for its three seconds.
    read.mockResolvedValue(reply('2026-11-22T12:01:00Z ready\n2026-11-22T12:02:00Z ERROR <img src=x>\n2026-11-22T12:03:00Z error again\n', true));
    await tick();
    expect(status()).toContain('Copied');
    await tick(1_100);
    expect(status()).not.toContain('Copied');
    await act(() => { filter.value = 'absent'; filter.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(status()).toContain('No lines match in the loaded lines.');
    expect(button('Copy shown lines')!.disabled).toBe(true);
  });

  it('says it is live with the newest line\'s local time and how long ago it checked', async () => {
    const read = vi.fn().mockResolvedValue(reply('2026-11-22T12:00:05.000Z one\nstack line\n'));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    const time = new Date('2026-11-22T12:00:05.000Z').toLocaleTimeString();
    expect(status()).toContain(`● Live — last line ${time}, checked 0 s ago`);
    // A stalled read shows the check ageing.
    read.mockImplementation(() => new Promise(() => {}));
    await tick(HUB_LOG_POLL_MS + 5_000);
    expect(status()).toMatch(/checked [67] s ago/);
  });

  it('polls without overlapping, stops while hidden, and aborts when closed', async () => {
    const read = vi.fn().mockResolvedValue(reply('first\n'));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    await tick();
    expect(read).toHaveBeenCalledTimes(2);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await tick(HUB_LOG_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(() => render(null, host));
    await tick(HUB_LOG_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('keeps the lines while reads fail, says it is not updating, and recovers on the next poll', async () => {
    const read = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: '', more: false, limited: false, missing: true, file: '', size: 0 }) });
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    expect(status()).toContain('No log yet. It appears when Switchboard writes its first line.');
    read.mockResolvedValueOnce(reply('kept\n'));
    await tick();
    read.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Access to the hub log ended.' }) });
    await tick();
    expect(status()).toContain('Not updating — Access to the hub log ended.; retrying');
    expect(host.querySelector('.hub-log-failing')).not.toBeNull();
    expect(lines()).toEqual(['kept']);
    read.mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'kept\nnew\n', more: true, limited: true, missing: false, file: 'f1', size: size += 100 }) });
    await tick();
    expect(status()).not.toContain('Not updating');
    expect(lines()).toEqual(['kept', 'new']);
    expect(host.textContent).toContain('Only the last 4 MiB is shown');
    expect(button('Load earlier lines')).toBeUndefined();
  });

  it('does not overlap a slow read or apply its answer after the sheet closes', async () => {
    let release: ((answer: Response) => void) | undefined;
    const read = vi.fn(() => new Promise<Response>((done) => { release = done; }));
    await act(() => render(<HubLog fetch={read} />, host));
    await tick(HUB_LOG_POLL_MS * 5);
    expect(read).toHaveBeenCalledTimes(1);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(read).toHaveBeenCalledTimes(1);
    const signal = (read.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    await act(() => render(null, host));
    expect(signal.aborted).toBe(true);
    await act(async () => { release!(reply('late private text\n')); });
    expect(host.textContent).toBe('');
    await tick(HUB_LOG_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled poll when hidden and starts a fresh one on return, ignoring late answers', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    let release: ((answer: Response) => void) | undefined;
    const read = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { release = done; })).mockResolvedValue(reply('fresh\n'));
    await act(() => render(<HubLog fetch={read} />, host));
    const signal = read.mock.calls[0]![1].signal as AbortSignal;
    hidden.mockReturnValue(true);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(signal.aborted).toBe(true);
    hidden.mockReturnValue(false);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(lines()).toEqual(['fresh']);
    await act(async () => { release!(reply('stale\n')); });
    expect(lines()).toEqual(['fresh']);
    await tick();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('loads earlier lines at the top and keeps the line in view where it was', async () => {
    const read = vi.fn().mockResolvedValue(reply(numbered(11, 20), true));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    layout();
    await scrollTo(60);
    const earlier = host.querySelector('.hub-log-earlier')!;
    // The button is above the first line, inside the scroller.
    expect(earlier.compareDocumentPosition(host.querySelector('.hub-log-line')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelector('.hub-log-line')!.textContent).toContain('line 11');
    read.mockResolvedValueOnce(reply(numbered(1, 21), false));
    await click('Load earlier lines');
    await flush();
    expect(read.mock.calls.at(-1)![0]).toBe('/v1/page/hub-log?lines=510');
    expect(lines()[0]).toContain('line 1');
    expect(lines()).toHaveLength(20);
    // Ten lines of 20 px were drawn above: the view moved down by 200 px, so line 14 is still at the top.
    expect(output().scrollTop).toBe(260);
    // The read started at the file's first line, so there is nothing earlier.
    expect(button('Load earlier lines')).toBeUndefined();
    // A newer line is held back, since the view is scrolled up.
    read.mockResolvedValue(reply(numbered(11, 21), true));
    await tick();
    expect(status()).toContain('Paused — 1 new line');
  });

  it('says when earlier lines are gone because the file was replaced', async () => {
    const read = vi.fn().mockResolvedValue(reply(numbered(11, 20), true));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    read.mockResolvedValueOnce(reply(numbered(30, 40), true));
    await click('Load earlier lines');
    await flush();
    expect(host.textContent).toContain('Earlier lines are no longer in the file');
    expect(lines()[0]).toContain('line 11');
  });

  it('holds new lines back while scrolled up, counts them, and draws them with Jump to latest', async () => {
    const read = vi.fn().mockResolvedValue(reply(numbered(1, 10)));
    await act(() => render(<HubLog fetch={read} />, host));
    layout();
    await flush();
    expect(output().scrollTop).toBe(200);
    await scrollTo(40);
    read.mockResolvedValue(reply(numbered(1, 12)));
    await tick();
    expect(lines()).toHaveLength(10);
    expect(output().scrollTop).toBe(40);
    expect(status()).toContain('Paused — 2 new lines');
    read.mockResolvedValue(reply(numbered(1, 13)));
    await tick();
    expect(status()).toContain('Paused — 3 new lines');
    await click('Jump to latest');
    expect(lines()).toHaveLength(13);
    expect(output().scrollTop).toBe(260);
    expect(status()).toContain('● Live');
  });

  it('pauses with Pause, resumes with Resume, and follows again when scrolled to the end', async () => {
    const read = vi.fn().mockResolvedValue(reply(numbered(1, 10)));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    layout();
    await click('Pause');
    expect(status()).toContain('Paused — no new lines');
    read.mockResolvedValue(reply(numbered(1, 11)));
    await tick();
    expect(lines()).toHaveLength(10);
    expect(status()).toContain('Paused — 1 new line');
    await click('Jump to latest');
    expect(lines()).toHaveLength(11);
    await click('Pause');
    await click('Resume');
    expect(status()).toContain('● Live');
    // Scrolled up and back to the end, the waiting lines are drawn.
    await scrollTo(0);
    read.mockResolvedValue(reply(numbered(1, 12)));
    await tick();
    expect(lines()).toHaveLength(11);
    await scrollTo(output().scrollHeight - 100);
    expect(lines()).toHaveLength(12);
    expect(status()).toContain('● Live');
  });

  it('starts again with a note when the file is replaced, cut, or more lines came than one read holds', async () => {
    const read = vi.fn().mockResolvedValue(reply(numbered(1, 5)));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    read.mockResolvedValue(reply('2026-11-22T13:00:00.000Z fresh\n', false, { file: 'f2' }));
    await tick();
    expect(lines()).toEqual([expect.stringContaining('fresh')]);
    expect(host.textContent).toContain('The log was replaced or cut; showing the new file.');
    read.mockResolvedValue(reply(numbered(30, 40), true, { file: 'f2' }));
    await tick();
    expect(lines()[0]).toContain('line 30');
    expect(host.textContent).toContain('Some lines were skipped; showing the newest.');
  });

  it('draws a partial last line completed while paused once the view is back at its end', async () => {
    const read = vi.fn().mockResolvedValue(reply(numbered(1, 10) + 'tw'));
    await act(() => render(<HubLog fetch={read} />, host));
    layout();
    await flush();
    await scrollTo(0);
    read.mockResolvedValue(reply(numbered(1, 10) + 'two\n'));
    await tick();
    expect(lines().at(-1)).toBe('tw');
    expect(status()).toContain('Paused — no new lines');
    await scrollTo(output().scrollHeight - 100);
    expect(lines().at(-1)).toBe('two');
  });

  it('says when the hub left out lines older builds wrote, and offers no earlier lines', async () => {
    const read = vi.fn().mockResolvedValue(reply('2026-11-26T10:00:00.000Z info  hub: started\n', false, { earlierWithheld: true }));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    expect(host.textContent).toContain('Lines from before this build are not shown, since they can hold draft and spoken text.');
    expect(button('Load earlier lines')).toBeUndefined();
    // A rotated log holds no withheld lines, so the note goes.
    read.mockResolvedValue(reply('2026-11-27T10:00:00.000Z info  hub: rotated\n', false, { file: 'f2' }));
    await tick();
    expect(lines()).toEqual([expect.stringMatching(/hub: rotated$/)]);
    expect(host.textContent).not.toContain('Lines from before this build are not shown');
  });

  it('reads a partial last line again once it is complete', async () => {
    const read = vi.fn().mockResolvedValue(reply('one\ntw'));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    expect(lines()).toEqual(['one', 'tw']);
    read.mockResolvedValue(reply('one\ntwo\nthree\n'));
    await tick();
    expect(lines()).toEqual(['one', 'two', 'three']);
  });

  it('picks the voice or terminal holder log, starting the view again, and says when the hub withholds the voice log', async () => {
    const read = vi.fn().mockResolvedValue(reply('2026-11-26T01:00:00.000Z info  hub: started\n'));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    const picker = host.querySelector<HTMLSelectElement>('select[aria-label=Log]')!;
    expect([...picker.options].map((one) => one.textContent)).toEqual(['Switchboard', 'Voice', 'Terminal holder']);
    read.mockResolvedValue({ ok: true, json: async () => ({ text: '', more: false, limited: false, missing: true, file: '', size: 0, withheld: 'The voice log shows once the voice process restarts on this build, which keeps no spoken or heard words in it.' }) });
    await act(() => { picker.value = 'voice'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(read.mock.calls.at(-1)![0]).toBe('/v1/page/hub-log?lines=500&log=voice');
    expect(lines()).toEqual([]);
    expect(status()).toContain('The voice log shows once the voice process restarts on this build');
    read.mockResolvedValue(reply('2026-11-26T01:00:00.000Z info  Listening on 127.0.0.1:1\n', false, { file: 'h1' }));
    await act(() => { picker.value = 'holder'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(read.mock.calls.at(-1)![0]).toBe('/v1/page/hub-log?lines=500&log=holder');
    expect(lines()).toEqual([expect.stringContaining('Listening on 127.0.0.1:1')]);
    // A new file of another log is no replacement: no note says the log was cut.
    expect(host.textContent).not.toContain('replaced or cut');
    read.mockResolvedValue({ ok: true, json: async () => ({ text: '', more: false, limited: false, missing: true, file: '', size: 0 }) });
    await act(() => { picker.value = 'voice'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    expect(status()).toContain('No log yet. It appears when the voice process writes its first line.');
  });

  it('retries an interrupted Load earlier lines after returning', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const read = vi.fn().mockResolvedValue(reply('recent\n', true));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    read.mockImplementationOnce(() => new Promise<Response>(() => {}));
    await click('Load earlier lines');
    const signal = read.mock.calls.at(-1)![1].signal as AbortSignal;
    hidden.mockReturnValue(true);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(signal.aborted).toBe(true);
    read.mockResolvedValue(reply('older\nrecent\n'));
    hidden.mockReturnValue(false);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(read.mock.calls.at(-1)![0]).toBe('/v1/page/hub-log?lines=501');
    expect(lines()).toEqual(['older', 'recent']);
  });
});
