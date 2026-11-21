import { describe, expect, it } from 'vitest';
import { drawChips } from '../src/attachments.js';
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
