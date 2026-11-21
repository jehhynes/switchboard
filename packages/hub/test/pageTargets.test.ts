import { describe, expect, it } from 'vitest';
import { PageTargets } from '../src/pageTargets.js';

describe('PageTargets', () => {
  it('picks the installed page used last, and none while only browser tabs are open', () => {
    const pages = new PageTargets();

    pages.opened('tab', false);
    expect(pages.installed()).toBeNull();
    pages.opened('app1', true);
    pages.opened('app2', true);
    expect(pages.installed()).toBe('app2');
    pages.focused('app1');
    expect(pages.installed()).toBe('app1');
    // A tab gaining focus does not take over from the installed app.
    pages.focused('tab');
    expect(pages.installed()).toBe('app1');
    pages.closed('app1');
    expect(pages.installed()).toBe('app2');
    pages.focused('gone');
    pages.closed('app2');
    expect(pages.installed()).toBeNull();
  });
});
