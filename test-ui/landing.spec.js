'use strict';
// Rendered tests for the GitHub Pages landing page.
//
// The thing most likely to break here is the second theme: a colour defined only
// inside a media query renders one theme's text on the other theme's ground, and
// nothing but a real browser catches it.

const { test, expect } = require('@playwright/test');
const path = require('path');

const PAGE = 'file://' + path.resolve(__dirname, '..', 'docs', 'index.html').replace(/\\/g, '/');

// Relative luminance, so contrast can be asserted rather than eyeballed.
const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number);
const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

for (const scheme of ['light', 'dark']) {
  test(`body text is legible in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(PAGE);

    const c = await page.evaluate(() => {
      const b = getComputedStyle(document.body);
      const lede = getComputedStyle(document.querySelector('.lede'));
      return { bg: b.backgroundColor, fg: b.color, muted: lede.color };
    });

    expect(c.bg, 'body must paint its own background, never transparent')
      .not.toMatch(/rgba\(0, 0, 0, 0\)/);
    expect(contrast(c.fg, c.bg), 'body text against the ground').toBeGreaterThan(7);
    expect(contrast(c.muted, c.bg), 'muted text against the ground').toBeGreaterThan(4.5);
  });
}

test('the theme toggle flips the page and survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(PAGE);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  const started = await bg();
  await page.click('#theme');
  const flipped = await bg();
  expect(flipped).not.toBe(started);

  // The explicit choice must beat the OS preference, and persist.
  await page.reload();
  expect(await bg()).toBe(flipped);
});

test('an explicit light choice beats a dark system preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(PAGE);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  const c = await page.evaluate(() => {
    const b = getComputedStyle(document.body);
    return { bg: b.backgroundColor, fg: b.color };
  });
  expect(lum(rgb(c.bg)), 'ground should be light').toBeGreaterThan(0.7);
  expect(contrast(c.fg, c.bg)).toBeGreaterThan(7);
});

test('the page never scrolls sideways, at any width', async ({ page }) => {
  for (const width of [360, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(PAGE);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test('the page is readable at rest, with the demo already running', async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.pill')).toBeVisible();
  await expect(page.getByText('npm install -g signalhead')).toBeVisible();

  // One lamp is lit from the first frame — a dark widget would look broken in a
  // screenshot or a link preview.
  const lit = await page.evaluate(() =>
    [...document.querySelectorAll('.lamp')].filter((l) => l.classList.contains('on')).length
  );
  expect(lit).toBe(1);
});

test('the status pill carries a dot, the agent and its status', async ({ page }) => {
  await page.goto(PAGE);
  await expect(page.locator('.pill .who')).toHaveText('claude');
  await expect(page.locator('.pill .dot')).toBeVisible();
  await expect(page.locator('.pill .what')).not.toBeEmpty();
});
