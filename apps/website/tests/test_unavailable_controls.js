// Focused regression test for the unavailable Inject / Clear History controls.
//
// The project has no DOM test framework, so this loads the real apps/website/app.js
// inside Node's vm with a minimal DOM stub. It exercises the shipped logic rather
// than matching source text: init() runs, listeners are captured, and the test
// asserts that the unavailable controls stay disabled and never issue requests.
//
// Run: node apps/website/tests/test_unavailable_controls.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = path.join(__dirname, '..', 'app.js');
const APP_HTML = path.join(__dirname, '..', 'app.html');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`✅ ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`❌ ${name}\n   ${e.message}`);
  }
}

// ---------- minimal DOM ----------
function makeCtx() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop === 'canvas') return { width: 800, height: 200 };
      return () => {};
    },
    set() { return true; }
  });
}

function makeElement(id) {
  const listeners = Object.create(null);
  const el = {
    id,
    _listeners: listeners,
    disabled: false,
    hidden: false,
    checked: false,
    value: '',
    title: '',
    textContent: '',
    innerHTML: '',
    className: '',
    colSpan: 1,
    width: 800,
    height: 200,
    style: {},
    attributes: Object.create(null),
    children: [],
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; }
    },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
    removeAttribute(k) { delete el.attributes[k]; },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const arr = listeners[type];
      if (arr) listeners[type] = arr.filter(f => f !== fn);
    },
    appendChild(child) { el.children.push(child); return child; },
    removeChild(child) { el.children = el.children.filter(c => c !== child); return child; },
    remove() {},
    querySelector() { return makeElement(`${id}:child`); },
    querySelectorAll() { return []; },
    getContext() { return makeCtx(); },
    getBoundingClientRect() { return { width: 0, height: 0, top: 0, left: 0 }; },
    focus() {},
    select() {},
    click() {}, // never dispatches; the real element is disabled anyway
    dispatchEvent() { return true; },
    closest() { return null; }
  };
  return el;
}

function buildSandbox() {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const fetchCalls = [];
  let domReady = null;

  const document = {
    getElementById,
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement: tag => makeElement(`created:${tag}`),
    addEventListener(type, fn) { if (type === 'DOMContentLoaded') domReady = fn; },
    body: makeElement('body')
  };

  const sandbox = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    document,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url: String(url), method: (opts.method || 'GET').toUpperCase() });
      return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
    },
    WebSocket: class {
      constructor() { this.readyState = 0; }
      send() {}
      close() {}
    },
    Uint8Array,
    Math,
    Date,
    JSON
  };
  sandbox.window = {
    location: { protocol: 'http:', host: '127.0.0.1' },
    addEventListener() {},
    AudioContext: undefined,
    webkitAudioContext: undefined,
    SpeechRecognition: undefined,
    webkitSpeechRecognition: undefined
  };
  sandbox.globalThis = sandbox;

  return { sandbox, elements, getElementById, fetchCalls, getDomReady: () => domReady };
}

(async () => {
  const source = fs.readFileSync(APP_JS, 'utf8');
  const html = fs.readFileSync(APP_HTML, 'utf8');

  // ---------- static markup contract ----------
  check('markup ships Inject disabled', () => {
    assert(/<button[^>]*id="injectActiveAppBtn"[^>]*\bdisabled\b/.test(html), 'injectActiveAppBtn must ship disabled');
  });
  check('markup ships Clear History disabled with an explanation hook', () => {
    const btn = html.match(/<button[^>]*id="clearHistoryBtn"[^>]*>/);
    assert(btn, 'clearHistoryBtn not found');
    assert(/\bdisabled\b/.test(btn[0]), 'clearHistoryBtn must ship disabled');
    assert(/aria-describedby="clearHistoryNote"/.test(btn[0]), 'clearHistoryBtn must reference the note');
    assert(/id="clearHistoryNote"/.test(html), 'clearHistoryNote element must exist');
  });
  check('disabled styling exists', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
    assert(/\.btn:disabled/.test(css), '.btn:disabled rule missing');
  });

  // ---------- behavioural run ----------
  const h = buildSandbox();
  vm.runInNewContext(source, h.sandbox, { filename: APP_JS });
  assert(typeof h.getDomReady() === 'function', 'app.js did not register DOMContentLoaded');
  // getDomReady() returns the registered handler; call it to run init().
  await h.getDomReady()();

  const injectBtn = h.getElementById('injectActiveAppBtn');
  const clearBtn = h.getElementById('clearHistoryBtn');
  const clearNote = h.getElementById('clearHistoryNote');
  const copyBtn = h.getElementById('copyBtn');
  const sandboxBtn = h.getElementById('insertToSandboxBtn');

  check('Inject is disabled after init', () => {
    assert.strictEqual(injectBtn.disabled, true);
    assert.strictEqual(injectBtn.getAttribute('aria-disabled'), 'true');
  });
  check('Clear History is disabled after init and shows the explanation', () => {
    assert.strictEqual(clearBtn.disabled, true);
    assert.strictEqual(clearBtn.getAttribute('aria-disabled'), 'true');
    assert.strictEqual(clearNote.hidden, false);
  });
  check('init issues no POST/DELETE request', () => {
    const destructive = h.fetchCalls.filter(c => c.method === 'POST' || c.method === 'DELETE');
    assert.deepStrictEqual(destructive, []);
  });
  check('init still reads history (available read path preserved)', () => {
    assert(h.fetchCalls.some(c => c.method === 'GET' && c.url === '/api/history'), 'GET /api/history was not called');
  });

  // A real browser never fires click on a disabled control. Force the listener
  // anyway to prove the handler is also guarded and cannot reach the network.
  const before = h.fetchCalls.length;
  await (injectBtn._listeners.click || [])[0]();
  check('forced Inject click makes no request', () => {
    assert.strictEqual(h.fetchCalls.length, before);
  });
  check('forced Inject click explains the outage without internal detail', () => {
    const text = injectBtn._listeners && h.getElementById('toastContainer').children
      .map(c => (c.children || []).map(g => g.textContent).join('')).join(' | ');
    assert(/temporarily unavailable/i.test(text), `unexpected toast text: ${text}`);
    assert(!/503|stack|Error:|ECONN/i.test(text), 'toast leaks internal detail');
  });

  const beforeClear = h.fetchCalls.length;
  await (clearBtn._listeners.click || [])[0]();
  check('forced Clear History click makes no request', () => {
    assert.strictEqual(h.fetchCalls.length, beforeClear);
  });

  check('unrelated controls stay enabled', () => {
    assert.strictEqual(copyBtn.disabled, false);
    assert.strictEqual(sandboxBtn.disabled, false);
  });

  // Sandbox insertion is the available alternative to OS injection.
  sandboxBtn._listeners.click[0]();
  check('sandbox insertion still works', () => {
    assert.strictEqual(h.getElementById('slackInput').value, 'Hello from Talkity!');
  });

  const failed = results.filter(x => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => {
  console.error('Test harness error:', e);
  process.exitCode = 1;
});
