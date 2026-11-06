// test-airtime-calc.js — vm.createContext sandbox tests for airtime-calc.js
'use strict';
const REPO_ROOT = require('path').resolve(__dirname, '..', '..');
const vm = require('vm');
const fs = require('fs');
const assert = require('assert');

const src = fs.readFileSync(REPO_ROOT + '/public/airtime-calc.js', 'utf8');

function createSandbox() {
  const sandbox = {
    window: {},
    document: { getElementById: () => null, querySelectorAll: () => [] },
    location: { hash: '#/tools/airtime' },
    history: { replaceState: () => {} },
    URLSearchParams: URLSearchParams,
    registerPage: function () {},
    debounce: fn => fn,
    console: console
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(src, vm.createContext(sandbox));
  return sandbox.window.AirtimeCalc;
}

const A = createSandbox();
// Objects from the sandbox have its prototypes; compare them as plain data.
const parse = q => Object.assign({}, A.parseParams(q));
let passes = 0;
function test(name, fn) { fn(); passes++; console.log('✓ ' + name); }

// Expected values are worked by hand from RadioLib's SX126x calculateTimeOnAir
// (the commit MeshCore pins), with MeshCore's preamble rule and CRC on.

test('timeOnAir: firmware repeater default, max packet', () => {
  // SF10 BW250 CR4/5, 255 bytes: 4096 us symbols, 16-symbol preamble,
  // ceil(2044 / 40) = 52 coded blocks, 1153 quarter-symbols.
  const r = A.timeOnAir({ sf: 10, bw: 250, cr: 5, len: 255 });
  assert.strictEqual(r.symbolUs, 4096);
  assert.strictEqual(r.preambleSymbols, 16);
  assert.strictEqual(r.ldro, false);
  assert.strictEqual(r.totalUs, 1180672);
  assert.strictEqual(r.headerUs, 115712);
  assert.strictEqual(r.payloadUs, 1180672 - 115712);
});

test('timeOnAir: SF8 and below use the 32-symbol preamble', () => {
  // SF7 BW62.5 CR4/5, 50 bytes: 2048 us symbols, ceil(416 / 28) = 15 blocks.
  const r = A.timeOnAir({ sf: 7, bw: 62.5, cr: 5, len: 50 });
  assert.strictEqual(r.preambleSymbols, 32);
  assert.strictEqual(r.symbolUs, 2048);
  assert.strictEqual(r.totalUs, 244224);
  assert.strictEqual(A.timeOnAir({ sf: 8, bw: 250, cr: 5, len: 10 }).preambleSymbols, 32);
  assert.strictEqual(A.timeOnAir({ sf: 9, bw: 250, cr: 5, len: 10 }).preambleSymbols, 16);
});

test('timeOnAir: low data rate optimisation from 16 ms symbols', () => {
  // SF12 BW125 CR4/8, 10 bytes: 32768 us symbols, so LDRO is on and the
  // divisor drops to 4 * (12 - 2): ceil(76 / 40) = 2 blocks.
  const r = A.timeOnAir({ sf: 12, bw: 125, cr: 8, len: 10 });
  assert.strictEqual(r.ldro, true);
  assert.strictEqual(r.totalUs, 1449984);
  assert.strictEqual(A.timeOnAir({ sf: 11, bw: 125, cr: 5, len: 10 }).ldro, true);  // 16.384 ms
  assert.strictEqual(A.timeOnAir({ sf: 11, bw: 250, cr: 5, len: 10 }).ldro, false); // 8.192 ms
});

test('timeOnAir: SF5 and SF6 use the SX126x coefficients', () => {
  // SF5 BW500 CR4/5, 20 bytes: 6.25-symbol sync, no +8 term, ceil(176 / 20) = 9.
  assert.strictEqual(A.timeOnAir({ sf: 5, bw: 500, cr: 5, len: 20 }).totalUs, 5840);
});

test('timeOnAir: grows with coding rate and length', () => {
  const base = { sf: 10, bw: 250, cr: 5, len: 100 };
  assert.ok(A.timeOnAir(Object.assign({}, base, { cr: 8 })).totalUs > A.timeOnAir(base).totalUs);
  assert.ok(A.timeOnAir(Object.assign({}, base, { len: 101 })).totalUs >= A.timeOnAir(base).totalUs);
});

test('dutyCycle: hourly budget and wait after each send', () => {
  // Firmware: 1 h window, budget = window * dutycycle / 100.
  const d = A.dutyCycle(1180672, 50);
  assert.strictEqual(d.packetsPerHour, 1524);
  assert.strictEqual(Math.round(d.waitMs), 1181);
  const ten = A.dutyCycle(1180672, 10);
  assert.strictEqual(ten.packetsPerHour, 304);
  assert.strictEqual(Math.round(ten.waitMs), 10626);
  assert.strictEqual(A.dutyCycle(1180672, 100).waitMs, 0);
});

test('parseParams: defaults are the firmware repeater build', () => {
  assert.deepStrictEqual(parse(''), { sf: 10, bw: 250, cr: 5, len: 255, dc: 50 });
});

test('parseParams: reads a deep link', () => {
  assert.deepStrictEqual(parse('sf=7&bw=62.5&cr=8&len=40&dc=10'),
    { sf: 7, bw: 62.5, cr: 8, len: 40, dc: 10 });
});

test('parseParams: out-of-range values fall back one by one', () => {
  assert.deepStrictEqual(parse('sf=13&bw=100&cr=4&len=256&dc=0'), parse(''));
  assert.deepStrictEqual(parse('sf=7.5&len=abc&dc=101'), parse(''));
  assert.strictEqual(A.parseParams('sf=12&bw=nope').sf, 12);
});

test('toQuery: canonical order round-trips', () => {
  const q = A.toQuery({ sf: 7, bw: 62.5, cr: 5, len: 50, dc: 10 });
  assert.strictEqual(q, 'sf=7&bw=62.5&cr=5&len=50&dc=10');
  assert.deepStrictEqual(parse(q), { sf: 7, bw: 62.5, cr: 5, len: 50, dc: 10 });
});

test('formatMs: thousands separator, seconds past 10 s', () => {
  assert.strictEqual(A.formatMs(1180.672), '1,180.7 ms');
  assert.strictEqual(A.formatMs(5.84), '5.8 ms');
  assert.strictEqual(A.formatMs(10626.048), '10.6 s');
});

test('module registers the tools page', () => {
  let name = null;
  const sb = {
    window: {}, document: {}, location: { hash: '' }, history: {},
    URLSearchParams, debounce: fn => fn, console,
    registerPage: n => { name = n; }
  };
  vm.runInContext(src, vm.createContext(sb));
  assert.strictEqual(name, 'airtime');
});

console.log('\nAll ' + passes + ' airtime-calc tests passed!');
