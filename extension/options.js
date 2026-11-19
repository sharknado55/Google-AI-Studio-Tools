const $ = (id) => document.getElementById(id);
const BRIDGE_ORIGINS = ['http://127.0.0.1:3939', 'http://localhost:3939'];

const DEFAULT_CONFIG = {
  servers: [
    { name: 'files', url: 'http://127.0.0.1:3939/mcp/files' },
    { name: 'example-remote', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer YOUR_TOKEN' }, enabled: false },
  ],
};

const out = (text) => { $('out').textContent = text; };

function parseConfig() {
  const cfg = JSON.parse($('cfg').value);
  if (!Array.isArray(cfg.servers)) throw new Error('"servers" must be a list.');
  for (const s of cfg.servers) {
    if (!/^[\w-]+$/.test(s.name || '')) throw new Error(`Invalid server name: ${JSON.stringify(s.name)}`);
    if (!/^https?:\/\//.test(s.url || '')) throw new Error(`Server "${s.name}" needs an http(s) URL.`);
  }
  return cfg;
}

function renderAuto(map) {
  const box = $('auto');
  box.textContent = '';
  const ids = Object.keys(map);
  if (!ids.length) {
    box.textContent = 'No tools are always allowed yet.';
    return;
  }
  for (const id of ids) {
    const row = document.createElement('div');
    row.className = 'tool';
    const name = document.createElement('code');
    name.textContent = id;
    const btn = document.createElement('button');
    btn.textContent = 'Ask again';
    btn.onclick = async () => {
      delete map[id];
      await chrome.storage.local.set({ autoApprove: map });
      renderAuto(map);
    };
    row.append(name, btn);
    box.append(row);
  }
}

async function load() {
  const { config, autoApprove } = await chrome.storage.local.get(['config', 'autoApprove']);
  $('cfg').value = JSON.stringify(config || DEFAULT_CONFIG, null, 2);
  renderAuto(autoApprove || {});
}

$('save').onclick = async () => {
  try {
    const cfg = parseConfig();
    const origins = [...new Set(
      cfg.servers.map((s) => new URL(s.url).origin).filter((o) => !BRIDGE_ORIGINS.includes(o)).map((o) => o + '/*')
    )];
    if (origins.length && !(await chrome.permissions.request({ origins }))) {
      throw new Error('Chrome needs access to the server addresses. Save again and choose Allow.');
    }
    await chrome.storage.local.set({ config: cfg });
    out('Saved.');
  } catch (e) {
    out('Not saved: ' + e.message);
  }
};

$('test').onclick = async () => {
  out('Connecting…');
  const r = await chrome.runtime.sendMessage({ type: 'test' });
  out(r && r.ok ? r.text : 'Test failed: ' + ((r && r.error) || 'no response'));
};

/* ---------------- behaviour ---------------- */

const out2 = (text) => { $('out2').textContent = text; };

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  $('autoSend').checked = !!settings.autoSend;
  $('compressChars').value = settings.compressChars ?? 6000;
  $('fastScroll').checked = settings.fastScroll !== false;
  $('autoReadOnly').checked = !!settings.autoReadOnly;
  $('autoAll').checked = !!settings.autoAll;
}

$('autoAll').onchange = (e) => {
  if (e.target.checked && !confirm('Run every tool call without asking, including writes, deletes and code execution? Remember to press Save behaviour.')) {
    e.target.checked = false;
  }
};

$('saveSettings').onclick = async () => {
  const n = Math.max(0, Number($('compressChars').value) || 0);
  await chrome.storage.local.set({ settings: { autoSend: $('autoSend').checked, compressChars: n, fastScroll: $('fastScroll').checked, autoReadOnly: $('autoReadOnly').checked, autoAll: $('autoAll').checked } });
  out2('Behaviour saved.');
};

/* ---------------- skills ---------------- */

// Reads a SKILL.md: optional "---" front matter with name and description, then the body.
function parseSkill(text, fileName) {
  let name = '', description = '', body = text;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^(name|description)\s*:\s*(.*)$/.exec(line);
      if (m) {
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1] === 'name') name = v; else description = v;
      }
    }
  }
  if (!name) name = fileName.replace(/\.md$/i, '').replace(/^SKILL$/i, 'skill');
  name = name.toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
  return { name, description, body: body.trim() };
}

async function renderSkills() {
  const { skills = [] } = await chrome.storage.local.get('skills');
  const box = $('skills');
  box.textContent = '';
  if (!skills.length) { box.textContent = 'No skills yet.'; return; }
  for (const s of skills) {
    const row = document.createElement('div');
    row.className = 'tool';
    const name = document.createElement('code');
    name.textContent = s.name;
    const desc = document.createElement('span');
    const n = Object.keys(s.files || {}).length;
    desc.textContent = (s.description ? ' ' + s.description.slice(0, 90) : ' (no description)') + (n ? ` [${n} files]` : '');
    desc.style.flex = '1';
    const btn = document.createElement('button');
    btn.textContent = 'Remove';
    btn.onclick = async () => {
      await chrome.storage.local.set({ skills: skills.filter((x) => x.name !== s.name) });
      renderSkills();
    };
    row.append(name, desc, btn);
    box.append(row);
  }
}

$('importSkills').onclick = () => $('skillFiles').click();
$('skillFiles').onchange = async (e) => {
  const { skills = [] } = await chrome.storage.local.get('skills');
  const added = [];
  for (const f of e.target.files) {
    const s = parseSkill(await f.text(), f.name);
    const i = skills.findIndex((x) => x.name === s.name);
    if (i >= 0) skills[i] = s; else skills.push(s);
    added.push(s.name);
  }
  await chrome.storage.local.set({ skills });
  e.target.value = '';
  out2(`Imported: ${added.join(', ')}. Name a file's skill with a "name:" header so files called SKILL.md do not replace each other.`);
  renderSkills();
};

// Folder import: every directory holding a SKILL.md becomes a skill; the other text
// files under it are kept as reference files, by their path relative to that directory.
const TEXT_EXT = /\.(md|markdown|txt|json|jsonc|ya?ml|toml|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|lua|luau|rb|go|rs|java|kt|cs|cpp|c|h|sh|ps1|bat|sql|ini|cfg|env\.example|rst)$/i;
const MAX_FILE = 1000000;

$('importFolder').onclick = () => $('skillFolder').click();
$('skillFolder').onchange = async (e) => {
  const all = [...e.target.files].map((f) => ({ f, path: f.webkitRelativePath.replace(/\\/g, '/') }));
  const roots = all.filter((x) => /(^|\/)SKILL\.md$/i.test(x.path)).map((x) => x.path.replace(/(^|\/)SKILL\.md$/i, ''));
  if (!roots.length) { out2('No SKILL.md found in that folder.'); e.target.value = ''; return; }
  // Deepest root first, so a file belongs to the nearest skill above it.
  roots.sort((a, b) => b.length - a.length);
  const { skills = [] } = await chrome.storage.local.get('skills');
  const added = [], skipped = [];
  for (const root of roots) {
    const prefix = root ? root + '/' : '';
    const skillMd = all.find((x) => x.path === prefix + 'SKILL.md' || x.path.toLowerCase() === (prefix + 'skill.md').toLowerCase());
    const s = parseSkill(await skillMd.f.text(), root.split('/').pop() || 'skill');
    s.files = {};
    for (const x of all) {
      if (x === skillMd || !x.path.startsWith(prefix)) continue;
      if (roots.some((r) => r !== root && r.length > root.length && x.path.startsWith(r + '/'))) continue; // nested skill
      const rel = x.path.slice(prefix.length);
      if (rel.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) continue;
      if (!TEXT_EXT.test(rel) || x.f.size > MAX_FILE) { skipped.push(rel); continue; }
      s.files[rel] = await x.f.text();
    }
    const i = skills.findIndex((k) => k.name === s.name);
    if (i >= 0) skills[i] = s; else skills.push(s);
    added.push(`${s.name} (${Object.keys(s.files).length} files)`);
  }
  try {
    await chrome.storage.local.set({ skills });
    out2(`Imported: ${added.join(', ')}.` + (skipped.length ? ` Skipped ${skipped.length} binary or large files.` : ''));
  } catch (err) {
    out2('Not saved: ' + err.message);
  }
  e.target.value = '';
  renderSkills();
};

/* ---------------- project memory ---------------- */

let memory = { active: 'default', projects: { default: '' } };

async function loadMemory() {
  memory = (await chrome.storage.local.get('memory')).memory || memory;
  if (!(memory.active in memory.projects)) memory.projects[memory.active] = '';
  const sel = $('project');
  sel.textContent = '';
  for (const n of Object.keys(memory.projects)) sel.append(new Option(n, n, false, n === memory.active));
  $('memText').value = memory.projects[memory.active];
}

$('project').onchange = async (e) => {
  memory.active = e.target.value;
  await chrome.storage.local.set({ memory });
  loadMemory();
};

$('newProject').onclick = async () => {
  const name = (prompt('Project name') || '').trim();
  if (!name) return;
  if (!(name in memory.projects)) memory.projects[name] = '';
  memory.active = name;
  await chrome.storage.local.set({ memory });
  loadMemory();
};

$('delProject').onclick = async () => {
  const name = memory.active;
  if (!confirm(`Delete project "${name}" and its memory? This cannot be undone.`)) return;
  delete memory.projects[name];
  if (!Object.keys(memory.projects).length) memory.projects.default = '';
  memory.active = Object.keys(memory.projects)[0];
  await chrome.storage.local.set({ memory });
  loadMemory();
};

$('saveMemory').onclick = async () => {
  memory = (await chrome.storage.local.get('memory')).memory || memory; // keep facts Gemini saved meanwhile
  memory.projects[$('project').value] = $('memText').value;
  await chrome.storage.local.set({ memory });
  out2('Memory saved.');
};

load();
loadSettings();
renderSkills();
loadMemory();
