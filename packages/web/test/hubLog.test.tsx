import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'preact/test-utils';
import { render } from 'preact';
import { HubLog, HUB_LOG_POLL_MS } from '../src/hubLog.js';

let host: HTMLElement;
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const reply = (text: string, more = false) => ({ ok: true, json: async () => ({ text, more, limited: false, missing: false }) }) as Response;
const click = async (label: string) => {
  await act(() => { [...host.querySelectorAll('button')].find((node) => node.textContent === label)!.click(); });
};

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.replaceChildren(host);
});
afterEach(() => {
  act(() => render(null, host));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the hub log sheet', () => {
  it('loads 500 lines, preserves timestamps as text, filters, wraps and copies only matching lines', async () => {
    const read = vi.fn().mockResolvedValue(reply('2026-11-22T12:01:00Z ready\r\n2026-11-22T12:02:00Z ERROR <img src=x>\r\n', true));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    expect(read).toHaveBeenCalledWith('/v1/page/hub-log?lines=500', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(host.querySelector('pre')!.textContent).toContain('2026-11-22T12:02:00Z ERROR <img src=x>');
    expect(host.querySelector('img')).toBeNull();
    const filter = host.querySelector<HTMLInputElement>('input[type=search]')!;
    await act(() => { filter.value = 'error'; filter.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.querySelector('pre')!.textContent).toBe('2026-11-22T12:02:00Z ERROR <img src=x>\r\n');
    Object.defineProperty(host.querySelector('pre')!, 'scrollHeight', { configurable: true, value: 2000 });
    await act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
    expect(host.querySelector('pre')!.classList.contains('wrap')).toBe(true);
    expect(host.querySelector('pre')!.scrollTop).toBe(2000);
    await click('Copy filtered log');
    expect(writeText).toHaveBeenCalledWith('2026-11-22T12:02:00Z ERROR <img src=x>\r\n');
    expect(host.querySelector('[role=status]')!.textContent).toContain('Copied');
    await click('Load 500 more lines');
    await flush();
    expect(read.mock.calls.at(-1)![0]).toBe('/v1/page/hub-log?lines=1000');
    expect(filter.value).toBe('error');
  });

  it('polls without overlapping, pauses while hidden or live is off, and aborts when closed', async () => {
    const read = vi.fn().mockResolvedValue(reply('first\n'));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS); });
    expect(read).toHaveBeenCalledTimes(2);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS * 3); });
    expect(read).toHaveBeenCalledTimes(2);
    hidden.mockReturnValue(false);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(read).toHaveBeenCalledTimes(3);
    await act(() => host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1]!.click());
    await flush();
    const paused = read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS * 3); });
    expect(read).toHaveBeenCalledTimes(paused);
    await act(() => render(null, host));
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS * 3); });
    expect(read).toHaveBeenCalledTimes(paused);
  });

  it('reports missing files, no matches, bounded reads and failures, and recovers on the next poll', async () => {
    const read = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ text: '', more: false, limited: false, missing: true }) });
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    expect(host.textContent).toContain('No Switchboard log yet. It appears when Switchboard writes its first line.');
    read.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Access to the hub log ended.' }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS); });
    expect(host.textContent).toContain('Access to the hub log ended.');
    read.mockResolvedValueOnce({ ok: true, json: async () => ({ text: 'new\n', more: true, limited: true, missing: false }) });
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS); });
    expect(host.querySelector('pre')!.textContent).toBe('new\n');
    expect(host.textContent).not.toContain('Access to the hub log ended.');
    expect(host.textContent).toContain('Only the last 4 MiB is shown');
    expect([...host.querySelectorAll('button')].find((node) => node.textContent === 'Load 500 more lines')!.disabled).toBe(true);
    const filter = host.querySelector<HTMLInputElement>('input[type=search]')!;
    await act(() => { filter.value = 'absent'; filter.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(host.textContent).toContain('No matching lines. Change or clear the filter.');
  });

  it('does not overlap a slow read or apply its answer after the sheet closes', async () => {
    let release: ((answer: Response) => void) | undefined;
    const read = vi.fn(() => new Promise<Response>((done) => { release = done; }));
    await act(() => render(<HubLog fetch={read} />, host));
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS * 5); });
    expect(read).toHaveBeenCalledTimes(1);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(read).toHaveBeenCalledTimes(1);
    const signal = (read.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    await act(() => render(null, host));
    expect(signal.aborted).toBe(true);
    await act(async () => { release!(reply('late private text\n')); });
    expect(host.textContent).toBe('');
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS * 3); });
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
    expect(host.querySelector('pre')!.textContent).toBe('fresh\n');
    await act(async () => { release!(reply('stale\n')); });
    expect(host.querySelector('pre')!.textContent).toBe('fresh\n');
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS); });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('retries an interrupted load-more request after returning, even with live follow off', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const read = vi.fn().mockResolvedValue(reply('recent\n', true));
    await act(() => render(<HubLog fetch={read} />, host));
    await flush();
    await act(() => host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1]!.click());
    await flush();
    read.mockImplementationOnce(() => new Promise<Response>(() => {}));
    await click('Load 500 more lines');
    const signal = read.mock.calls.at(-1)![1].signal as AbortSignal;
    hidden.mockReturnValue(true);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(signal.aborted).toBe(true);
    read.mockResolvedValue(reply('older\nrecent\n'));
    hidden.mockReturnValue(false);
    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(read.mock.calls.at(-1)![0]).toBe('/v1/page/hub-log?lines=1000');
    expect(host.querySelector('pre')!.textContent).toBe('older\nrecent\n');
    const settled = read.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(HUB_LOG_POLL_MS * 3); });
    expect(read).toHaveBeenCalledTimes(settled);
  });
});
