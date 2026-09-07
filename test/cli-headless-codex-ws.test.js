// A headless server writes one activity-log row per Codex WebSocket session,
// shaped like a request row, so deployments that join the log against a
// person see WebSocket traffic too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeFrame, computeAccept, OPCODE } from '../src/ws-frames.js';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function freePort() {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function waitForPort(port, deadlineMs = 15_000) {
  const until = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(); });
      s.on('error', () => { s.destroy(); if (Date.now() > until) reject(new Error('server never listened')); else setTimeout(tryOnce, 100); });
    };
    tryOnce();
  });
}

// A fake chatgpt.com that accepts the upgrade and answers one response.
async function fakeUpstream() {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeAccept(req.headers['sec-websocket-key'])}\r\n\r\n`);
    const dec = new FrameDecoder();
    socket.on('data', (chunk) => {
      for (const f of dec.push(chunk)) {
        if (f.opcode !== OPCODE.TEXT) continue;
        socket.write(encodeFrame(OPCODE.TEXT, JSON.stringify({ type: 'codex.rate_limits', plan_type: 'pro', rate_limits: { primary: { used_percent: 12, window_minutes: 10080 } } })));
        socket.write(encodeFrame(OPCODE.TEXT, JSON.stringify({ type: 'response.completed', response: { id: 'r1' } })));
      }
    });
    socket.on('error', () => {});
  });
  const port = await listen(server);
  return { port, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** The smallest WebSocket client this test needs: upgrade, one message, wait for close. */
function oneTurn(port, path, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nsession_id: sess-42\r\n\r\n`);
    });
    socket.on('error', reject);
    const dec = new FrameDecoder();
    const seen = [];
    let upgraded = false;
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!upgraded) {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!/^HTTP\/1\.1 101/.test(buf.toString())) { reject(new Error(buf.toString())); return; }
        upgraded = true;
        socket.write(encodeFrame(OPCODE.TEXT, text, { mask: true }));
        chunk = buf.subarray(end + 4);
      }
      for (const f of dec.push(chunk)) {
        if (f.opcode === OPCODE.TEXT) seen.push(JSON.parse(f.payload.toString()).type);
        if (seen.includes('response.completed')) { socket.end(); }
      }
    });
    socket.on('close', () => resolve(seen));
  });
}

test('a headless server logs a Codex WebSocket session as one activity row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-headless-ws-'));
  const up = await fakeUpstream();
  const port = await freePort();
  const configPath = join(dir, 'config.json');
  const logPath = join(dir, 'activity.log');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'tc-test' },
    accounts: [{ name: 'a', type: 'oauth', provider: 'codex', accountId: 'acct-a', accessToken: 't-a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, upstream: `http://127.0.0.1:${up.port}` }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server', '--headless', '--activity-log', logPath], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  try {
    await waitForPort(port);
    const seen = await oneTurn(port, '/backend-api/codex/responses', JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: [] }));
    assert.deepEqual(seen, ['codex.rate_limits', 'response.completed']);
    // The row is written when the socket closes; give the child a moment.
    let log = '';
    for (let i = 0; i < 50 && !/WS /.test(log); i++) {
      await new Promise(r => setTimeout(r, 100));
      log = await readFile(logPath, 'utf8').catch(() => '');
    }
    assert.match(log, /codex sess-4 WS \/backend-api\/codex\/responses \(gpt-5\.4\) → a \(200, [\d.]+s\)/, `activity log:\n${log}\nserver output:\n${output}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => child.once('exit', r));
    up.close();
    await rm(dir, { recursive: true, force: true });
  }
});
