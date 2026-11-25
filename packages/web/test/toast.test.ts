import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToast, showToast, toast, TOAST_SHOWN_MS } from '../src/toast.js';

describe("the page's toast (toast.tsx)", () => {
  let host: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const text = () => host.querySelector('.toast-text')?.textContent ?? null;

  it('shows a refusal in the warning colours and anything else in neutral ones, one message at a time', () => {
    const box = toast(host, { open: () => undefined });

    box.show('The work item no longer offers this.');
    expect(host.querySelector('.toast')!.className).toBe('toast warning');
    expect(host.querySelector('.toast')!.getAttribute('role')).toBe('alert');
    expect(host.querySelector('.toast > .codicon')!.className).toBe('codicon codicon-warning toast-icon');
    expect(host.querySelector('.toast > .codicon')!.getAttribute('aria-hidden')).toBe('true');
    box.show('Copied Reply.', 'info');
    expect(host.querySelectorAll('.toast')).toHaveLength(1);
    expect(host.querySelector('.toast')!.className).toBe('toast info');
    expect(host.querySelector('.toast')!.getAttribute('role')).toBe('status');
    expect(host.querySelector('.toast > .codicon')!.className).toBe('codicon codicon-info toast-icon');
    expect(text()).toBe('Copied Reply.');
    // Clearing a refusal leaves a message that is not one; clearing all hides it.
    box.clear('warning');
    expect(text()).toBe('Copied Reply.');
    box.clear();
    expect(host.querySelector('.toast')).toBeNull();
    box.close();
  });

  it('hides after 10 s shown on a visible page with the pointer off it, starting again when the same message comes again or the pointer leaves it', () => {
    const box = toast(host, { open: () => undefined });

    box.show('Not sent.');
    vi.advanceTimersByTime(TOAST_SHOWN_MS - 1_000);
    box.show('Not sent.');
    vi.advanceTimersByTime(TOAST_SHOWN_MS - 1_000);
    expect(text()).toBe('Not sent.');
    // The pointer on it holds it.
    host.querySelector('.toast-text')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(30_000);
    expect(text()).toBe('Not sent.');
    host.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(TOAST_SHOWN_MS - 1_000);
    expect(text()).toBe('Not sent.');
    vi.advanceTimersByTime(1_000);
    expect(host.querySelector('.toast')).toBeNull();

    // A hidden page does not count, so the message is there when the operator comes back.
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    box.show('Not sent.');
    vi.advanceTimersByTime(60_000);
    expect(text()).toBe('Not sent.');
    hidden.mockReturnValue(false);
    vi.advanceTimersByTime(TOAST_SHOWN_MS);
    expect(host.querySelector('.toast')).toBeNull();
    hidden.mockRestore();

    // A message shown between two counts, or the pointer leaving then, still gets its whole time.
    box.show('First.');
    vi.advanceTimersByTime(999);
    box.show('Second.');
    vi.advanceTimersByTime(TOAST_SHOWN_MS - 1);
    expect(text()).toBe('Second.');
    vi.advanceTimersByTime(1);
    expect(host.querySelector('.toast')).toBeNull();
    box.show('Third.');
    vi.advanceTimersByTime(1_500);
    host.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(TOAST_SHOWN_MS - 1);
    expect(text()).toBe('Third.');
    vi.advanceTimersByTime(1);
    expect(host.querySelector('.toast')).toBeNull();
    box.close();
  });

  it('hides on Dismiss, and opens the work item of a message that names one', () => {
    const open = vi.fn();
    const box = toast(host, { open });

    box.show('Not done.');
    expect(host.querySelector('.toast-open')).toBeNull();
    host.querySelector<HTMLElement>('[data-action="toast-dismiss"]')!.click();
    expect(host.querySelector('.toast')).toBeNull();
    expect(open).not.toHaveBeenCalled();

    box.show('gh 7 asks for permission.', 'info', 7);
    host.querySelector<HTMLElement>('.toast-open')!.click();
    expect(open).toHaveBeenCalledWith(7);
    expect(host.querySelector('.toast')).toBeNull();
    box.close();
  });

  it("routes showToast and clearToast to the page's toast while it is open, and to nothing after", () => {
    showToast('Before the page.');
    expect(host.querySelector('.toast')).toBeNull();

    const box = toast(host, { open: () => undefined });

    showToast("Can't reach Switchboard. Try again.");
    expect(box.current()).toEqual({ text: "Can't reach Switchboard. Try again.", tone: 'warning', workItemId: null });
    showToast('Copied Reply.', 'info');
    clearToast('warning');
    expect(text()).toBe('Copied Reply.');
    clearToast();
    expect(host.querySelector('.toast')).toBeNull();
    box.close();
    showToast('After the page.');
    expect(host.querySelector('.toast')).toBeNull();
    // A closed toast's time stops with it.
    expect(vi.getTimerCount()).toBe(0);
  });
});
