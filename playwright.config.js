'use strict';
const { defineConfig, devices } = require('@playwright/test');

// UI tests render the real overlay page in a real browser and measure it.
// The node:test suite proves the logic; this proves what the user actually sees —
// where the lamp sits, whether the bloom is clipped, what colour the gauge is.
module.exports = defineConfig({
  testDir: './test-ui',
  fullyParallel: false,        // the specs share a server on a fixed port
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 900, height: 900 },
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
