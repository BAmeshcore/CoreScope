// Airtime Calculator — LoRa time on air for MeshCore radio settings.
// Every input lives in the hash (#/tools/airtime?sf=10&bw=250&cr=5&len=255&dc=50),
// so a link restores the exact calculation. No API calls.
// IIFE; exports window.AirtimeCalc for testability.
(function () {
  'use strict';

  var BANDWIDTHS = [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500];
  // The firmware's repeater build defaults (examples/simple_repeater/MyMesh.cpp),
  // MAX_TRANS_UNIT (MeshCore.h) and the default `set dutycycle`.
  var DEFAULTS = { sf: 10, bw: 250, cr: 5, len: 255, dc: 50 };
  var LIMITS = { sf: [5, 12], cr: [5, 8], len: [1, 255], dc: [1, 100] };
  var HOUR_MS = 3600000; // Dispatcher::getDutyCycleWindowMs()

  var container = null;

  // RadioLib's SX126x calculateTimeOnAir, in integer microseconds like the
  // driver, with what MeshCore configures: explicit header, CRC on,
  // preambleLengthForSF() (32 symbols at SF8 and below, else 16) and RadioLib's
  // automatic low data rate optimisation (symbols of 16 ms or more).
  function timeOnAir(p) {
    var sf = p.sf, cr = p.cr;
    var symbolUs = Math.floor((10000 * Math.pow(2, sf)) / (p.bw * 10));
    var ldro = Math.pow(2, sf) / p.bw >= 16;
    var preamble = sf <= 8 ? 32 : 16;
    var lowSf = sf === 5 || sf === 6;
    var syncX4 = lowSf ? 25 : 17;
    var bits = Math.max(0, 8 * p.len + 16 - 4 * sf + (lowSf ? 0 : 8) + 20);
    var blocks = Math.ceil(bits / (4 * (ldro ? sf - 2 : sf)));
    var headerX4 = (preamble + 8) * 4 + syncX4;
    var totalUs = Math.floor((symbolUs * (headerX4 + blocks * cr * 4)) / 4);
    // The split the firmware's calcMaxPacketMillis uses: preamble, sync word,
    // SFD and header, then everything after.
    var headerUs = Math.floor((headerX4 * symbolUs) / 4);
    return {
      symbolUs: symbolUs, preambleSymbols: preamble, ldro: ldro,
      totalUs: totalUs, headerUs: headerUs, payloadUs: totalUs - headerUs
    };
  }

  // The firmware's TX budget is dutycycle percent of a one-hour window, and
  // after each send it stays quiet for about airtime * (100 / dutycycle - 1).
  function dutyCycle(totalUs, dc) {
    return {
      packetsPerHour: Math.floor((HOUR_MS * 1000 * dc) / 100 / totalUs),
      waitMs: (totalUs / 1000) * (100 / dc - 1)
    };
  }

  function intIn(raw, range) {
    if (!/^\d+$/.test(raw || '')) return null;
    var n = Number(raw);
    return n >= range[0] && n <= range[1] ? n : null;
  }

  function parseParams(query) {
    var sp = new URLSearchParams(query || '');
    var out = {};
    ['sf', 'cr', 'len', 'dc'].forEach(function (k) {
      var n = intIn(sp.get(k), LIMITS[k]);
      out[k] = n == null ? DEFAULTS[k] : n;
    });
    var bw = Number(sp.get('bw'));
    out.bw = BANDWIDTHS.indexOf(bw) >= 0 ? bw : DEFAULTS.bw;
    return { sf: out.sf, bw: out.bw, cr: out.cr, len: out.len, dc: out.dc };
  }

  function toQuery(p) {
    return 'sf=' + p.sf + '&bw=' + p.bw + '&cr=' + p.cr + '&len=' + p.len + '&dc=' + p.dc;
  }

  function group(s) {
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function formatMs(ms) {
    return ms >= 10000 ? (ms / 1000).toFixed(1) + ' s' : group(ms.toFixed(1)) + ' ms';
  }

  function options(values, selected, label) {
    return values.map(function (v) {
      return '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + label(v) + '</option>';
    }).join('');
  }

  function range(lo, hi) {
    var out = [];
    for (var i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  function field(id, label, control) {
    return '<label class="airtime-field" for="' + id + '"><span>' + label + '</span>' + control + '</label>';
  }

  function fact(label, id) {
    return '<div><dt id="' + id + '-label">' + label + '</dt><dd id="' + id + '"></dd></div>';
  }

  function render(p) {
    return '<div class="airtime-page">' +
      '<h2>Airtime Calculator</h2>' +
      '<p class="help-text">How long one packet holds the channel at given radio settings, and how many the duty-cycle budget allows per hour. Every value is in the link.</p>' +
      '<div class="airtime-layout">' +
        '<form class="airtime-form" id="airtime-form">' +
          field('airtime-sf', 'Spreading factor', '<select id="airtime-sf" name="sf">' + options(range(5, 12), p.sf, function (v) { return 'SF' + v; }) + '</select>') +
          field('airtime-bw', 'Bandwidth', '<select id="airtime-bw" name="bw">' + options(BANDWIDTHS, p.bw, function (v) { return v + ' kHz'; }) + '</select>') +
          field('airtime-cr', 'Coding rate', '<select id="airtime-cr" name="cr">' + options(range(5, 8), p.cr, function (v) { return '4/' + v; }) + '</select>') +
          field('airtime-len', 'Packet length (bytes)',
            '<div class="airtime-len-row"><input type="range" id="airtime-len-range" min="1" max="255" value="' + p.len + '" aria-label="Packet length slider">' +
            '<input type="number" id="airtime-len" name="len" min="1" max="255" value="' + p.len + '"></div>') +
          field('airtime-dc', 'Duty cycle (%)', '<input type="number" id="airtime-dc" name="dc" min="1" max="100" value="' + p.dc + '">') +
        '</form>' +
        '<section class="airtime-result" aria-live="polite">' +
          '<div class="airtime-total"><span id="airtime-total"></span><span class="airtime-total-label">on air per packet</span></div>' +
          '<div class="airtime-bar" id="airtime-bar" role="img"><span class="airtime-bar-header" id="airtime-bar-header"></span><span class="airtime-bar-payload"></span></div>' +
          '<div class="airtime-legend">' +
            '<span><i class="airtime-swatch airtime-swatch-header"></i>Preamble and header <b id="airtime-header-ms"></b></span>' +
            '<span><i class="airtime-swatch airtime-swatch-payload"></i>Payload and CRC <b id="airtime-payload-ms"></b></span>' +
          '</div>' +
          '<dl class="airtime-facts">' +
            fact('Symbol time', 'airtime-symbol') +
            fact('Preamble', 'airtime-preamble') +
            fact('Low data rate optimisation', 'airtime-ldro') +
            fact('Effective bitrate', 'airtime-bitrate') +
            fact('Packets per hour', 'airtime-pph') +
            fact('Quiet time after each send', 'airtime-wait') +
          '</dl>' +
          '<button type="button" class="btn-secondary" id="airtime-copy"><svg class="ph-icon" aria-hidden="true"><use href="/icons/phosphor-sprite.svg#ph-link"/></svg> <span>Copy link</span></button>' +
        '</section>' +
      '</div>' +
      '<p class="help-text airtime-notes">Same math as the firmware: RadioLib\'s SX126x time-on-air formula with an explicit header and CRC, MeshCore\'s preamble (32 symbols at SF8 and below, otherwise 16), and low data rate optimisation once a symbol lasts 16 ms. Packets per hour is the firmware\'s TX budget, <code>set dutycycle</code> percent of one hour, divided by the airtime. A flooded packet costs this once per repeater that relays it.</p>' +
    '</div>';
  }

  function $(id) { return document.getElementById(id); }

  function readForm() {
    return parseParams(toQuery({
      sf: $('airtime-sf').value, bw: $('airtime-bw').value, cr: $('airtime-cr').value,
      len: $('airtime-len').value, dc: $('airtime-dc').value
    }));
  }

  function show(p) {
    var t = timeOnAir(p);
    var d = dutyCycle(t.totalUs, p.dc);
    var headerPct = (t.headerUs / t.totalUs) * 100;
    $('airtime-total').textContent = formatMs(t.totalUs / 1000);
    $('airtime-bar-header').style.width = headerPct.toFixed(1) + '%';
    $('airtime-bar').setAttribute('aria-label', Math.round(headerPct) + '% preamble and header, ' + Math.round(100 - headerPct) + '% payload');
    $('airtime-header-ms').textContent = formatMs(t.headerUs / 1000);
    $('airtime-payload-ms').textContent = formatMs(t.payloadUs / 1000);
    $('airtime-symbol').textContent = (t.symbolUs / 1000).toFixed(3) + ' ms';
    $('airtime-preamble').textContent = t.preambleSymbols + ' symbols';
    $('airtime-ldro').textContent = t.ldro ? 'On' : 'Off';
    $('airtime-bitrate').textContent = group(String(Math.round((p.len * 8 * 1e6) / t.totalUs))) + ' bit/s';
    $('airtime-pph-label').textContent = 'Packets per hour at ' + p.dc + '%';
    $('airtime-pph').textContent = group(String(d.packetsPerHour));
    $('airtime-wait').textContent = d.waitMs > 0 ? formatMs(d.waitMs) : 'None';
  }

  function syncUrl() {
    var base = '#/tools/airtime';
    if (container && location.hash.indexOf(base) === 0) {
      history.replaceState(null, '', base + '?' + toQuery(readForm()));
    }
  }

  function init(app) {
    container = app;
    var p = parseParams(location.hash.split('?')[1] || '');
    container.innerHTML = render(p);
    show(p);

    // Results follow every keystroke; the URL follows once input settles,
    // since browsers throttle rapid replaceState calls (a dragged slider).
    var syncLater = typeof debounce === 'function' ? debounce(syncUrl, 250) : syncUrl;
    var lenRange = $('airtime-len-range');
    var lenInput = $('airtime-len');
    $('airtime-form').addEventListener('input', function (e) {
      if (e.target === lenRange) lenInput.value = lenRange.value;
      else if (e.target === lenInput && intIn(lenInput.value, LIMITS.len) != null) lenRange.value = lenInput.value;
      show(readForm());
      syncLater();
    });
    $('airtime-form').addEventListener('submit', function (e) { e.preventDefault(); });

    var copyBtn = $('airtime-copy');
    copyBtn.addEventListener('click', function () {
      syncUrl();
      var label = copyBtn.querySelector('span');
      var done = function (text) {
        label.textContent = text;
        setTimeout(function () { label.textContent = 'Copy link'; }, 1500);
      };
      window.copyToClipboard(location.href, function () { done('Copied'); }, function () { done('Copy failed'); });
    });
  }

  function destroy() {
    container = null;
  }

  window.AirtimeCalc = {
    init: init, destroy: destroy, timeOnAir: timeOnAir, dutyCycle: dutyCycle,
    parseParams: parseParams, toQuery: toQuery, formatMs: formatMs
  };
  if (typeof registerPage === 'function') registerPage('airtime', { init: init, destroy: destroy });
})();
