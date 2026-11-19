// Loads extension/background.js in Node with a fake `chrome` API, for tests.
// Usage: const bg = require('./chrome-shim')(); await bg.send({ type: 'toolPrompt' });
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = function load(initial = {}) {
  const store = { ...initial };
  let listener = null;
  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (keys == null) return { ...store };
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]);
          return out;
        },
        set: async (o) => { Object.assign(store, structuredClone(o)); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
      },
    },
    runtime: { onMessage: { addListener: (f) => { listener = f; } }, openOptionsPage() {} },
    action: { onClicked: { addListener() {} } },
  };
  const ctx = vm.createContext({ chrome, fetch, AbortSignal, console, setTimeout, clearTimeout, crypto, TextEncoder, structuredClone, URL });
  const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'background.js' });
  return {
    store,
    send: (msg) => new Promise((resolve) => { if (!listener(msg, {}, resolve)) resolve(undefined); }),
  };
};
