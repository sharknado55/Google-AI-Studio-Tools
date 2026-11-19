#!/usr/bin/env node
// Tiny stdio MCP server for tests. Tools: echo, big (returns a large result).
const rl = require('readline').createInterface({ input: process.stdin });
const tools = [
  { name: 'echo', description: 'Echo the text back. Second sentence.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'list_allowed_directories', description: 'List allowed folders.', inputSchema: { type: 'object', properties: {} } },
  { name: 'big', description: 'Return a large log-like result.', inputSchema: { type: 'object', properties: { lines: { type: 'number' } } } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    const a = m.params.arguments || {};
    if (m.params.name === 'list_allowed_directories') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'Allowed directories:\nC:/fake/root' }] } });
    if (m.params.name === 'echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(a.text) }] } });
    if (m.params.name === 'big') {
      const n = a.lines || 3000;
      const out = [];
      for (let i = 0; i < n; i++) out.push(i % 50 === 7 ? `ERROR line ${i}: disk full` : `INFO request ${i % 5} ok    took   12ms`);
      return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: out.join('\n') }] } });
    }
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
});
