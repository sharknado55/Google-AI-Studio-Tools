#!/usr/bin/env node
// End-to-end check without a browser: starts the bridge with a fake MCP server,
// loads background.js with a fake chrome API, and exercises every message type.
// Usage (from the aistudio-mcp folder): node test/run.js
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const load = require('./chrome-shim');

const root = path.join(__dirname, '..');
const PORT = 3949;
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}: ${e.message}`); process.exitCode = 1; }
};

(async () => {
  const bridge = spawn(process.execPath, ['bridge/bridge.js', 'test/servers.test.json'], { cwd: root, env: { ...process.env, PORT } });
  await new Promise((r) => bridge.stdout.once('data', r));

  const bg = load({ config: { servers: [{ name: 'fake', url: `http://127.0.0.1:${PORT}/mcp/fake` }] } });

  await check('bridge rejects web page origins', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/mcp/fake`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(r.status, 403);
  });

  await check('test lists tools', async () => {
    const r = await bg.send({ type: 'test' });
    assert.ok(r.ok && /OK\s+fake: 3 tools/.test(r.text), r.text || r.error);
  });

  let prompt = '';
  await check('tool prompt builds', async () => {
    const r = await bg.send({ type: 'toolPrompt' });
    assert.ok(r.ok, r.error);
    prompt = r.prompt;
    assert.ok(prompt.includes('- fake.echo: Echo the text back.'));
  });

  await check('_meta.describe returns schema', async () => {
    const r = await bg.send({ type: 'meta', tool: 'describe', args: { server: 'fake', tool: 'echo' } });
    assert.ok(r.ok && r.text.includes('"inputSchema"'), r.error);
  });

  await check('_meta.search finds tools', async () => {
    const r = await bg.send({ type: 'meta', tool: 'search', args: { query: 'echo' } });
    assert.ok(r.ok && r.text.includes('fake.echo'), r.error);
  });

  await check('tool call runs', async () => {
    const r = await bg.send({ type: 'call', server: 'fake', tool: 'echo', args: { text: 'hi there' } });
    assert.ok(r.ok && r.text === 'hi there', JSON.stringify(r));
  });

  await check('hidden tool cannot be called', async () => {
    bg.store.config.servers[0].hideTools = ['big'];
    const r = await bg.send({ type: 'call', server: 'fake', tool: 'big', args: {} });
    delete bg.store.config.servers[0].hideTools;
    assert.ok(!r.ok && /not an available tool/.test(r.error), JSON.stringify(r));
  });

  // Feature tests, added with the mods. Each one is skipped if the feature is absent.
  const extra = require('./features')(bg, check, assert);
  await extra();
  await require('./features').more(bg, check, assert)();
  await require('./features').skillFiles(bg, check, assert)();

  bridge.kill();
  console.log(results.join('\n'));
  setTimeout(() => process.exit(), 50);
})();
