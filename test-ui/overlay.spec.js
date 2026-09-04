'use strict';
// Rendered-UI tests for the overlay.
//
// The node:test suite proves the state machine. These prove what a person
// actually sees: where the lamp sits, whether its bloom is clipped, which
// lamp is lit, what the label says, and what colour the gauge is. Every test
// here corresponds to something that was once visibly wrong.

const { test, expect } = require('@playwright/test');
const { start } = require('../src/server');

const BLOOM = 72;              // spread 12 + blur 60, in CSS px
let server;
let base;

test.beforeAll(async () => {
  const r = await start({ port: 0, staleBusyMs: 600_000, idleTtlMs: 600_000 });
  server = r.server;
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => server && server.close());

const api = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const clear = async () => {
  const snap = await (await fetch(base + '/state')).json();
  for (const s of snap.sessions) await api('/state', { session: s.session, state: 'offline' });
};

// Wait for the page's own SSE-driven render, rather than a fixed sleep.
const settled = (page, fn) => expect.poll(() => page.evaluate(fn), { timeout: 4000 });

test.beforeEach(async ({ page }) => {
  await clear();
  await page.goto(base + '/');
  await page.waitForFunction(() => document.body.dataset.state !== undefined);

  // In Electron the stage is pinned to the window's top-left; without
  // window.aitl the page centres itself instead, which would make the lamp
  // drift as content grows. Test the layout the product actually ships.
  await page.evaluate(() => document.body.classList.remove('browser'));

  // Read settled values, not frames mid-transition.
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
});

// ---------------------------------------------------------------- the lamp

test('the right lamp lights for each state', async ({ page }) => {
  for (const [state, colour] of [['busy', 'amber'], ['waiting', 'red'], ['idle', 'green']]) {
    await api('/state', { session: 'a', agent: 'claude', state });
    await settled(page, () =>
      [...document.querySelectorAll('.lamp')].filter((l) => l.classList.contains('on')).map((l) => l.dataset.color)
    ).toEqual([colour]);
  }
});

test('the most urgent agent wins the lamp', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'b', agent: 'codex', state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  await api('/state', { session: 'b', agent: 'codex', state: 'idle' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
});

// ---------------------------------------------------------------- the label

// Regression: idle clears `detail`, and the old visibility rule required a
// non-empty detail — so the label vanished on exactly one state, green.
test('every state is labelled, green included', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'idle' });
  await settled(page, () => document.querySelector('.pill')?.textContent.trim()).toBe('claudeready');

  await api('/state', { session: 'a', agent: 'claude', state: 'waiting' });
  await settled(page, () => document.querySelector('.pill')?.textContent.trim()).toBe('claudeneeds you');

  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'running Bash' });
  await settled(page, () => document.querySelector('.pill')?.textContent.trim()).toBe('clauderunning Bash');
});

test('a long status never widens the page or overflows its pill', async ({ page }) => {
  await api('/state', {
    session: 'a', agent: 'claude', state: 'busy',
    detail: 'running an extremely long command with a great many arguments indeed and then some',
  });
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(1);

  const m = await page.evaluate(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const pill = document.querySelector('.pill').getBoundingClientRect();
    return { stageW: Math.round(stage.width), pillW: Math.round(pill.width), bodyScroll: document.body.scrollWidth, bodyClient: document.body.clientWidth };
  });
  expect(m.pillW).toBeLessThanOrEqual(m.stageW);
  expect(m.bodyScroll).toBeLessThanOrEqual(m.bodyClient);
});

// ------------------------------------------------------------ layout stability

// Regression: the lamp slid sideways whenever the status text changed length,
// because the stage was shrink-wrapped around content of varying width.
test('the lamp does not move when the status text changes', async ({ page }) => {
  const box = async () => {
    const b = await page.locator('#housing').boundingBox();
    return { x: Math.round(b.x), y: Math.round(b.y) };
  };

  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'thinking' });
  await settled(page, () => document.querySelector('.pill')?.textContent).toContain('thinking');
  const before = await box();

  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'running a considerably longer command indeed' });
  await settled(page, () => document.querySelector('.pill')?.textContent).toContain('considerably');
  expect(await box()).toEqual(before);
});

test('the lamp does not move when a second agent appears', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'thinking' });
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(1);
  const before = await page.locator('#housing').boundingBox();

  await api('/state', { session: 'b', agent: 'codex', state: 'waiting', detail: 'needs approval' });
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(2);
  const after = await page.locator('#housing').boundingBox();

  expect(Math.round(after.x)).toBe(Math.round(before.x));
  expect(Math.round(after.y)).toBe(Math.round(before.y));
});

// ------------------------------------------------------------------ the bloom

// Regression, twice: the window was sized to the content, so the lamp's glow was
// sliced off at the edge into a visible box. Collapsed was the case that hid it,
// because the pills no longer filled the space below the lamp.
for (const mode of ['classic', 'collapsed', 'slim']) {
  test(`the bloom is not clipped in ${mode} mode`, async ({ page }) => {
    await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
    await settled(page, () => document.body.dataset.state).toBe('busy');

    await page.evaluate((m) => {
      document.body.classList.toggle('collapsed', m === 'collapsed');
      document.body.dataset.theme = m === 'slim' ? 'slim' : 'classic';
      if (m === 'collapsed') document.getElementById('labels').innerHTML = '';
    }, mode);

    const gap = await page.evaluate(() => {
      const s = document.getElementById('stage').getBoundingClientRect();
      const h = document.getElementById('housing').getBoundingClientRect();
      return {
        top: Math.round(h.top - s.top), bottom: Math.round(s.bottom - h.bottom),
        left: Math.round(h.left - s.left), right: Math.round(s.right - h.right),
      };
    });

    for (const [side, px] of Object.entries(gap)) {
      expect(px, `${side} clearance in ${mode} mode`).toBeGreaterThanOrEqual(BLOOM);
    }
  });
}

// ---------------------------------------------------------------- fuel gauge

test('no gauge when nothing reports fuel', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await settled(page, () => document.getElementById('fuel').classList.contains('on')).toBe(false);
});

test('the gauge fills from the bottom, in proportion', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'a', fuel: { remaining: 61, label: 'plan quota' } });
  await settled(page, () => document.getElementById('fuel').classList.contains('on')).toBe(true);

  const measure = () => page.evaluate(() => {
    const track = document.getElementById('fuel').getBoundingClientRect();
    const fill = document.querySelector('#fuel b').getBoundingClientRect();
    return {
      bottomAligned: Math.abs(track.bottom - fill.bottom) <= 1,
      ratio: fill.height / track.height,
      topGap: fill.top - track.top,
    };
  });
  await expect.poll(async () => (await measure()).ratio, { timeout: 4000 }).toBeGreaterThan(0.5);
  const g = await measure();

  expect(g.bottomAligned, 'fill is anchored to the bottom of the track').toBe(true);
  expect(g.ratio).toBeGreaterThan(0.55);
  expect(g.ratio).toBeLessThan(0.67);
  expect(g.topGap, 'an unfilled remainder is visible above').toBeGreaterThan(0);
});

// The lamp already owns red/amber/green. If the gauge used them at normal
// levels, the same three colours would carry two meanings on one small widget.
test('the gauge is neutral until it is genuinely low', async ({ page }) => {
  const fillColour = () => page.evaluate(() => getComputedStyle(document.querySelector('#fuel b')).backgroundColor);
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });

  await api('/state', { session: 'a', fuel: { remaining: 61 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('ok');
  const neutral = await fillColour();
  expect(neutral).not.toBe('rgb(52, 199, 89)');   // not the green lamp
  expect(neutral).not.toBe('rgb(255, 204, 0)');   // not the amber lamp
  expect(neutral).not.toBe('rgb(255, 59, 48)');   // not the red lamp

  await api('/state', { session: 'a', fuel: { remaining: 20 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('mid');
  await expect.poll(fillColour, { timeout: 4000 }).toBe('rgb(255, 204, 0)');

  await api('/state', { session: 'a', fuel: { remaining: 5 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('low');
  await expect.poll(fillColour, { timeout: 4000 }).toBe('rgb(255, 59, 48)');
});

// The overlay window is transparent and floats over an unknown desktop, so a
// translucent track disappeared and the gauge read as a bar of arbitrary
// length. The unfilled portion is half the information.
test('the empty part of the gauge is visible over any background', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'a', fuel: { remaining: 61 } });
  await settled(page, () => document.getElementById('fuel').classList.contains('on')).toBe(true);

  const track = await page.evaluate(() => getComputedStyle(document.getElementById('fuel')).backgroundColor);
  const image = await page.evaluate(() => getComputedStyle(document.getElementById('fuel')).backgroundImage);

  // Either an opaque colour or a gradient — never a translucent tint that the
  // desktop shows straight through.
  const alpha = track.startsWith('rgba') ? Number(track.split(',')[3]) : 1;
  const opaque = image !== 'none' || alpha === 1;
  expect(opaque, `track must not be see-through (bg: ${track}, image: ${image})`).toBe(true);

  // And it must differ from the fill, or there is nothing to read the level against.
  const fill = await page.evaluate(() => getComputedStyle(document.querySelector('#fuel b')).backgroundColor);
  expect(fill).not.toBe(track);
});

test('a fuel update does not disturb the lamp', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'waiting', detail: 'needs you' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  await api('/state', { session: 'a', fuel: { remaining: 5 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('low');
  expect(await page.evaluate(() => document.body.dataset.state)).toBe('waiting');
});

// ------------------------------------------------------------------ offline

test('with nothing connected the light goes dark and unlabelled', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  await api('/state', { session: 'a', state: 'offline' });
  await settled(page, () => document.body.dataset.state).toBe('offline');
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(0);
  await settled(page, () =>
    [...document.querySelectorAll('.lamp')].some((l) => l.classList.contains('on'))
  ).toBe(false);
});
