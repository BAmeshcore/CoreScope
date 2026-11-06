#!/usr/bin/env node
/* Airtime Calculator (#/tools/airtime): a deep link restores the calculation,
 * edits update the results and the link, bad parameters fall back to the
 * defaults, and the Tools landing page links to it. Needs no fixture data.
 */
'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:13581';

let passes = 0, failures = 0;
async function step(msg, fn) {
  try { await fn(); console.log(`  ✓ ${msg}`); passes++; }
  catch (err) { console.error(`  ✗ ${msg}: ${err.message}`); failures++; }
}

async function main() {
  const requireChromium = process.env.CHROMIUM_REQUIRE === '1';
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
  } catch (err) {
    if (requireChromium) {
      console.error(`test-airtime-calc-e2e.js: HARD FAIL — Chromium unavailable: ${err.message}`);
      process.exit(1);
    }
    console.warn(`SKIP — Chromium unavailable: ${err.message}`);
    process.exit(0);
  }

  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  console.log(`\n=== airtime-calc E2E against ${BASE} ===`);

  await step('deep link restores inputs and results', async () => {
    await page.goto(`${BASE}/#/tools/airtime?sf=7&bw=62.5&cr=5&len=50&dc=10`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#airtime-total');
    assert.equal(await page.inputValue('#airtime-sf'), '7');
    assert.equal(await page.inputValue('#airtime-bw'), '62.5');
    assert.equal(await page.inputValue('#airtime-len'), '50');
    assert.equal(await page.textContent('#airtime-total'), '244.2 ms');
    assert.equal(await page.textContent('#airtime-preamble'), '32 symbols');
    assert.equal(await page.textContent('#airtime-pph-label'), 'Packets per hour at 10%');
    assert.match(await page.title(), /Airtime Calculator/);
  });

  await step('changing an input updates the results and the link', async () => {
    await page.selectOption('#airtime-sf', '12');
    assert.equal(await page.textContent('#airtime-ldro'), 'On');
    await page.waitForFunction(() => location.hash.includes('sf=12&bw=62.5'), null, { timeout: 3000 });
    assert.equal(await page.evaluate(() => location.hash), '#/tools/airtime?sf=12&bw=62.5&cr=5&len=50&dc=10');
  });

  await step('the slider and the length box stay in step', async () => {
    await page.fill('#airtime-len', '200');
    assert.equal(await page.inputValue('#airtime-len-range'), '200');
    await page.waitForFunction(() => location.hash.includes('len=200'), null, { timeout: 3000 });
  });

  await step('invalid parameters fall back to the defaults', async () => {
    await page.goto(`${BASE}/#/tools/airtime?sf=99&bw=3&len=0`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#airtime-total');
    assert.equal(await page.inputValue('#airtime-sf'), '10');
    assert.equal(await page.inputValue('#airtime-bw'), '250');
    assert.equal(await page.inputValue('#airtime-len'), '255');
    assert.equal(await page.textContent('#airtime-total'), '1,180.7 ms');
  });

  await step('Tools landing links to the calculator', async () => {
    await page.goto(`${BASE}/#/tools`, { waitUntil: 'domcontentloaded' });
    await page.click('a.tools-card[href="#/tools/airtime"]');
    await page.waitForSelector('#airtime-total');
  });

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
