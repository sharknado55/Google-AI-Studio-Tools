// Tests for compression, retrieve, skills and project memory.
module.exports = (bg, check, assert) => async () => {
  let id = '';
  await check('large result is shortened and stored', async () => {
    const r = await bg.send({ type: 'call', server: 'fake', tool: 'big', args: { lines: 3000 } });
    assert.ok(r.ok, r.error);
    const m = /Full result id "([0-9a-f]{8})"/.exec(r.text);
    assert.ok(m, 'no result id in: ' + r.text.slice(-300));
    id = m[1];
    assert.ok(r.text.length < 7000, `still ${r.text.length} chars`);
    assert.ok(/ERROR line \d+: disk full/.test(r.text), 'important lines kept');
    assert.ok(bg.store.results[id].text.length > 90000, 'full text stored');
  });

  await check('small result is not shortened', async () => {
    const r = await bg.send({ type: 'call', server: 'fake', tool: 'echo', args: { text: 'short' } });
    assert.equal(r.text, 'short');
  });

  await check('_meta.retrieve by query', async () => {
    const r = await bg.send({ type: 'meta', tool: 'retrieve', args: { id, query: 'disk' } });
    assert.ok(r.ok && /^60 matching lines/.test(r.text), r.text || r.error);
  });

  await check('_meta.retrieve by offset', async () => {
    const r = await bg.send({ type: 'meta', tool: 'retrieve', args: { id, offset: 0, length: 100 } });
    assert.ok(r.ok && /characters 0-100 of \d+; next offset 100/.test(r.text), r.text || r.error);
  });

  await check('_meta.retrieve unknown id fails cleanly', async () => {
    const r = await bg.send({ type: 'meta', tool: 'retrieve', args: { id: 'nope' } });
    assert.ok(!r.ok && /No stored result/.test(r.error));
  });

  await check('compression can be turned off', async () => {
    bg.store.settings = { compressChars: 0 };
    const r = await bg.send({ type: 'call', server: 'fake', tool: 'big', args: { lines: 3000 } });
    delete bg.store.settings;
    assert.ok(!/Full result id/.test(r.text) && r.text.length > 90000);
  });

  await check('JSON result is minified first', async () => {
    const big = JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ id: i, ok: true })) }, null, 4);
    bg.store.settings = { compressChars: big.length - 10 };
    // squeeze is internal: run it through retrieve-free path by calling compress via a stored tool result
    const r = await bg.send({ type: 'call', server: 'fake', tool: 'echo', args: { text: big } });
    delete bg.store.settings;
    assert.ok(r.text.startsWith('{"items":[{"id":0,"ok":true}'), r.text.slice(0, 80));
  });

  bg.store.skills = [{ name: 'pdf-report', description: 'Write a PDF report. Long tail.', body: 'Step 1: outline.' }];
  bg.store.memory = { active: 'site', projects: { default: '', site: '- uses Astro' } };

  await check('prompt lists skills and memory', async () => {
    const r = await bg.send({ type: 'toolPrompt' });
    assert.ok(r.ok, r.error);
    assert.ok(r.prompt.includes('- pdf-report: Write a PDF report.'), 'skill line');
    assert.ok(!r.prompt.includes('Step 1: outline.'), 'skill body must not be in the prompt');
    assert.ok(r.prompt.includes('Project memory for "site"') && r.prompt.includes('- uses Astro'), 'memory');
  });

  await check('_meta.skill loads the body', async () => {
    const r = await bg.send({ type: 'meta', tool: 'skill', args: { name: 'pdf-report' } });
    assert.ok(r.ok && r.text.includes('Step 1: outline.'), r.error);
  });

  await check('_meta.remember is not reachable without approval', async () => {
    const r = await bg.send({ type: 'meta', tool: 'remember', args: { text: 'x' } });
    assert.ok(!r.ok, 'meta path must refuse remember');
    assert.equal(bg.store.memory.projects.site, '- uses Astro');
  });

  await check('remember appends to the active project', async () => {
    const r = await bg.send({ type: 'remember', args: { text: 'deploys to\nNetlify' } });
    assert.ok(r.ok, r.error);
    assert.equal(bg.store.memory.projects.site, '- uses Astro\n- deploys to Netlify');
  });

  await check('prompt works with no servers', async () => {
    const saved = bg.store.config;
    bg.store.config = { servers: [] };
    const r = await bg.send({ type: 'toolPrompt' });
    bg.store.config = saved;
    assert.ok(r.ok && r.prompt.includes('No MCP tools are connected'), r.error);
  });
};

// Added with the parser and workflow fixes.
module.exports.more = (bg, check, assert) => async () => {
  await check('allowed folders are in the prompt', async () => {
    const r = await bg.send({ type: 'toolPrompt' });
    assert.ok(r.ok && r.prompt.includes('fake.list_allowed_directories: Allowed directories:\nC:/fake/root'), r.error || r.prompt.slice(-400));
    assert.ok(r.prompt.includes('on a line by themselves'), 'own-line rule');
  });
  await check('readOnlyHint is reported', async () => {
    const a = await bg.send({ type: 'readOnly', server: 'fake', tool: 'echo' });
    const b = await bg.send({ type: 'readOnly', server: 'fake', tool: 'big' });
    assert.ok(a.readOnly === true && b.readOnly === false);
  });
};

module.exports.skillFiles = (bg, check, assert) => async () => {
  bg.store.skills = [{ name: 'dataviz', description: 'Charts.', body: 'Read references/palette.md first.',
    files: { 'references/palette.md': 'blue ' + 'x'.repeat(25000), 'scripts/check.py': 'print(1)' } }];
  await check('skill body lists its reference files', async () => {
    const r = await bg.send({ type: 'meta', tool: 'skill', args: { name: 'dataviz' } });
    assert.ok(r.ok && r.text.includes('- references/palette.md (26k chars)') && r.text.includes('- scripts/check.py'), r.text || r.error);
  });
  await check('reference file opens, paged', async () => {
    const r = await bg.send({ type: 'meta', tool: 'skill', args: { name: 'dataviz', file: './references/palette.md' } });
    assert.ok(r.ok && r.text.includes('blue x') && /"offset":20000/.test(r.text), r.error);
    const r2 = await bg.send({ type: 'meta', tool: 'skill', args: { name: 'dataviz', file: 'palette.md', offset: 20000 } });
    assert.ok(r2.ok && !/read on with/.test(r2.text), r2.error);
  });
  await check('missing reference file lists the real ones', async () => {
    const r = await bg.send({ type: 'meta', tool: 'skill', args: { name: 'dataviz', file: 'nope.md' } });
    assert.ok(!r.ok && r.error.includes('references/palette.md'));
  });
  await check('prompt shows the file count', async () => {
    const r = await bg.send({ type: 'toolPrompt' });
    assert.ok(r.prompt.includes('- dataviz: Charts. [2 files]'));
  });
};
