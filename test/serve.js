#!/usr/bin/env node
// Serves the mock page for browser tests: http://127.0.0.1:3950/test/mock.html
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript' };
http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end('not found');
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'text/plain' }).end(fs.readFileSync(p));
}).listen(3950, '127.0.0.1', () => console.log('mock on http://127.0.0.1:3950/test/mock.html'));
