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

  it('alerts on the installed page for auto, on any page for web, and never for dock or system, only from pages that may show notifications', () => {
    const pages = new PageTargets();

    expect(pages.alerting('auto')).toBeNull();
    expect(pages.alerting('web')).toBeNull();
    pages.opened('tab1', false);
    pages.opened('tab2', false);
    // Without notifications a page cannot alert.
    expect(pages.alerting('web')).toBeNull();
    pages.notifies('tab1', true);
    pages.notifies('tab2', true);
    pages.focused('tab1');
    expect(pages.alerting('auto')).toBeNull();
    expect(pages.alerting('web')).toBe('tab1');
    pages.opened('app', true);
    pages.focused('tab2');
    expect(pages.alerting('auto')).toBeNull();
    expect(pages.alerting('web')).toBe('tab2');
    pages.notifies('app', true);
    expect(pages.alerting('auto')).toBe('app');
    expect(pages.alerting('web')).toBe('app');
    expect(pages.alerting('dock')).toBeNull();
    expect(pages.alerting('system')).toBeNull();
  });
});
