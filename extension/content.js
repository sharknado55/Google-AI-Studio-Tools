// Runs on aistudio.google.com.
// 1. Watches Gemini's latest reply for an MCP tool call.
// 2. Shows an approval overlay. Nothing runs, and Gemini gets no result, until you decide.
// 3. Runs the tool through the background worker and posts the result as your next
//    message, so Gemini continues from there.
(() => {
  'use strict';
  if (window.__aiStudioMcp) return;
  window.__aiStudioMcp = true;

  const MAX_RESULT_CHARS = 30000;
  const POLL_MS = 500;

  // Best-effort selectors for the AI Studio page. If AI Studio changes its markup
  // and the extension stops noticing replies or submitting results, adjust these.
  const SEL = {
    turn: 'ms-chat-turn',
    modelMarker: '.model, [data-turn-role="Model"]',
    run: 'button.run-button, button[aria-label="Run"], button[aria-label="Send"]',
    code: 'pre, ms-code-block, code',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- page helpers ---------------- */

  function findInput() {
    const boxes = [...document.querySelectorAll('textarea')].filter((t) => t.offsetParent !== null);
    const labelled = boxes.find((t) => /prompt|type something|message/i.test(t.getAttribute('aria-label') || t.placeholder || ''));
    return labelled || boxes[boxes.length - 1] || null;
  }

  function setText(el, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
  }

  async function submit(input) {
    for (let i = 0; i < 15; i++) {
      const btn = document.querySelector(SEL.run);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        return;
      }
      await sleep(200);
    }
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
  }

  const MAX_CALLS = 5; // tool calls handled from one reply
  const CALL_RE = /\{\s*"mcp_call"\s*:/g;

  // JSON.parse, but also accepts raw line breaks and tabs inside strings, so the model
  // can write multi-line code in an argument without escaping every newline.
  function looseParse(s) {
    try { return JSON.parse(s); } catch {}
    let out = '', inStr = false, esc = false;
    for (const c of s) {
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        else if (c === '\n') { out += '\\n'; continue; }
        else if (c === '\r') continue;
        else if (c === '\t') { out += '\\t'; continue; }
      } else if (c === '"') inStr = true;
      out += c;
    }
    return JSON.parse(out);
  }

  // Finds every {"mcp_call":{"server":..,"tool":..,"arguments":{..}}} in some text.
  // Returns { calls, errors, partial } where partial means a call is still streaming.
  function scanCalls(text) {
    const calls = [], errors = [];
    let partial = false;
    for (const m of text.matchAll(CALL_RE)) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = m.index; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { end = i; break; }
      }
      if (end < 0) { partial = true; continue; }
      try {
        const o = looseParse(text.slice(m.index, end + 1)).mcp_call;
        if (o && o.server === 'SERVER') continue; // the format example
        if (o && typeof o.server === 'string' && typeof o.tool === 'string') {
          calls.push({ server: o.server, tool: o.tool, args: o.arguments || {} });
        } else errors.push('the JSON needs "server" and "tool" strings inside "mcp_call"');
      } catch (e) {
        errors.push('the JSON is not valid (' + e.message + ')');
      }
    }
    return { calls, errors, partial };
  }

  // Reads tool calls from the newest reply.
  // Calls are read ONLY from rendered code blocks: inside a code block the text is exactly
  // what the model wrote. Outside one, Markdown has already removed _, * and \ characters,
  // which silently breaks code in the arguments. A call written as plain text is reported
  // back to the model as a format error instead of being run.
  // Returns null, { calls: [...] } or { bad: 'reason' }.
  function extractCall(s) {
    if (!/"mcp_call"/.test(s.text)) return null;
    const blocks = s.el ? [...s.el.querySelectorAll(SEL.code)] : [];
    const outer = blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b)));
    const codeText = outer.map((b) => b.textContent || '').filter((t) => /"mcp_call"/.test(t)).join('\n');
    if (codeText) {
      const r = scanCalls(codeText);
      if (r.partial) return null;
      if (r.calls.length) return { calls: r.calls.slice(0, MAX_CALLS), extra: Math.max(0, r.calls.length - MAX_CALLS) };
      return r.errors.length ? { bad: r.errors[0] } : null;
    }
    // A call in plain text. Example calls in the middle of an explanation are ignored;
    // one near the end of the reply was most likely meant to run.
    const at = s.text.search(/\{\s*"mcp_call"\s*:/);
    if (at < 0 || at < s.text.length - 4000) return null;
    if (!document.querySelector(SEL.code)) {
      // This page shows no code blocks at all, so the selectors may be out of date:
      // fall back to reading the plain text, as version 0.1 did.
      const r = scanCalls(s.text);
      if (r.partial) return null;
      return r.calls.length ? { calls: r.calls.slice(0, MAX_CALLS), extra: 0 } : null;
    }
    const r = scanCalls(s.text);
    if (r.partial || !r.calls.length) return null;
    return { bad: 'the call was not inside an mcp-call code block, so the page rendered it as text and characters such as _ * and \\ may have been removed' };
  }

  // Compaction: the model writes a summary between these two lines.
  const SUM_START = '=== COMPACT SUMMARY START ===';
  const SUM_END = '=== COMPACT SUMMARY END ===';
  const COMPACT_PROMPT = [
    'Summarize this whole conversation so the work can continue in a new chat that will not see this one.',
    'Include: the goal, decisions made and why, important facts, file paths, names, code or values that must not be lost,',
    'tool results that still matter, open questions, and exactly what is left to do next. Be complete but compact.',
    'Do not call any tools in this reply.',
    'Write the summary between these two lines, each on its own line:',
    SUM_START,
    SUM_END,
  ].join('\n');

  function extractSummary(text) {
    const end = text.lastIndexOf(SUM_END);
    if (end < 0) return null;
    const start = text.lastIndexOf(SUM_START, end);
    if (start < 0) return null;
    const body = text.slice(start + SUM_START.length, end).trim();
    return body.length > 40 ? body : null; // ignore an echo of the two marker lines
  }

  // Identifies the first turn by element identity, so long chats are not re-read
  // every poll (reading a huge first turn twice a second adds to the lag).
  const turnIds = new WeakMap();
  let nextTurnId = 1;
  const idOf = (el) => {
    if (!turnIds.has(el)) turnIds.set(el, String(nextTurnId++));
    return turnIds.get(el);
  };

  // Reads the bits of the page the watcher needs (kept small: the first turn can be large).
  function snapshot() {
    const els = document.querySelectorAll(SEL.turn);
    let index = els.length - 1;
    while (index >= 0 && !(els[index].textContent || '').trim()) index--;
    const el = els[index];
    return {
      el,
      count: els.length,
      first: els.length ? idOf(els[0]) : '',
      index,
      text: el ? el.textContent || '' : '',
      isModel: !!el && (el.matches(SEL.modelMarker) || !!el.querySelector(SEL.modelMarker)),
    };
  }

  // Decides when a tool call (or a compact summary) in the newest reply is new and finished.
  // A call counts only if its reply was first seen WITHOUT a finished call (so it was
  // streaming live), which keeps calls in chats you merely open or scroll back to quiet.
  function makeWatcher(settleMs, extract = extractCall) {
    let convo = null, settleUntil = Date.now() + settleMs, candidate = '', stable = 0;
    const states = new Map(), done = new Set();
    return function tick(s, now = Date.now()) {
      const fp = s.count ? s.first : '';
      if (fp !== convo) {
        // Another conversation was opened (or the first message of a new one was sent).
        if (s.count > 1) settleUntil = now + settleMs;
        convo = fp; states.clear(); done.clear(); candidate = '';
      }
      if (s.index < 0 || !s.isModel) { candidate = ''; return null; }
      let st = states.get(s.index);
      if (!st) states.set(s.index, st = { armed: false });
      const call = extract(s);
      if (!call) { if (now >= settleUntil) st.armed = true; candidate = ''; return null; }
      if (!st.armed) return null;
      const key = `${s.index}:${JSON.stringify(call)}`;
      if (done.has(key)) return null;
      const sig = `${key}:${s.text.length}`; // wait until the reply stops growing
      if (candidate !== sig) { candidate = sig; stable = 0; return null; }
      // A format error waits ~3 s of no change, so a reply that pauses mid-stream is not flagged.
      if (call.bad && ++stable < 6) return null;
      done.add(key); candidate = '';
      return call;
    };
  }

  /* ---------------- overlay UI ---------------- */

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
  :host{--bg:#fbfbf9;--fg:#16191d;--mut:#5b6470;--line:#d3d8de;--ok:#0b6f69;--okfg:#fff;--hold:#b45309;--bad:#b3261e;--code:#eef0f2}
  @media (prefers-color-scheme:dark){:host{--bg:#1a1d22;--fg:#e7e9ec;--mut:#9aa3ad;--line:#363c44;--ok:#46c2b8;--okfg:#0d1a19;--hold:#f0b35a;--bad:#f2928a;--code:#12151a}}
  *{box-sizing:border-box}
  button{font:inherit;cursor:pointer}
  :focus-visible{outline:2px solid var(--ok);outline-offset:2px}
  #pill{position:fixed;right:16px;bottom:16px;pointer-events:auto;display:flex;gap:8px;align-items:center;
    font:500 12px/1 system-ui,sans-serif;color:var(--fg);background:var(--bg);border:1px solid var(--line);
    border-radius:999px;padding:8px 12px}
  #pill.hold{border-color:var(--hold)}
  #pill i{width:8px;height:8px;border-radius:50%;background:var(--mut)}
  #pill.hold i{background:var(--hold)}
  #scrim,#nscrim{position:fixed;inset:0;display:none;place-items:center;background:rgba(10,12,15,.6);pointer-events:auto}
  #scrim.on,#nscrim.on{display:grid}
  .card{width:min(580px,92vw);max-height:88vh;overflow:auto;background:var(--bg);color:var(--fg);
    border:1px solid var(--line);border-left:4px solid var(--hold);border-radius:6px;padding:22px 24px;
    font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  h2{margin:0 0 6px;font:600 20px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
  p{margin:0 0 14px;color:var(--mut);max-width:60ch}
  textarea{display:block;width:100%;height:170px;resize:vertical;background:var(--code);color:var(--fg);
    border:1px solid var(--line);border-radius:4px;padding:10px 12px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  #err{min-height:20px;margin:6px 0 0;color:var(--bad);font-size:13px}
  .row{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
  .grow{flex:1}
  .row button{border-radius:4px;padding:9px 14px;border:1px solid var(--line);background:transparent;color:var(--fg)}
  .row .primary{background:var(--ok);border-color:var(--ok);color:var(--okfg);font-weight:600}
  #deny{color:var(--mut)}
  #menu{position:fixed;right:16px;bottom:56px;pointer-events:auto;display:none;flex-direction:column;gap:4px;width:250px;
    background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:13px/1.4 system-ui,sans-serif}
  #menu.on{display:flex}
  #menu button{text-align:left;border:0;background:transparent;color:var(--fg);padding:8px 10px;border-radius:4px}
  #menu button:hover{background:var(--code)}
  #menu small{display:block;color:var(--mut);font-size:12px}
  #menu label{display:flex;gap:8px;align-items:center;padding:6px 10px;color:var(--mut)}
  #menu select{flex:1;font:inherit;background:var(--code);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:4px}
  #ncard{border-left-color:var(--ok)}
  #nbody{white-space:pre-wrap;max-height:40vh;overflow:auto;background:var(--code);border:1px solid var(--line);border-radius:4px;
    padding:10px 12px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--fg)}
</style>
<button id="pill" title="MCP tools, skills, memory and compaction" aria-haspopup="true" aria-expanded="false"><i></i><span id="label">MCP</span></button>
<div id="menu" role="menu">
  <button id="m-insert" role="menuitem">Insert tools, skills and memory<small>Adds them to the message box</small></button>
  <button id="m-compact" role="menuitem">Compact this chat<small>Asks Gemini for a summary; you press Run</small></button>
  <label>Project <select id="m-project" aria-label="Project for memory"></select></label>
</div>
<div id="nscrim"><div class="card" id="ncard" role="dialog" aria-modal="true" aria-labelledby="ntitle" tabindex="-1">
  <h2 id="ntitle"></h2>
  <p id="ntext"></p>
  <div id="nbody"></div>
  <div class="row" id="nrow"></div>
</div></div>
<div id="scrim"><div class="card" id="card" role="dialog" aria-modal="true" aria-labelledby="tool" tabindex="-1">
  <h2 id="tool"></h2>
  <p>Gemini is waiting to run this tool. Approve to send the result back so it can continue.</p>
  <textarea id="args" spellcheck="false" aria-label="Tool arguments (editable JSON)"></textarea>
  <div id="err" role="alert"></div>
  <div class="row">
    <button id="deny">Deny</button><span class="grow"></span>
    <button id="always">Always allow this tool</button>
    <button id="ok" class="primary">Approve</button>
  </div>
</div></div>`;
  document.documentElement.appendChild(host);

  const $ = (id) => root.getElementById(id);
  let statusTimer = null;

  let waitingForRun = false; // a "press Run" hint is showing
  let pillName = 'MCP'; // becomes "MCP (auto)" while every tool is allowed
  const showAutoAll = (settings = {}) => {
    pillName = settings.autoAll ? 'MCP (auto)' : 'MCP';
    if (!statusTimer && !waitingForRun) $('label').textContent = pillName;
  };
  chrome.storage.local.get('settings').then(({ settings }) => showAutoAll(settings));
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((c) => c.settings && showAutoAll(c.settings.newValue));
  }
  function setStatus(text, hold = false) {
    clearTimeout(statusTimer);
    statusTimer = null;
    waitingForRun = hold && /press Run/.test(text);
    $('label').textContent = text ? `${pillName}: ${text}` : pillName;
    $('pill').classList.toggle('hold', hold);
  }
  function flash(text, ms = 3000) {
    setStatus(text);
    statusTimer = setTimeout(() => setStatus(''), ms);
  }

  function ask(call, label = '') {
    return new Promise((resolve) => {
      // textContent: names come from the model
      $('tool').textContent = `${call.server}.${call.tool}${label ? ` (${label})` : ''}`;
      $('args').value = JSON.stringify(call.args, null, 2);
      $('err').textContent = '';
      $('scrim').classList.add('on');
      $('card').focus();
      setStatus('waiting for your approval', true);

      const finish = (ok, always) => {
        let args = call.args;
        if (ok) {
          try {
            args = JSON.parse($('args').value.trim() || '{}');
          } catch (e) {
            $('err').textContent = 'The arguments are not valid JSON: ' + e.message;
            return;
          }
        }
        $('scrim').classList.remove('on');
        $('scrim').onkeydown = null;
        resolve({ ok, always, args });
      };
      $('ok').onclick = () => finish(true, false);
      $('always').onclick = () => finish(true, true);
      $('deny').onclick = () => finish(false, false);
      $('scrim').onkeydown = (e) => e.key === 'Escape' && finish(false, false);
    });
  }

  // A small dialog with custom buttons. Resolves with the id of the button pressed.
  function notice(title, text, body, buttons) {
    return new Promise((resolve) => {
      $('ntitle').textContent = title;
      $('ntext').textContent = text;
      $('nbody').textContent = body;
      $('nbody').style.display = body ? '' : 'none';
      const row = $('nrow');
      row.textContent = '';
      const done = (id) => { $('nscrim').classList.remove('on'); $('nscrim').onkeydown = null; resolve(id); };
      buttons.forEach(([id, label, primary], i) => {
        if (i === 1) row.append(Object.assign(document.createElement('span'), { className: 'grow' }));
        const b = document.createElement('button');
        b.textContent = label;
        if (primary) b.className = 'primary';
        b.onclick = () => done(id);
        row.append(b);
      });
      $('nscrim').onkeydown = (e) => e.key === 'Escape' && done(buttons[0][0]);
      $('nscrim').classList.add('on');
      $('ncard').focus();
    });
  }

  // Fills the message box without sending. Returns false if the box was not found.
  async function fill(text, prepend = false) {
    const input = findInput();
    if (!input) {
      try { await navigator.clipboard.writeText(text); } catch {}
      return false;
    }
    setText(input, prepend && input.value ? text + '\n\n' + input.value : text);
    return true;
  }

  async function contextPrompt() {
    const r = await chrome.runtime.sendMessage({ type: 'toolPrompt' });
    if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'extension not responding');
    return r.prompt;
  }

  /* ---------------- menu ---------------- */

  const menu = $('menu');
  const toggleMenu = (on = !menu.classList.contains('on')) => {
    menu.classList.toggle('on', on);
    $('pill').setAttribute('aria-expanded', String(on));
    if (on) fillProjects();
  };
  $('pill').onclick = () => toggleMenu();
  document.addEventListener('keydown', (e) => e.key === 'Escape' && toggleMenu(false));

  async function fillProjects() {
    const { memory = { active: 'default', projects: { default: '' } } } = await chrome.storage.local.get('memory');
    const sel = $('m-project');
    sel.textContent = '';
    for (const name of Object.keys(memory.projects)) {
      sel.append(new Option(name, name, false, name === memory.active));
    }
  }
  $('m-project').onchange = async (e) => {
    const { memory = { active: 'default', projects: { default: '' } } } = await chrome.storage.local.get('memory');
    memory.active = e.target.value;
    await chrome.storage.local.set({ memory });
    flash(`project: ${memory.active} (insert again to use its memory)`, 5000);
  };

  $('m-insert').onclick = async () => {
    toggleMenu(false);
    try {
      const prompt = await contextPrompt();
      const tokens = Math.ceil(prompt.length / 4000);
      flash((await fill(prompt, true)) ? `inserted (about ${tokens}k tokens)` : 'message box not found, copied instead', 5000);
    } catch (e) {
      flash(e.message, 7000);
    }
  };

  // Compaction step 1: put the summary request in the box. The user presses Run.
  $('m-compact').onclick = async () => {
    toggleMenu(false);
    const ok = await fill(COMPACT_PROMPT);
    if (ok) setStatus('summary request ready: press Run', true);
    else flash('message box not found, summary request copied', 6000);
  };

  // Compaction step 2: Gemini replied with a summary. Offer to carry it to a new chat.
  async function onSummary(s) {
    const text = extractSummary(s.el ? s.el.innerText || '' : '') || extractSummary(s.text);
    if (!text) return;
    setStatus('');
    const choice = await notice(
      'Summary ready',
      `About ${Math.ceil(text.length / 4)} tokens. Open a new chat with this summary in the message box? Nothing is sent until you press Run.`,
      text,
      [['dismiss', 'Dismiss'], ['copy', 'Copy'], ['open', 'Open new chat', true]]
    );
    if (choice === 'copy') {
      try { await navigator.clipboard.writeText(text); flash('summary copied'); } catch (e) { flash(e.message, 6000); }
    } else if (choice === 'open') {
      await chrome.storage.local.set({ pendingCompact: { at: Date.now(), text } });
      location.assign('/prompts/new_chat');
    }
  }

  // Compaction step 3: in the new chat, fill the box with context plus the summary.
  async function resumeCompact() {
    const { pendingCompact: p } = await chrome.storage.local.get('pendingCompact');
    if (!p) return;
    await chrome.storage.local.remove('pendingCompact');
    if (Date.now() - p.at > 15 * 60000) return;
    for (let i = 0; i < 40 && !findInput(); i++) await sleep(250);
    let ctx = '';
    try { ctx = await contextPrompt(); } catch {}
    const text = [
      ctx,
      'Summary of the earlier conversation (continue from here):',
      '<summary>',
      p.text,
      '</summary>',
    ].filter(Boolean).join('\n\n');
    flash((await fill(text)) ? 'summary inserted: press Run to continue' : 'message box not found, summary copied', 8000);
  }

  /* ---------------- main flow ---------------- */

  async function reply(text) {
    if (!(await fill(text))) return flash('message box not found, result copied', 6000);
    const { settings = {} } = await chrome.storage.local.get('settings');
    if (settings.autoSend) return submit(findInput());
    setStatus('result in message box: press Run', true);
  }

  const clip = (s) => (s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + '\n[truncated]' : s);
  const wrap = (label, body, note = '') => `MCP RESULT for ${label}${note}:\n<tool_result>\n${clip(body)}\n</tool_result>`;

  const errText = (r) => `ERROR: ${(r && r.error) || 'no response from the extension'}`;
  const DENIED = 'denied';

  // Runs one call and returns the text to send back, or DENIED.
  async function runOne(call, label) {
    const id = `${call.server}.${call.tool}`;
    const { autoApprove = {}, settings = {} } = await chrome.storage.local.get(['autoApprove', 'settings']);
    if (call.server === '_meta' && call.tool === 'remember') {
      // Writes to project memory, so it needs approval like a tool call.
      const decision = settings.autoAll ? { ok: true, args: call.args } : await ask(call, label);
      if (!decision.ok) return DENIED;
      const r = await chrome.runtime.sendMessage({ type: 'remember', args: decision.args });
      return wrap(id, r && r.ok ? r.text : errText(r));
    }
    if (call.server === '_meta') {
      // Schema, search, retrieve and skill lookups execute nothing, so they need no approval.
      setStatus('looking up');
      const r = await chrome.runtime.sendMessage({ type: 'meta', tool: call.tool, args: call.args });
      return wrap(id, r && r.ok ? r.text : errText(r));
    }

    // "Allow every tool" in settings skips the approval dialog for all calls.
    let auto = !!settings.autoAll || !!autoApprove[id];
    if (!auto && settings.autoReadOnly) {
      // Tools the server itself marks read-only (MCP readOnlyHint) can skip the prompt.
      const ro = await chrome.runtime.sendMessage({ type: 'readOnly', server: call.server, tool: call.tool });
      auto = !!(ro && ro.readOnly);
    }
    const decision = auto ? { ok: true, args: call.args } : await ask(call, label);
    if (!decision.ok) return DENIED;
    if (decision.always) {
      const cur = (await chrome.storage.local.get('autoApprove')).autoApprove || {};
      await chrome.storage.local.set({ autoApprove: { ...cur, [id]: true } });
    }
    setStatus(`running ${id}`);
    const r = await chrome.runtime.sendMessage({ type: 'call', server: call.server, tool: call.tool, args: decision.args });
    return wrap(id, r && r.ok ? r.text : errText(r), r && r.isError ? ' (the tool reported an error)' : '');
  }

  async function handle(found) {
    try {
      if (found.bad) {
        // Tell the model what went wrong instead of staying silent.
        setStatus('tool call not readable', true);
        return await reply(
          `MCP FORMAT ERROR: your tool call was not run because ${found.bad}. ` +
            'Send it again: put ```mcp-call on a line by itself, the JSON on the next lines, and ``` on a line by itself after it, with nothing after the block.'
        );
      }
      const out = [];
      const { calls } = found;
      for (let i = 0; i < calls.length; i++) {
        const label = calls.length > 1 ? `call ${i + 1} of ${calls.length}` : '';
        const text = await runOne(calls[i], label);
        if (text === DENIED) {
          const id = `${calls[i].server}.${calls[i].tool}`;
          out.push(`MCP RESULT for ${id}: the user denied this call. Do not retry it; ask how they want to proceed.`);
          if (i < calls.length - 1) out.push(`The remaining ${calls.length - 1 - i} call(s) in your reply were skipped.`);
          break;
        }
        out.push(text);
      }
      if (found.extra) out.push(`Only the first ${MAX_CALLS} calls were run; ${found.extra} more were ignored. Send them in your next reply.`);
      setStatus('');
      await reply(out.join('\n\n'));
    } catch (e) {
      flash('error: ' + e.message, 7000);
    }
  }

  const watch = makeWatcher(2500);
  const watchSummary = makeWatcher(2500, (s) => extractSummary(s.text));
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    if (waitingForRun) {
      const input = findInput();
      if (input && !input.value.trim()) setStatus(''); // the user sent it
    }
    const s = snapshot();
    const call = watch(s);
    const summary = watchSummary(s);
    if (!call && !summary) return;
    busy = true;
    try { await (summary ? onSummary(s) : handle(call)); } finally { busy = false; }
  }, POLL_MS);

  resumeCompact();

  // Speed up long chats: the browser skips layout and painting of turns that are
  // off screen. Local rendering only; nothing is sent anywhere. Turn off in settings.
  const fast = document.createElement('style');
  fast.textContent = `${SEL.turn}{content-visibility:auto;contain-intrinsic-size:auto 400px}`;
  chrome.storage.local.get('settings').then(({ settings = {} }) => {
    if (settings.fastScroll !== false) document.head.append(fast);
  });

  // Test hook: exposes the pure helpers on the mock page only (never on aistudio.google.com).
  if (location.hostname === '127.0.0.1') window.__mcpTest = { extractCall, scanCalls, looseParse, extractSummary, makeWatcher, COMPACT_PROMPT };
})();
