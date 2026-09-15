import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { generateCertChain } from '../src/x509.js';
import { createConnectHandler, hostMode, mitmHosts } from '../src/mitm.js';
import { AccountManager } from '../src/account-manager.js';
import {
  createOpenRouterListener, blockedOpenRouterModel, isTransientFailure, withRetryHint,
  splitSseEvents, DEFAULT_OPENROUTER_BLOCKED, RETRY_HINT,
} from '../src/openrouter.js';

const T = { timeout: 30000 };

// pi 0.85.1's retry classifier (RETRYABLE_PROVIDER_ERROR_PATTERN), copied verbatim: the
// hint only works while pi's own retry matches it.
const PI_RETRYABLE = new RegExp(['overloaded', 'rate.?limit', 'too many requests', '429', '500', '502', '503', '504', '524', 'service.?unavailable', 'server.?error', 'internal.?error', 'provider.?returned.?error', 'exceeded request buffer limit while retrying upstream', 'network.?error', 'connection.?error', 'connection.?refused', 'connection.?lost', 'other side closed', 'fetch failed', 'getaddrinfo', 'ENOTFOUND', 'EAI_AGAIN', 'upstream.?connect', 'reset before headers', 'socket hang up', 'socket connection was closed', 'timed? out', 'timeout', 'terminated', 'websocket.?closed', 'websocket.?error', 'ended without', 'stream ended before message_stop', 'stream ended before a terminal response event', 'http2 request did not get a response', 'retry delay', 'you can retry your request', 'try your request again', 'please retry your request', 'ResourceExhausted'].join('|'), 'i');
const TOGETHER = 'Upstream error from Together: Stream error: h2 protocol error: error reading a body from connection';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function closeHard(server) { server?.closeAllConnections?.(); try { server?.close(); } catch { /* closing */ } }

const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
const finish = `data: ${JSON.stringify({ id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
const midStreamError = (message) => `data: ${JSON.stringify({ id: 'gen-1', error: { code: 'server_error', message }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}\n\n`;

// Fake OpenRouter: each call runs the next script, `(req, res, body) => void`.
function makeUpstream(scripts) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ url: req.url, headers: req.headers, body });
      const script = scripts[Math.min(calls.length - 1, scripts.length - 1)];
      script(req, res, body);
    });
  });
  return { server, calls };
}

const sse = (events, { end = true } = {}) => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(': OPENROUTER PROCESSING\n\n');
  for (const e of events) res.write(e);
  if (end) res.end(); else setTimeout(() => res.socket.destroy(), 50);
};

async function makeGuard(upPort, openrouter = {}, hooks = {}) {
  const logs = [];
  const config = { openrouter: { intercept: true, upstream: `http://127.0.0.1:${upPort}`, retryBaseMs: 1, ...openrouter } };
  const server = http.createServer(createOpenRouterListener({ config, hooks, log: l => logs.push(l) }));
  const port = await listen(server);
  return { server, port, logs };
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', method: 'POST', path: '/api/v1/chat/completions', headers: { host: 'openrouter.ai', 'content-type': 'application/json', authorization: 'Bearer sk-or-client', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}

const dataEvents = text => splitSseEvents(text).events.filter(e => e.startsWith('data:'));

test('blockedOpenRouterModel catches anthropic/* and openai/*, aliases and fallback lists', () => {
  const b = (o) => blockedOpenRouterModel(Buffer.from(JSON.stringify(o)), DEFAULT_OPENROUTER_BLOCKED);
  assert.equal(b({ model: 'anthropic/claude-opus-4.8' }).pattern, 'anthropic/*');
  assert.equal(b({ model: 'openai/gpt-5.5' }).pattern, 'openai/*');
  assert.equal(b({ model: '~anthropic/claude-sonnet-latest' }).model, '~anthropic/claude-sonnet-latest');
  assert.equal(b({ model: 'Anthropic/Claude-Opus-4.8' }).pattern, 'anthropic/*');
  assert.equal(b({ model: 'deepseek/deepseek-v4.1-flash', models: ['z-ai/glm-5.2', 'anthropic/claude-opus-4.8'] }).model, 'anthropic/claude-opus-4.8');
  assert.equal(b({ model: 'deepseek/deepseek-v4.1-flash' }), null);
  assert.equal(b({ model: 'openai-compatible/foo' }), null);
  assert.equal(blockedOpenRouterModel(Buffer.from('not json'), DEFAULT_OPENROUTER_BLOCKED), null);
  assert.equal(blockedOpenRouterModel(Buffer.from('{"model":"anthropic/x"}'), []), null);
});

test('the Together failure is transient; refusals are not', () => {
  assert.equal(isTransientFailure({ message: TOGETHER }), true);
  assert.equal(isTransientFailure({ code: 'server_error', message: 'Provider disconnected unexpectedly' }), true);
  assert.equal(isTransientFailure({ status: 502 }), true);
  assert.equal(isTransientFailure({ status: 429, message: 'Rate limit exceeded' }), false);
  assert.equal(isTransientFailure({ status: 400, message: 'This model\'s maximum context length is 1000 tokens' }), false);
  assert.equal(isTransientFailure({ status: 502, message: 'Upstream error from Google: invalid argument' }), false);
  assert.equal(isTransientFailure({ status: 402, message: 'Insufficient credits' }), false);
});

test('pi retries a hinted error and not a block', () => {
  assert.equal(PI_RETRYABLE.test(TOGETHER), false, 'the premise: pi alone gives up on this');
  assert.equal(PI_RETRYABLE.test(withRetryHint(TOGETHER)), true);
  assert.equal(withRetryHint(withRetryHint('x')), `x${RETRY_HINT}`);
  const blocked = blockedOpenRouterModel(Buffer.from('{"model":"anthropic/claude-opus-4.8"}'), DEFAULT_OPENROUTER_BLOCKED);
  assert.ok(blocked);
});

test('openrouter.ai is intercepted only when enabled, and the leaf then names it', () => {
  assert.equal(hostMode('openrouter.ai', {}), 'tunnel');
  assert.equal(hostMode('openrouter.ai', { openrouter: { intercept: false } }), 'tunnel');
  assert.equal(hostMode('openrouter.ai', { openrouter: { intercept: true } }), 'openrouter');
  assert.equal(hostMode('api.openrouter.ai', { openrouter: { intercept: true } }), 'tunnel');
  assert.deepEqual(mitmHosts({ accounts: [] }), ['api.anthropic.com']);
  assert.deepEqual(mitmHosts({ accounts: [], openrouter: { intercept: true } }), ['api.anthropic.com', 'openrouter.ai']);
});

test('a permitted model is forwarded untouched with the client key', T, async () => {
  const { server: up, calls } = makeUpstream([sse([chunk({ role: 'assistant', content: 'hi' }), finish, 'data: [DONE]\n\n'])]);
  const upPort = await listen(up);
  const g = await makeGuard(upPort);
  try {
    const body = JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', stream: true, provider: { sort: 'throughput' }, messages: [{ role: 'user', content: 'hi' }] });
    const r = await post(g.port, body, { 'http-referer': 'https://pi.dev', 'accept-encoding': 'gzip' });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/chat/completions');
    assert.equal(calls[0].body, body);
    assert.equal(calls[0].headers.authorization, 'Bearer sk-or-client');
    assert.equal(calls[0].headers['http-referer'], 'https://pi.dev');
    assert.equal(calls[0].headers['accept-encoding'], 'identity');
    assert.equal(calls[0].headers['x-api-key'], undefined);
    assert.match(r.text, /"content":"hi"/);
    assert.match(r.text, /\[DONE\]/);
  } finally { closeHard(g.server); closeHard(up); }
});

test('a blocked model gets a 400 and never reaches OpenRouter', T, async () => {
  const { server: up, calls } = makeUpstream([sse([finish])]);
  const upPort = await listen(up);
  const ends = [];
  const g = await makeGuard(upPort, {}, { onRequestEnd: (_id, info) => ends.push(info) });
  try {
    const r = await post(g.port, { model: 'anthropic/claude-opus-4.8', stream: true });
    assert.equal(r.status, 400);
    const msg = JSON.parse(r.text).error.message;
    assert.match(msg, /blocked on OpenRouter by teamclaude/);
    assert.match(msg, /teamclaude\/\*/);
    assert.equal(PI_RETRYABLE.test(msg), false, 'a block must not look retryable to pi');
    assert.equal(calls.length, 0);
    assert.equal(ends[0].account, '(blocked)');

    const control = await post(g.port, { model: 'z-ai/glm-5.2', stream: true });
    assert.equal(control.status, 200);
    assert.equal(calls.length, 1);
  } finally { closeHard(g.server); closeHard(up); }
});

test('blockedModels can be replaced, and an empty list blocks nothing', T, async () => {
  const { server: up, calls } = makeUpstream([sse([finish])]);
  const upPort = await listen(up);
  const g = await makeGuard(upPort, { blockedModels: [] });
  try {
    assert.equal((await post(g.port, { model: 'anthropic/claude-opus-4.8' })).status, 200);
    assert.equal(calls.length, 1);
  } finally { closeHard(g.server); closeHard(up); }
});

test('a transient error before any output is retried and the client sees one clean stream', T, async () => {
  const { server: up, calls } = makeUpstream([
    sse([chunk({ role: 'assistant', content: '' }), midStreamError(TOGETHER)]),
    sse([chunk({ role: 'assistant', content: '' }), chunk({ content: 'recovered' }), finish, 'data: [DONE]\n\n']),
  ]);
  const upPort = await listen(up);
  const ends = [];
  const g = await makeGuard(upPort, {}, { onRequestEnd: (_id, info) => ends.push(info) });
  try {
    const r = await post(g.port, { model: 'deepseek/deepseek-v4.1-flash', stream: true });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body, calls[0].body);
    assert.doesNotMatch(r.text, /error/);
    const events = dataEvents(r.text);
    assert.equal(events.filter(e => e.includes('"role":"assistant"')).length, 1, 'the held role delta of the failed attempt is dropped');
    assert.match(r.text, /recovered/);
    assert.match(g.logs.join('\n'), /h2 protocol error.*retry 1\/2/);
    assert.equal(ends[0].account, 'openrouter, 1 retry');
  } finally { closeHard(g.server); closeHard(up); }
});

test('an error after output is not replayed, and is tagged so pi retries the turn', T, async () => {
  const { server: up, calls } = makeUpstream([
    sse([chunk({ role: 'assistant', content: 'partial ' }), midStreamError(TOGETHER)]),
    sse([chunk({ content: 'never' }), finish]),
  ]);
  const upPort = await listen(up);
  const g = await makeGuard(upPort);
  try {
    const r = await post(g.port, { model: 'deepseek/deepseek-v4.1-flash', stream: true });
    assert.equal(calls.length, 1, 'no proxy replay once the client has output');
    assert.match(r.text, /partial /);
    assert.doesNotMatch(r.text, /never/);
    const err = dataEvents(r.text).map(e => JSON.parse(e.slice(6))).find(j => j.error);
    assert.ok(PI_RETRYABLE.test(err.error.message), err.error.message);
    assert.ok(err.error.message.startsWith(TOGETHER));
  } finally { closeHard(g.server); closeHard(up); }
});

test('a non-transient stream error passes through untouched', T, async () => {
  const refusal = 'This endpoint\'s maximum context length is 1000 tokens';
  const { server: up, calls } = makeUpstream([sse([midStreamError(refusal)])]);
  const upPort = await listen(up);
  const g = await makeGuard(upPort);
  try {
    const r = await post(g.port, { model: 'deepseek/deepseek-v4.1-flash', stream: true });
    assert.equal(calls.length, 1);
    const err = dataEvents(r.text).map(e => JSON.parse(e.slice(6))).find(j => j.error);
    assert.equal(err.error.message, refusal);
  } finally { closeHard(g.server); closeHard(up); }
});

test('a stream cut before output is retried; one cut after output is tagged', T, async () => {
  const early = makeUpstream([
    sse([chunk({ role: 'assistant', content: '' })], { end: false }),
    sse([chunk({ content: 'ok' }), finish]),
  ]);
  const late = makeUpstream([sse([chunk({ content: 'half' })], { end: false })]);
  const [p1, p2] = [await listen(early.server), await listen(late.server)];
  const g1 = await makeGuard(p1);
  const g2 = await makeGuard(p2);
  try {
    const r1 = await post(g1.port, { model: 'x/y', stream: true });
    assert.equal(early.calls.length, 2);
    assert.match(r1.text, /"content":"ok"/);

    const r2 = await post(g2.port, { model: 'x/y', stream: true });
    assert.equal(late.calls.length, 1);
    assert.match(r2.text, /half/);
    const err = dataEvents(r2.text).map(e => JSON.parse(e.slice(6))).find(j => j.error);
    assert.ok(PI_RETRYABLE.test(err.error.message));
  } finally { for (const s of [g1.server, g2.server, early.server, late.server]) closeHard(s); }
});

test('a stream that ends without a finish_reason before output is retried', T, async () => {
  const { server: up, calls } = makeUpstream([
    sse([chunk({ role: 'assistant', content: '' })]),
    sse([chunk({ content: 'ok' }), finish, 'data: [DONE]\n\n']),
  ]);
  const upPort = await listen(up);
  const g = await makeGuard(upPort);
  try {
    const r = await post(g.port, { model: 'x/y', stream: true });
    assert.equal(calls.length, 2);
    assert.match(r.text, /"content":"ok"/);
  } finally { closeHard(g.server); closeHard(up); }
});

test('a 502 is retried; when retries run out the error carries the hint', T, async () => {
  const bad = (_req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 502, message: TOGETHER } }));
  };
  const good = makeUpstream([bad, sse([chunk({ content: 'ok' }), finish])]);
  const always = makeUpstream([bad]);
  const [p1, p2] = [await listen(good.server), await listen(always.server)];
  const g1 = await makeGuard(p1);
  const g2 = await makeGuard(p2);
  try {
    const r1 = await post(g1.port, { model: 'x/y', stream: true });
    assert.equal(r1.status, 200);
    assert.equal(good.calls.length, 2);

    const r2 = await post(g2.port, { model: 'x/y', stream: true });
    assert.equal(r2.status, 502);
    assert.equal(always.calls.length, 3, 'one try plus the default two retries');
    assert.ok(PI_RETRYABLE.test(JSON.parse(r2.text).error.message));
  } finally { for (const s of [g1.server, g2.server, good.server, always.server]) closeHard(s); }
});

test('a 429 and a 400 are handed straight back, unretried', T, async () => {
  const limited = makeUpstream([(_req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' }); res.end('{"error":{"code":429,"message":"Rate limit exceeded"}}'); }]);
  const invalid = makeUpstream([(_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"code":400,"message":"invalid tools"}}'); }]);
  const [p1, p2] = [await listen(limited.server), await listen(invalid.server)];
  const g1 = await makeGuard(p1);
  const g2 = await makeGuard(p2);
  try {
    const r1 = await post(g1.port, { model: 'x/y' });
    assert.equal(r1.status, 429);
    assert.equal(r1.headers['retry-after'], '3');
    assert.equal(limited.calls.length, 1);
    const r2 = await post(g2.port, { model: 'x/y' });
    assert.equal(r2.status, 400);
    assert.equal(JSON.parse(r2.text).error.message, 'invalid tools');
    assert.equal(invalid.calls.length, 1);
  } finally { for (const s of [g1.server, g2.server, limited.server, invalid.server]) closeHard(s); }
});

test('a refused connection is retried, then reported with the hint', T, async () => {
  const dead = net.createServer();
  const deadPort = await listen(dead);
  await new Promise(r => dead.close(r));
  const g = await makeGuard(deadPort, { retries: 1 });
  try {
    const r = await post(g.port, { model: 'x/y', stream: true });
    assert.equal(r.status, 502);
    assert.ok(PI_RETRYABLE.test(JSON.parse(r.text).error.message));
    assert.match(g.logs.join('\n'), /retry 1\/1/);
  } finally { closeHard(g.server); }
});

test('retries: 0 turns the proxy retry off but still tags the error', T, async () => {
  const { server: up, calls } = makeUpstream([sse([midStreamError(TOGETHER)]), sse([finish])]);
  const upPort = await listen(up);
  const g = await makeGuard(upPort, { retries: 0 });
  try {
    const r = await post(g.port, { model: 'x/y', stream: true });
    assert.equal(calls.length, 1);
    const err = dataEvents(r.text).map(e => JSON.parse(e.slice(6))).find(j => j.error);
    assert.ok(PI_RETRYABLE.test(err.error.message));
  } finally { closeHard(g.server); closeHard(up); }
});

test('a request naming another host is refused inside the tunnel', T, async () => {
  const { server: up, calls } = makeUpstream([sse([finish])]);
  const upPort = await listen(up);
  const g = await makeGuard(upPort);
  try {
    const r = await post(g.port, { model: 'x/y' }, { host: 'api.anthropic.com' });
    assert.equal(r.status, 421);
    assert.equal(calls.length, 0);
  } finally { closeHard(g.server); closeHard(up); }
});

// End to end through CONNECT: the account pool is configured with a real-looking token,
// and none of it may reach OpenRouter.
test('MITM: CONNECT openrouter.ai forwards the client key and never an account credential', T, async () => {
  const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain(['openrouter.ai', 'localhost']);
  const { server: up, calls } = makeUpstream([sse([chunk({ content: 'ok' }), finish])]);
  const upPort = await listen(up);
  const am = new AccountManager([{ name: 'acct@x', type: 'oauth', accessToken: 'REAL-TOKEN', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const config = { openrouter: { intercept: true, upstream: `http://127.0.0.1:${upPort}` }, accounts: [] };
  const proxy = http.createServer();
  proxy.on('connect', createConnectHandler({
    config, accountManager: am, log: () => {},
    ensureLeaf: async () => ({ key: leafKeyPem, cert: leafCertPem }),
    leafHosts: ['api.anthropic.com', 'openrouter.ai'],
  }));
  const proxyPort = await listen(proxy);
  const raw = net.connect(proxyPort, '127.0.0.1');
  await once(raw, 'connect');
  raw.write('CONNECT openrouter.ai:443 HTTP/1.1\r\nHost: openrouter.ai:443\r\n\r\n');
  const head = await new Promise((resolve) => {
    let buf = '';
    const onData = (d) => { buf += d; if (buf.includes('\r\n\r\n')) { raw.off('data', onData); resolve(buf); } };
    raw.on('data', onData);
  });
  assert.match(head, /^HTTP\/1\.1 200/);
  const sock = tls.connect({ socket: raw, servername: 'openrouter.ai', ca: [caCertPem], ALPNProtocols: ['h2'] });
  await once(sock, 'secureConnect');
  const client = http2.connect('https://openrouter.ai', { createConnection: () => sock });
  try {
    const blocked = client.request({ ':method': 'POST', ':path': '/api/v1/chat/completions', authorization: 'Bearer sk-or-client', 'content-type': 'application/json' });
    let blockedStatus;
    blocked.on('response', h => { blockedStatus = h[':status']; });
    blocked.resume();
    blocked.end('{"model":"anthropic/claude-opus-4.8","stream":true}');
    await once(blocked, 'close');
    assert.equal(blockedStatus, 400);

    const req = client.request({ ':method': 'POST', ':path': '/api/v1/chat/completions', authorization: 'Bearer sk-or-client', 'content-type': 'application/json' });
    let text = '';
    req.setEncoding('utf8');
    req.on('data', d => { text += d; });
    req.end('{"model":"deepseek/deepseek-v4.1-flash","stream":true}');
    await once(req, 'close');
    assert.match(text, /"content":"ok"/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers.authorization, 'Bearer sk-or-client');
    assert.ok(!JSON.stringify(calls[0].headers).includes('REAL-TOKEN'));
  } finally {
    client.destroy();
    closeHard(proxy); closeHard(up);
  }
});
