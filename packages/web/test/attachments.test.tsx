import { describe, expect, it, vi } from 'vitest';
import { attachments, drawChips } from '../src/attachments.js';
import type { Attached } from '../src/attachments.js';

const file = (id: number, name: string, path: string | null, image = false): Attached => ({ id, name, path, image, abort: null });

describe('attachment chips', () => {
  it('shows a file name with markup as text, in the chip, its tooltip and its remove label', () => {
    const host = document.createElement('div');
    const name = '<img src=x onerror="alert(1)">.png';

    drawChips(host, [file(1, name, 'C:/Temp/pasted.png', true)], () => {});
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.attachment-name')!.textContent).toBe(name);
    expect(host.querySelector('.attachment')!.getAttribute('title')).toBe(name);
    expect(host.querySelector('.attachment-remove')!.getAttribute('aria-label')).toBe(`Remove ${name}`);
  });

  it('keeps a chip whose file arrived, swapping its spinner for its icon, hides the host with no files, and removes by ID', () => {
    const host = document.createElement('div');
    const removed: number[] = [];
    const uploading = file(7, 'notes.txt', null);

    drawChips(host, [uploading, file(8, 'shot.png', 'C:/Temp/shot.png', true)], (id) => removed.push(id));
    const chip = host.querySelector('.attachment')!;

    expect(host.hidden).toBe(false);
    expect(chip.getAttribute('title')).toBe('Attaching notes.txt…');
    expect(chip.querySelector('.codicon')!.className).toBe('codicon codicon-loading codicon-modifier-spin');

    uploading.path = 'C:/Temp/notes.txt';
    drawChips(host, [uploading, file(8, 'shot.png', 'C:/Temp/shot.png', true)], (id) => removed.push(id));
    expect(host.querySelector('.attachment')).toBe(chip);
    expect(chip.querySelector('.codicon')!.className).toBe('codicon codicon-file');
    expect(chip.getAttribute('title')).toBe('notes.txt');

    host.querySelectorAll<HTMLButtonElement>('.attachment-remove')[1]!.click();
    expect(removed).toEqual([8]);

    drawChips(host, [], () => {});
    expect(host.hidden).toBe(true);
    expect(host.childNodes).toHaveLength(0);
  });
});

describe('attachment uploads', () => {
  it('retries one failed browser request and keeps the attached file when the hub answers', async () => {
    localStorage.clear();
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ path: 'C:/Temp/shot.png', image: true }), { status: 200 }));
    const refused = vi.fn();
    const changed = vi.fn();
    const files = attachments({ fetch, shown: () => 1, refused, changed, expired: vi.fn() });

    expect(files.add(1, 'page-1', 3, [new File(['picture'], 'shot.png', { type: 'image/png' })])).toEqual([]);
    await vi.waitFor(() => expect(files.of(1)[0]?.path).toBe('C:/Temp/shot.png'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toBe(`${fetch.mock.calls[0]![0]}&retry=1`);
    expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
    expect(refused).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('reports the failure and removes the chip after two failed browser requests', async () => {
    localStorage.clear();
    const fetch = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    const refused = vi.fn();
    const files = attachments({ fetch, shown: () => 1, refused, changed: vi.fn(), expired: vi.fn() });

    files.add(1, 'page-1', 3, [new File(['picture'], 'shot.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(refused).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(files.of(1)).toEqual([]);
    expect(refused).toHaveBeenCalledWith(1, 'shot.png was not attached: Switchboard did not answer (TypeError: Load failed).');
  });

  it('does not retry a hub refusal', async () => {
    localStorage.clear();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    const refused = vi.fn();
    const expired = vi.fn();
    const files = attachments({ fetch, shown: () => 1, refused, changed: vi.fn(), expired });

    files.add(1, 'page-1', 3, [new File(['picture'], 'shot.png', { type: 'image/png' })]);
    await vi.waitFor(() => expect(refused).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledOnce();
    expect(files.of(1)).toEqual([]);
  });

  it('does not retry a request after its chip was removed', async () => {
    localStorage.clear();
    let fail!: (error: TypeError) => void;
    const fetch = vi.fn(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
    const refused = vi.fn();
    const files = attachments({ fetch, shown: () => 1, refused, changed: vi.fn(), expired: vi.fn() });

    files.add(1, 'page-1', 3, [new File(['picture'], 'shot.png', { type: 'image/png' })]);
    const id = files.of(1)[0]!.id;

    expect(files.remove(1, id)).toBe(true);
    fail(new TypeError('Load failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(files.of(1)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refused).not.toHaveBeenCalled();
  });
});
