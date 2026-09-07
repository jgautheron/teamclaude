// The Codex WebSocket relay, end to end against a fake upstream.
//
// Nothing here uses the global WebSocket (absent on Node 20): both the test
// client and the fake upstream speak RFC 6455 through src/ws-frames.js, so
// the relay is exercised byte-for-byte the way Codex and chatgpt.com do it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, codexUpgradeTarget, resolveAccountPin } from '../src/server.js';
import { relayCodexUpgrade, webSocketRefused, noteWebSocketRefused, clearWebSocketRefusals } from '../src/codex-ws.js';
import { FrameDecoder, encodeFrame, closeFrame, parseClose, computeAccept, OPCODE } from '../src/ws-frames.js';
import { setUpstreamProxy, resolveUpstreamProxy } from '../src/upstream-proxy.js';
import { SessionTracker } from '../src/session-tracker.js';

// The relay honours a configured upstream proxy, so these tests must not
// inherit one from the environment (see test/README.md).
setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));

const RESPONSES = '/backend-api/codex/responses';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const codex = (name) => ({
  name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name,
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000,
});

const rateLimitsEvent = (usedPercent, extra = {}) => JSON.stringify({
  type: 'codex.rate_limits', plan_type: 'pro',
  rate_limits: { allowed: true, limit_reached: false, primary: { used_percent: usedPercent, window_minutes: 10080, reset_at: Math.floor(Date.now() / 1000) + 86400 }, secondary: null },
  ...extra,
});

/** A queue that hands out items as promises, in order. */
class Inbox {
  constructor() { this.items = []; this.waiters = []; }
  push(item) { const w = this.waiters.shift(); if (w) w(item); else this.items.push(item); }
  next(ms = 3000) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for a frame')), ms);
      this.waiters.push((item) => { clearTimeout(t); resolve(item); });
    });
  }
}

/** Frames read off a socket, plus a text sender. `mask` says which side we are. */
function attach(socket, { mask, initial = null } = {}) {
  const dec = new FrameDecoder();
  const inbox = new Inbox();
  const feed = (chunk) => { for (const f of dec.push(chunk)) inbox.push(f); };
  if (initial?.length) feed(initial);
  socket.on('data', feed);
  socket.on('close', () => inbox.push({ opcode: 'closed' }));
  return {
    socket, inbox,
    send: (text, opts = {}) => socket.write(encodeFrame(OPCODE.TEXT, text, { mask, ...opts })),
    sendRaw: (buf) => socket.write(buf),
    close: (code, reason) => socket.write(closeFrame(code, reason, { mask })),
    async text() {
      for (;;) { const f = await inbox.next(); if (f.opcode === OPCODE.TEXT) return f.payload.toString(); if (f.opcode === 'closed') throw new Error('closed before a text frame'); }
    },
    async closed() {
      for (;;) {
        const f = await inbox.next();
        if (f.opcode === OPCODE.CLOSE) return parseClose(f.payload);
        if (f.opcode === 'closed') return { code: null, reason: '(socket closed)' };
      }
    },
  };
}

/** A raw WebSocket client: sends the upgrade, resolves with the 101 (or the refusal). */
function connect(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Extensions: permessage-deflate',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
    socket.on('error', reject);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const head = buf.subarray(0, end).toString();
      const [statusLine, ...hdrLines] = head.split('\r\n');
      const status = Number(statusLine.split(' ')[1]);
      const hdrs = Object.fromEntries(hdrLines.map(l => { const i = l.indexOf(':'); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }));
      const rest = buf.subarray(end + 4);
      if (status !== 101) {
        let body = rest.toString();
        socket.on('data', c => { body += c; });
        socket.on('close', () => resolve({ status, headers: hdrs, body }));
        return;
      }
      resolve({ status, headers: hdrs, ...attach(socket, { mask: true, initial: rest }) });
    };
    socket.on('data', onData);
  });
}

/**
 * A fake chatgpt.com: answers each upgrade by the injected bearer token.
 * `answers[token]` is `{ status, headers, body }` for a refusal, or
 * `{ ws(conn, req) }` to accept and drive the connection.
 */
async function fakeUpstream(answers) {
  const hits = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    hits.push({ token, headers: req.headers, url: req.url });
    const answer = answers[token] || answers.default;
    if (!answer) { socket.destroy(); return; }
    if (answer.hang) return;
    if (answer.ws) {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeAccept(req.headers['sec-websocket-key'])}\r\n${Object.entries(answer.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`);
      answer.ws(attach(socket, { mask: false, initial: head }), req);
      return;
    }
    const body = JSON.stringify(answer.body || { error: { message: 'no' } });
    socket.write(`HTTP/1.1 ${answer.status} X\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${Object.entries(answer.headers || {}).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n${body}`);
    socket.end();
  });
  const port = await listen(server);
  return { server, port, hits, close: () => server.close() };
}

/** Echo one canned response for a `response.create`: rate limits, then completed. */
const serve = (usedPercent = 10) => async (conn) => {
  await conn.text();
  conn.send(rateLimitsEvent(usedPercent));
  conn.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
  conn.send(JSON.stringify({ type: 'response.completed', response: { id: 'r1' } }));
};

async function withProxy(answers, run, { accounts = [codex('a'), codex('b')], hooks = {}, config = {} } = {}) {
  const up = await fakeUpstream(answers);
  const am = new AccountManager(accounts, 0.98);
  for (const a of am.accounts) a.upstream = `http://127.0.0.1:${up.port}`;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${up.port}`, ...config }, hooks);
  const port = await listen(proxy);
  const open = [];
  const client = async (path = RESPONSES, headers = {}) => { const c = await connect(port, path, headers); open.push(c); return c; };
  try {
    return await run({ client, am, hits: up.hits, port });
  } finally {
    for (const c of open) c.socket?.destroy();
    // 'close' is emitted a tick after destroy; let the relay's end hook run.
    await new Promise(r => setTimeout(r, 20));
    proxy.closeAllConnections?.();
    proxy.close();
    up.close();
  }
}

const create = (model, extra = {}) => JSON.stringify({ type: 'response.create', model, input: [], ...extra });

test('a Codex upgrade is answered locally, then dialed with the account credential on the first frame', async () => {
  const ended = [];
  await withProxy({ 't-a': { ws: serve(37) } }, async ({ client, am, hits }) => {
    const c = await client(RESPONSES, { 'openai-beta': 'responses_websockets=2026-02-06', 'x-api-key': 'k', session_id: 'sess-1' });
    assert.equal(c.status, 101);
    assert.equal(c.headers['sec-websocket-accept'], computeAccept('dGhlIHNhbXBsZSBub25jZQ=='));
    assert.equal(hits.length, 0, 'no upstream connection before the client speaks');
    c.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.equal(JSON.parse(await c.text()).type, 'response.created');
    assert.equal(JSON.parse(await c.text()).type, 'response.completed');
    assert.equal(hits.length, 1);
    const h = hits[0].headers;
    assert.equal(h.authorization, 'Bearer t-a');
    assert.equal(h['chatgpt-account-id'], 'acct-a');
    assert.equal(h['x-api-key'], undefined, 'the proxy key never reaches upstream');
    assert.equal(h['sec-websocket-extensions'], undefined, 'permessage-deflate is not offered upstream');
    assert.notEqual(h['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==', 'a fresh key is used upstream');
    assert.equal(h['openai-beta'], 'responses_websockets=2026-02-06');
    assert.equal(h.session_id, 'sess-1');
    assert.equal(hits[0].url, RESPONSES);
    assert.equal(am.accounts[0].quota.unified7d, 0.37, 'quota learned from the codex.rate_limits frame');
    assert.equal(am.accounts[0].quota.planType, 'pro');
    assert.equal(am.accounts[0].usage.totalRequests, 1);
  }, { hooks: { onRequestEnd: (id, info) => ended.push({ id, ...info }) } });
  assert.equal(ended.length, 1);
  assert.match(String(ended[0].id), /^ws-/);
  assert.equal(ended[0].method, 'WS');
  assert.equal(ended[0].model, 'gpt-5.4');
  assert.equal(ended[0].account, 'a');
  assert.equal(ended[0].sessionId, 'codex:sess-1');
});

test('the openai-beta header is added when a bare client omits it, and quota headers on the 101 are read', async () => {
  await withProxy({ 't-a': { ws: serve(), headers: { 'x-codex-primary-used-percent': '55', 'x-codex-primary-window-minutes': '10080' } } }, async ({ client, am, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    await c.text();
    assert.equal(hits[0].headers['openai-beta'], 'responses_websockets=2026-02-06');
    assert.equal(am.accounts[0].quota.unified7d, 0.10, 'the frame reading (10%) supersedes the 101 header (55%)');
  });
});

test('selection is model-aware: an account whose family bucket is spent is skipped for that model only', async () => {
  const both = { 't-a': { ws: serve() }, 't-b': { ws: serve() } };
  await withProxy(both, async ({ client, am, hits }) => {
    am.accounts[0].quota.codexModelBuckets = { bengalfox: { name: 'GPT-5.3-Codex-Spark', utilization: 1, resetAt: Date.now() + 86400_000, seenAt: Date.now() } };
    const spark = await client();
    spark.send(create('gpt-5.3-codex-spark'));
    await spark.text();
    const plain = await client();
    plain.send(create('gpt-5.4'));
    await plain.text();
    assert.deepEqual(hits.map(h => h.token), ['t-b', 't-a']);
  });
});

test('a quota 429 on the handshake fails over to the next account; the client only ever sees the good one', async () => {
  await withProxy({
    't-a': { status: 429, headers: { 'x-codex-rate-limit-reached-type': 'rate_limit_reached', 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '10080' } },
    't-b': { ws: serve(20) },
  }, async ({ client, am, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b']);
    assert.equal(am.accounts[0].status, 'throttled');
    assert.equal(am.accounts[0].quota.unified7d, 1, 'the spent reading came off the 429 headers');
    assert.equal(am.accounts[1].quota.unified7d, 0.2);
  });
});

test('a 402 and a body-only usage_limit_reached both count as spent quota', async () => {
  await withProxy({
    't-a': { status: 402, body: { error: { code: 'insufficient_quota' } } },
    't-b': { status: 429, body: { error: { type: 'usage_limit_reached' } } },
  }, async ({ client, am, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1013);
    assert.deepEqual(hits.map(h => h.token).sort(), ['t-a', 't-b']);
    assert.equal(am.accounts[0].status, 'throttled');
    assert.equal(am.accounts[1].status, 'throttled');
  });
});

test('a hard pin never crosses to another account', async () => {
  await withProxy({
    't-a': { status: 429, headers: { 'x-codex-rate-limit-reached-type': 'rate_limit_reached' } },
    't-b': { ws: serve() },
  }, async ({ client, hits }) => {
    const c = await client(`/tc-acct/a${RESPONSES}`);
    assert.equal(c.status, 101);
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1013);
    assert.match(close.reason, /pinned/);
    assert.deepEqual(hits.map(h => h.token), ['t-a']);
    assert.equal(hits[0].url, RESPONSES, 'the pin prefix is stripped before upstream');
  });
});

test('an unknown pin is refused before any account is touched', async () => {
  await withProxy({ default: { ws: serve() } }, async ({ client, hits }) => {
    const c = await client(`/tc-acct/nobody${RESPONSES}`);
    assert.equal(c.status, 404);
    assert.match(c.body, /Unknown account pin/);
    assert.equal(hits.length, 0);
  });
});

test('a browser-origin upgrade is refused with 403 and never dialed', async () => {
  await withProxy({ default: { ws: serve() } }, async ({ client, hits }) => {
    const c = await client(RESPONSES, { Origin: 'https://evil.example' });
    assert.equal(c.status, 403);
    assert.equal(hits.length, 0);
  });
});

test('a 401 forces one token refresh and redials with the new credential', async () => {
  await withProxy({
    't-a': { status: 401, body: { error: { code: 'token_expired' } } },
    't-a2': { ws: serve() },
  }, async ({ client, am, hits }) => {
    const refreshes = [];
    am.ensureTokenFresh = async (i, force = false) => { refreshes.push(force); if (force) am.accounts[i].credential = 't-a2'; };
    const c = await client();
    c.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-a2']);
    assert.equal(refreshes.filter(Boolean).length, 1, 'exactly one forced refresh');
  }, { accounts: [codex('a')] });
});

test('a second 401 after the refresh is not retried forever', async () => {
  await withProxy({ 't-a': { status: 401 } }, async ({ client, am, hits }) => {
    am.ensureTokenFresh = async () => {};
    const c = await client();
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1011);
    assert.match(close.reason, /401/);
    assert.equal(hits.length, 2);
  }, { accounts: [codex('a')] });
});

test('a per-minute 429 closes with 1013 and the retry-after; the account is paused, not rotated', async () => {
  await withProxy({ 't-a': { status: 429, headers: { 'retry-after': '7' } }, 't-b': { ws: serve() } }, async ({ client, am, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1013);
    assert.match(close.reason, /retry in 7s/);
    assert.deepEqual(hits.map(h => h.token), ['t-a'], 'no failover on a transient rate limit');
    assert.notEqual(am.accounts[0].status, 'throttled');
  });
});

test('an entitlement 403 marks the account and fails over', async () => {
  await withProxy({
    't-a': { status: 403, body: { error: { code: 'codex_entitlement_missing' } } },
    't-b': { ws: serve() },
  }, async ({ client, am, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b']);
    assert.ok(am.accounts[0].entitlementDeniedUntil > Date.now());
  });
});

test('a non-101 upstream answer with a body closes the client with its status', async () => {
  await withProxy({ 't-a': { status: 503, body: { error: { message: 'down' } } } }, async ({ client }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1011);
    assert.match(close.reason, /upstream 503/);
  }, { accounts: [codex('a')] });
});

test('a fragmented response.create still names the model and reaches upstream whole', async () => {
  let seen = null;
  await withProxy({ 't-a': { ws: async (conn) => { seen = await conn.text(); conn.send(rateLimitsEvent(1)); conn.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } })); } } }, async ({ client, hits }) => {
    const c = await client();
    const text = create('gpt-5.4', { input: [{ role: 'user', content: 'x'.repeat(70_000) }] });
    c.sendRaw(encodeFrame(OPCODE.TEXT, text.slice(0, 100), { mask: true, fin: false }));
    c.sendRaw(encodeFrame(OPCODE.CONTINUATION, text.slice(100), { mask: true }));
    await c.text();
    assert.equal(seen, text);
    assert.equal(hits.length, 1);
  });
});

test('a quota error before any output is answered by another account, and the client never sees it', async () => {
  let replayed = null;
  const spendCap = { type: 'error', error: { type: 'usage_limit_reached', message: 'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.', rate_limit_reached_type: 'workspace_member_usage_limit_reached', resets_in_seconds: 3600 } };
  await withProxy({
    't-a': { ws: async (conn) => { await conn.text(); conn.send(rateLimitsEvent(50)); conn.send(JSON.stringify(spendCap)); } },
    't-b': { ws: async (conn) => { replayed = await conn.text(); conn.send(rateLimitsEvent(20)); conn.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } })); conn.send(JSON.stringify({ type: 'response.completed', response: { id: 'r1' } })); } },
  }, async ({ client, am, hits }) => {
    const c = await client();
    const request = create('gpt-5.4', { input: [{ role: 'user', content: 'hello' }] });
    c.send(request);
    const types = [];
    for (let i = 0; i < 3; i++) types.push(JSON.parse(await c.text()).type);
    assert.deepEqual(types, ['codex.rate_limits', 'response.created', 'response.completed'], 'only the second account\'s response reaches the client');
    assert.equal(replayed, request, 'the very same request is replayed');
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b']);
    assert.equal(am.accounts[0].status, 'throttled');
    const until = am.accounts[0].rateLimitedUntil - Date.now();
    assert.ok(until > 3500_000 && until <= 3600_000, `held for the window the error names: ${until}`);
    assert.equal(am.accounts[1].quota.unified7d, 0.2, 'the serving account\'s reading is the one learned');
    assert.equal(am.accounts[0].quota.unified7d, 0.5, 'the refusing account\'s reading is kept too');
  });
});

test('with no other account in reach, the early quota error goes to the client and the connection closes with 1012', async () => {
  await withProxy({
    't-a': { ws: async (conn) => {
      await conn.text();
      conn.send(rateLimitsEvent(50));
      conn.send(JSON.stringify({ type: 'error', error: { code: 'usage_limit_reached', message: 'spent' } }));
    } },
  }, async ({ client, am, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.equal(JSON.parse(await c.text()).type, 'error', 'the true error is the answer when nothing has headroom');
    const close = await c.closed();
    assert.equal(close.code, 1012);
    assert.equal(am.accounts[0].status, 'throttled');
    assert.equal(hits.length, 1);
  }, { accounts: [codex('a')] });
});

test('a quota error after output has started is relayed as-is; the connection closes after the response, never under it', async () => {
  await withProxy({
    't-a': { ws: async (conn) => {
      await conn.text();
      conn.send(rateLimitsEvent(50));
      conn.send(JSON.stringify({ type: 'response.created', response: { id: 'r1' } }));
      conn.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }));
      conn.send(JSON.stringify({ type: 'error', error: { code: 'usage_limit_reached', message: 'spent' } }));
    } },
    't-b': { ws: serve() },
  }, async ({ client, am, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    const types = [];
    for (let i = 0; i < 4; i++) types.push(JSON.parse(await c.text()).type);
    assert.deepEqual(types, ['codex.rate_limits', 'response.created', 'response.output_text.delta', 'error']);
    const close = await c.closed();
    assert.equal(close.code, 1012);
    assert.deepEqual(hits.map(h => h.token), ['t-a'], 'no second dial under a response that has output');
    const next = await client();
    next.send(create('gpt-5.4'));
    await next.text();
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b'], 'the next connection lands elsewhere');
    assert.equal(am.accounts[0].status, 'throttled');
  });
});

test('a pinned connection is never retried on another account', async () => {
  await withProxy({
    't-a': { ws: async (conn) => {
      await conn.text();
      conn.send(rateLimitsEvent(50));
      conn.send(JSON.stringify({ type: 'error', error: { code: 'usage_limit_reached', message: 'spent' } }));
    } },
    't-b': { ws: serve() },
  }, async ({ client, hits }) => {
    const c = await client(`/tc-acct/a${RESPONSES}`);
    c.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.equal(JSON.parse(await c.text()).type, 'error');
    assert.deepEqual(hits.map(h => h.token), ['t-a']);
  });
});
test('crossing the threshold on a response closes the connection between responses, never during one', async () => {
  const frames = [];
  await withProxy({
    't-a': { ws: async (conn) => {
      await conn.text();
      conn.send(rateLimitsEvent(99));                        // over the 0.98 threshold
      conn.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }));
      conn.send(JSON.stringify({ type: 'response.completed', response: { id: 'r1' } }));
    } },
  }, async ({ client }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    for (let i = 0; i < 3; i++) frames.push(JSON.parse(await c.text()).type);
    const close = await c.closed();
    assert.equal(close.code, 1012);
  }, { accounts: [codex('a')] });
  assert.deepEqual(frames, ['codex.rate_limits', 'response.output_text.delta', 'response.completed']);
});

test('a client that connects and leaves before speaking never dials upstream', async () => {
  const ended = [];
  await withProxy({ default: { ws: serve() } }, async ({ client, hits }) => {
    const c = await client();
    c.close(1000, 'bye');
    c.socket.end();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(hits.length, 0);
  }, { hooks: { onRequestEnd: (id, info) => ended.push(info) } });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].account, '(no account)');
});

test('no eligible Codex account closes with 1013 without dialing', async () => {
  await withProxy({ default: { ws: serve() } }, async ({ client, am, hits }) => {
    am.markRateLimited(0, 600);
    const c = await client();
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1013);
    assert.equal(hits.length, 0);
  }, { accounts: [codex('a')] });
});

test('an upstream that never completes the handshake is given up on', async () => {
  const up = await fakeUpstream({ 't-a': { hang: true } });
  const am = new AccountManager([codex('a')], 0.98);
  am.accounts[0].upstream = `http://127.0.0.1:${up.port}`;
  const ended = [];
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => relayCodexUpgrade(req, socket, head, {
    accountManager: am, upstream: 'http://unused', hooks: { onRequestEnd: (id, info) => ended.push(info) }, dialTimeoutMs: 150, log: () => {},
  }));
  const port = await listen(server);
  let c;
  try {
    c = await connect(port, RESPONSES);
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1011);
    assert.equal(ended[0].status, 502);
    assert.equal(up.hits.length, 1);
  } finally {
    c?.socket.destroy(); server.closeAllConnections?.(); server.close(); up.close();
  }
});

test('a silent client is dialed without a model after the first-frame grace period', async () => {
  const up = await fakeUpstream({ 't-a': { ws: (conn) => conn.send(rateLimitsEvent(5)) } });
  const am = new AccountManager([codex('a')], 0.98);
  am.accounts[0].upstream = `http://127.0.0.1:${up.port}`;
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => relayCodexUpgrade(req, socket, head, {
    accountManager: am, upstream: 'http://unused', firstFrameTimeoutMs: 50, log: () => {},
  }));
  const port = await listen(server);
  let c;
  try {
    c = await connect(port, RESPONSES);
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.equal(up.hits.length, 1);
  } finally {
    c?.socket.destroy(); server.closeAllConnections?.(); server.close(); up.close();
  }
});

test('codexUpgradeTarget separates Codex upgrades from everything else', () => {
  const am = new AccountManager([codex('a')], 0.98);
  assert.equal(codexUpgradeTarget(am, '/v1/code/ws'), null, 'Remote Control stays on the passthrough');
  assert.equal(codexUpgradeTarget(am, '/tc-acct/a/v1/code/ws'), null);
  assert.deepEqual(codexUpgradeTarget(am, RESPONSES), { path: RESPONSES, pinnedIndex: null });
  assert.deepEqual(codexUpgradeTarget(am, `/tc-acct/a${RESPONSES}`), { path: RESPONSES, pinnedIndex: 0 });
  assert.deepEqual(codexUpgradeTarget(am, `/tc-acct/zz${RESPONSES}`), { unknownPin: 'zz' });
  assert.deepEqual(codexUpgradeTarget(am, `${RESPONSES}?x=1`), { path: `${RESPONSES}?x=1`, pinnedIndex: null });
});

/** A minimal CONNECT proxy: answers 200 and splices to the requested target. */
function fakeConnectProxy() {
  const tunnels = [];
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    let buf = '';
    const onData = (chunk) => {
      buf += chunk;
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const [, target] = /^CONNECT ([^ ]+) /.exec(buf) || [];
      const [host, port] = String(target).split(':');
      tunnels.push(target);
      const upstream = net.connect(Number(port), host, () => {
        sockets.add(upstream);
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = buf.slice(end + 4);
        if (rest) upstream.write(rest);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  // A net.Server has no closeAllConnections: the spliced sockets are ours to end.
  return listen(server).then(port => ({ port, tunnels, close: () => { for (const s of sockets) s.destroy(); server.close(); } }));
}

test('an upstream (corporate) proxy carries the WebSocket dial as a CONNECT tunnel', async () => {
  const proxy = await fakeConnectProxy();
  setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: `http://127.0.0.1:${proxy.port}`, noProxy: '' }, {}));
  try {
    await withProxy({ 't-a': { ws: serve(33) } }, async ({ client, am, hits }) => {
      const c = await client();
      c.send(create('gpt-5.4'));
      assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
      assert.equal(hits.length, 1);
      assert.equal(proxy.tunnels.length, 1, 'the dial went through the proxy');
      assert.match(proxy.tunnels[0], /^127\.0\.0\.1:\d+$/);
      assert.equal(am.accounts[0].quota.unified7d, 0.33);
    }, { accounts: [codex('a')] });
  } finally {
    setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {}));
    proxy.close();
  }
});

/** A bare server that hands every upgrade to the relay with the given ctx. */
async function relayServer(am, ctx) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => relayCodexUpgrade(req, socket, head, { accountManager: am, upstream: 'http://unused', log: () => {}, ...ctx }));
  const port = await listen(server);
  return { port, close: () => { server.closeAllConnections?.(); server.close(); } };
}

test('with a hold budget, an exhausted fleet is polled until an account recovers, then dialed', async () => {
  const up = await fakeUpstream({ 't-a': { ws: serve(5) } });
  const am = new AccountManager([codex('a')], 0.98);
  am.accounts[0].upstream = `http://127.0.0.1:${up.port}`;
  am.markRateLimited(0, 1);                        // recovers in one second
  const logs = [];
  const ended = [];
  const srv = await relayServer(am, { holdBudgetMs: 5_000, retryAfter: () => 1, log: (m) => logs.push(m), hooks: { onRequestEnd: (id, info) => ended.push(info) } });
  let c;
  try {
    c = await connect(srv.port, RESPONSES);
    c.send(create('gpt-5.4'));
    const started = Date.now();
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.ok(Date.now() - started >= 900, 'the dial waited for the hold');
    assert.equal(up.hits.length, 1);
    assert.match(logs.join('\n'), /holding WebSocket, retry in 1s \(4s budget left\)/);
  } finally {
    c?.socket.destroy(); srv.close(); up.close();
  }
});

test('the hold gives up with 1013 once the budget is spent', async () => {
  const up = await fakeUpstream({ 't-a': { ws: serve() } });
  const am = new AccountManager([codex('a')], 0.98);
  am.accounts[0].upstream = `http://127.0.0.1:${up.port}`;
  am.markRateLimited(0, 600);
  const ended = [];
  const srv = await relayServer(am, { holdBudgetMs: 300, retryAfter: () => 1, holdPollMaxMs: 100, hooks: { onRequestEnd: (id, info) => ended.push(info) } });
  let c;
  try {
    c = await connect(srv.port, RESPONSES);
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1013);
    assert.equal(up.hits.length, 0);
    assert.equal(ended[0].status, 429);
  } finally {
    c?.socket.destroy(); srv.close(); up.close();
  }
});

test('a client that leaves during the hold ends it without a dial', async () => {
  const up = await fakeUpstream({ 't-a': { ws: serve() } });
  const am = new AccountManager([codex('a')], 0.98);
  am.accounts[0].upstream = `http://127.0.0.1:${up.port}`;
  am.markRateLimited(0, 1);
  const ended = [];
  const srv = await relayServer(am, { holdBudgetMs: 5_000, retryAfter: () => 1, hooks: { onRequestEnd: (id, info) => ended.push(info) } });
  let c;
  try {
    c = await connect(srv.port, RESPONSES);
    c.send(create('gpt-5.4'));
    await new Promise(r => setTimeout(r, 100));
    c.socket.destroy();
    await new Promise(r => setTimeout(r, 1300));
    assert.equal(up.hits.length, 0, 'no dial after the client left');
    assert.equal(ended.length, 1);
  } finally {
    srv.close(); up.close();
  }
});

test('a pinned connection never holds: the pinned account is the answer', async () => {
  const up = await fakeUpstream({ 't-a': { ws: serve() } });
  const am = new AccountManager([codex('a')], 0.98);
  am.accounts[0].upstream = `http://127.0.0.1:${up.port}`;
  am.markRateLimited(0, 600);
  const srv = await relayServer(am, { holdBudgetMs: 5_000, retryAfter: () => 1, pinnedIndex: 0 });
  let c;
  try {
    c = await connect(srv.port, RESPONSES);
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1013);
    assert.match(close.reason, /pinned account is unavailable \(throttled\)/);
    assert.equal(up.hits.length, 0, 'an unavailable pinned account is refused, not dialed');
  } finally {
    c?.socket.destroy(); srv.close(); up.close();
  }
});

test('a WebSocket session is pinned to its account: with distribution on, a thread stays put and a new thread spreads', async () => {
  const both = { 't-a': { ws: serve() }, 't-b': { ws: serve() } };
  const up = await fakeUpstream(both);
  // activeTtlMs 0: "active" then means "a connection is open", so the count
  // follows the connections exactly instead of lingering for the idle window.
  const am = new AccountManager([codex('a'), codex('b')], 0.98, { distributeSessions: true, sessionTracker: new SessionTracker({ activeTtlMs: 0 }) });
  for (const a of am.accounts) a.upstream = `http://127.0.0.1:${up.port}`;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'http://unused' });
  const port = await listen(proxy);
  const open = [];
  try {
    const turn = async (session, activeSessions) => {
      const c = await connect(port, RESPONSES, { 'session-id': session });
      open.push(c);
      c.send(create('gpt-5.4'));
      await c.text();
      assert.equal(am.sessionStats().active, activeSessions, 'an open connection keeps its session active');
      return up.hits.at(-1).token;
    };
    const first = await turn('thread-1', 1);
    const second = await turn('thread-1', 1);
    assert.equal(second, first, 'the same thread lands on the same account, so its prompt cache is reused');
    const other = await turn('thread-2', 2);
    assert.notEqual(other, first, 'a new thread goes to the least-loaded account');
    assert.equal(am.sessionStats().known, 2);
    for (const c of open) c.socket.destroy();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(am.sessionStats().active, 0, 'closing the connections ends the sessions in flight');
  } finally {
    for (const c of open) c.socket?.destroy();
    proxy.closeAllConnections?.(); proxy.close(); up.close();
  }
});

// ── Findings from the adversarial review ───────────────────────────────────

/** Connect with a frame coalesced into the handshake's `head` bytes. */
function connectWithHead(port, path, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(Buffer.concat([Buffer.from(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`), frame]));
    });
    socket.on('error', reject);
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      resolve({ status: Number(buf.toString().split(' ')[1]), ...attach(socket, { mask: true, initial: buf.subarray(end + 4) }) });
    };
    socket.on('data', onData);
  });
}

test('a first frame coalesced with the handshake is served, not a crash: text dials, close ends', async () => {
  const ended = [];
  await withProxy({ 't-a': { ws: serve(7) } }, async ({ client, hits, port }) => {
    const c = await connectWithHead(port, RESPONSES, encodeFrame(OPCODE.TEXT, create('gpt-5.4'), { mask: true }));
    assert.equal(c.status, 101);
    assert.equal(JSON.parse(await c.text()).type, 'codex.rate_limits');
    assert.equal(hits.length, 1);
    c.socket.destroy();
    const closer = await connectWithHead(port, RESPONSES, closeFrame(1000, 'bye', { mask: true }));
    assert.equal(closer.status, 101);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(hits.length, 1, 'a close in the head never dials');
    // The proxy is still serving: a normal connection after both works.
    const again = await client();
    again.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await again.text()).type, 'codex.rate_limits');
  }, { accounts: [codex('a')], hooks: { onRequestEnd: (id, info) => ended.push(info) } });
  assert.ok(ended.length >= 2);
});

test('an upstream 426 closes this connection and refuses the next upgrade with an HTTP 426 before any 101', async () => {
  clearWebSocketRefusals();
  await withProxy({ 't-a': { status: 426, body: { error: { message: 'websockets disabled' } } } }, async ({ client, hits }) => {
    const c = await client();
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1011);
    assert.match(close.reason, /426/);
    assert.equal(hits.length, 1);
    const next = await client();
    assert.equal(next.status, 426, 'the refusal is remembered and answered honestly');
    assert.equal(hits.length, 1, 'no dial once the upstream is known to refuse');
  }, { accounts: [codex('a')] });
  clearWebSocketRefusals();
  assert.equal(webSocketRefused('127.0.0.1'), false);
});

test('a refused host only refuses the upgrade outright when every candidate account sits behind it', async () => {
  clearWebSocketRefusals();
  noteWebSocketRefused('refused.invalid');
  await withProxy({ 't-b': { ws: serve(0) } }, async ({ client, am, hits }) => {
    am.accounts[0].upstream = 'http://refused.invalid:1';
    // Unpinned: account b's host still speaks WebSockets, so no HTTP 426.
    // Selection lands on a (lowest usage), whose host is known to refuse:
    // a close, and no dial to it.
    const c = await client();
    assert.equal(c.status, 101, 'not refused while another account can serve');
    c.send(create('gpt-5.4'));
    const close = await c.closed();
    assert.equal(close.code, 1011);
    assert.match(close.reason, /426/);
    assert.equal(hits.length, 0, 'the refusing host is not dialed');
    // Pinned to b: served as usual.
    const pinned = await client(`/tc-acct/b${RESPONSES}`);
    assert.equal(pinned.status, 101);
    pinned.send(create('gpt-5.4'));
    assert.equal(JSON.parse(await pinned.text()).type, 'codex.rate_limits');
    assert.equal(hits.length, 1);
    // Pinned to a: its host is the only candidate, so an honest 426.
    const refused = await client(`/tc-acct/a${RESPONSES}`);
    assert.equal(refused.status, 426);
    // Once b's host refuses too, an unpinned upgrade gets the 426 as well.
    noteWebSocketRefused('127.0.0.1');
    assert.equal((await client()).status, 426);
  });
  clearWebSocketRefusals();
});

test('a pin resolves within the provider the request is for, so a Claude namesake is never picked for a Codex path', () => {
  const am = new AccountManager([
    { name: 'me@x.com', type: 'oauth', accessToken: 't-claude', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    codex('me@x.com'),
  ], 0.98);
  assert.deepEqual(codexUpgradeTarget(am, `/tc-acct/me%40x.com${RESPONSES}`), { path: RESPONSES, pinnedIndex: 1 });
  assert.equal(resolveAccountPin(am, 'me@x.com', 'codex'), 1);
  assert.equal(resolveAccountPin(am, 'me@x.com', 'anthropic'), 0);
  assert.equal(resolveAccountPin(am, 'me@x.com'), 0, 'unscoped keeps the first match');
  assert.equal(resolveAccountPin(am, 'acct-me@x.com', 'anthropic'), null, 'a Codex id is not a Claude pin');
});
