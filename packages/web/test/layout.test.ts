import { describe, expect, it, vi } from 'vitest';
import { CHAT_FIT, CHAT_MIN, chatNeed, DETAIL_MIN, fitLayout, isPhone, LAYOUT_SLACK, phoneLayout, sideWidth } from '../src/layout.js';

describe('the page layout', () => {
  it("draws the list as page.css does: the kept width, or 30% of the page between 260 and 340 px, at least 200 px and at most half the page", () => {
    expect(sideWidth(null, 768)).toBe(260);
    expect(sideWidth(null, 1024)).toBeCloseTo(307.2);
    expect(sideWidth(null, 1920)).toBe(340);
    expect(sideWidth(500, 1920)).toBe(500);
    expect(sideWidth(500, 800)).toBe(400);
    expect(sideWidth(600, 300)).toBe(200);
  });

  it('gives the open conversation the room first at the common tablet and desktop widths, portrait and landscape', () => {
    const at = (width: number): string => {
      const { list, wide } = fitLayout(width, sideWidth(null, width), null);

      return `${list ? 'list' : 'drawer'} + ${wide ? 'column' : 'tabs'}`;
    };

    expect(CHAT_FIT + DETAIL_MIN).toBe(1000);
    expect([768, 820, 1024, 1180, 1280, 1366, 1440, 1600, 1920].map((width) => [width, at(width)])).toEqual([
      [768, 'drawer + tabs'],
      [820, 'drawer + tabs'],
      [1024, 'drawer + column'],
      [1180, 'drawer + column'],
      [1280, 'drawer + column'],
      [1366, 'list + column'],
      [1440, 'list + column'],
      [1600, 'list + column'],
      [1920, 'list + column'],
    ]);
    // A phone's width has separate views, with neither column.
    expect(fitLayout(767, 260, null)).toEqual({ list: false, wide: false });
  });

  it("draws the phone's layout on every phone in either orientation, and the tablet's or the desktop's on every tablet and desktop as before", () => {
    // Screen sizes in CSS pixels, portrait first; the installed app's viewport is the screen's width in each orientation.
    const devices: [string, number, number][] = [
      ['iPhone SE', 375, 667],
      ['iPhone 13 and 14', 390, 844],
      ['iPhone 15 and 16 Pro', 393, 852],
      ['iPhone 15 Pro Max', 430, 932],
      ['iPhone 16 Pro Max', 440, 956],
      ['Galaxy S24', 360, 780],
      ['Pixel 8', 412, 915],
      ['iPad mini', 744, 1133],
      ['iPad Air 11"', 820, 1180],
      ['iPad Pro 11"', 834, 1210],
      ['iPad Pro 13"', 1032, 1376],
      ['Surface Pro', 912, 1368],
      ['Laptop', 768, 1366],
      ['Desktop', 1080, 1920],
    ];
    const at = (width: number, short: number): string => {
      const phone = phoneLayout(width, short);
      const { list, wide } = fitLayout(width, sideWidth(null, width), null, CHAT_FIT, false, phone);

      return phone ? 'phone' : `${list ? 'list' : 'drawer'} + ${wide ? 'column' : 'tabs'}`;
    };

    expect(devices.map(([name, short, long]) => [name, at(short, short), at(long, short)])).toEqual([
      ['iPhone SE', 'phone', 'phone'],
      ['iPhone 13 and 14', 'phone', 'phone'],
      ['iPhone 15 and 16 Pro', 'phone', 'phone'],
      ['iPhone 15 Pro Max', 'phone', 'phone'],
      ['iPhone 16 Pro Max', 'phone', 'phone'],
      ['Galaxy S24', 'phone', 'phone'],
      ['Pixel 8', 'phone', 'phone'],
      // The iPad mini's portrait width is under 768 px, as before.
      ['iPad mini', 'phone', 'drawer + column'],
      ['iPad Air 11"', 'drawer + tabs', 'drawer + column'],
      ['iPad Pro 11"', 'drawer + tabs', 'drawer + column'],
      ['iPad Pro 13"', 'drawer + column', 'list + column'],
      ['Surface Pro', 'drawer + tabs', 'list + column'],
      ['Laptop', 'drawer + tabs', 'list + column'],
      ['Desktop', 'drawer + column', 'list + column'],
    ]);
    // A desktop window narrowed under 768 px gets the phone's layout by its width alone, and an unknown screen counts by the width.
    expect(phoneLayout(767, 1080)).toBe(true);
    expect(phoneLayout(768, 1080)).toBe(false);
    expect(phoneLayout(844, 0)).toBe(false);
    expect(phoneLayout(844, 499)).toBe(true);
    expect(phoneLayout(844, 500)).toBe(false);
  });

  it("reads the screen's short side for isPhone, whichever way the device is turned", () => {
    const width = window.innerWidth;

    try {
      window.innerWidth = 932;
      vi.stubGlobal('screen', { width: 430, height: 932 });
      expect(isPhone()).toBe(true);
      vi.stubGlobal('screen', { width: 932, height: 430 });
      expect(isPhone()).toBe(true);
      vi.stubGlobal('screen', { width: 1366, height: 1024 });
      window.innerWidth = 1366;
      expect(isPhone()).toBe(false);
      // jsdom's screen is 0 by 0: unknown, so the width decides.
      vi.unstubAllGlobals();
      expect(isPhone()).toBe(false);
      window.innerWidth = 700;
      expect(isPhone()).toBe(true);
    } finally {
      window.innerWidth = width;
      vi.unstubAllGlobals();
    }
  });

  it("counts the list's own width: a wider list needs a wider page", () => {
    expect(fitLayout(1366, 340, null).list).toBe(true);
    expect(fitLayout(1366, 380, null).list).toBe(false);
    expect(fitLayout(1380, 380, null).list).toBe(true);
  });

  it("fits the columns to the conversation's width set on its sash, between CHAT_MIN and CHAT_FIT", () => {
    expect(chatNeed(null)).toBe(CHAT_FIT);
    expect(chatNeed(940)).toBe(CHAT_FIT);
    expect(chatNeed(500)).toBe(500);
    expect(chatNeed(CHAT_MIN - 50)).toBe(CHAT_MIN);
    // The Surface sizes, in CSS pixels, with the default 340 px list: 1368 px fits it only beside the default conversation; a conversation
    // narrowed to 400 px leaves the column 1368 - 340 - 400 px with the list shown, or brings both back on a 1180 px tablet.
    expect(fitLayout(1368, 340, null)).toEqual({ list: true, wide: true });
    expect(fitLayout(1280, 340, null)).toEqual({ list: false, wide: true });
    expect(fitLayout(1280, 340, null, chatNeed(500))).toEqual({ list: true, wide: true });
    expect(fitLayout(1100, 340, null, chatNeed(CHAT_MIN))).toEqual({ list: true, wide: true });
    expect(fitLayout(1099, 340, null, chatNeed(CHAT_MIN))).toEqual({ list: false, wide: true });
    expect(fitLayout(767, 260, null, chatNeed(CHAT_MIN))).toEqual({ list: false, wide: false });
  });

  it('keeps the list in the drawer at any width once it is collapsed, giving its room to the column', () => {
    expect(fitLayout(1920, 340, null, CHAT_FIT, true)).toEqual({ list: false, wide: true });
    expect(fitLayout(1920, 340, { list: true, wide: true }, CHAT_FIT, true)).toEqual({ list: false, wide: true });
    expect(fitLayout(767, 260, null, CHAT_FIT, true)).toEqual({ list: false, wide: false });
  });

  it('keeps a shown column until it no longer fits, and brings a hidden one back only LAYOUT_SLACK past its need', () => {
    const shown = { list: true, wide: true };
    const hidden = { list: false, wide: false };

    expect(fitLayout(1340, 340, shown)).toEqual(shown);
    expect(fitLayout(1339, 340, shown)).toEqual({ list: false, wide: true });
    expect(fitLayout(1340 + LAYOUT_SLACK - 1, 340, { list: false, wide: true })).toEqual({ list: false, wide: true });
    expect(fitLayout(1340 + LAYOUT_SLACK, 340, { list: false, wide: true })).toEqual(shown);
    expect(fitLayout(1000 + LAYOUT_SLACK - 1, 340, hidden)).toEqual(hidden);
    expect(fitLayout(1000 + LAYOUT_SLACK, 340, hidden)).toEqual({ list: false, wide: true });
    expect(fitLayout(999, 340, { list: false, wide: true })).toEqual(hidden);
  });
});
