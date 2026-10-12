import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyRequestListener } from '../src/server.js';
import { providerForPath, upstreamPathFor, canServeProvider } from '../src/provider.js';
import { fetchBackendQuota } from '../src/backend-quota.js';

const claude = (name) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
const anthropicKey = (name) => ({ name, type: 'apikey', apiKey: 'k-' + name });
const go = (name, extra = {}) => ({ name, type: 'apikey', provider: 'opencode-go', apiKey: 'k-' + name, ...extra });
const zen = (name, extra = {}) => go(name, { plan: 'zen', priority: 100, ...extra });

test('/zen/go paths belong to OpenCode Go, everything else keeps its provider', () => {
  assert.equal(providerForPath('/zen/go/v1/chat/completions'), 'opencode-go');
  assert.equal(providerForPath('/zen/go/v1/messages'), 'opencode-go');
  assert.equal(providerForPath('/zen/gopher/v1/messages'), 'anthropic');
  assert.equal(providerForPath('/v1/messages'), 'anthropic');
  assert.equal(providerForPath('/backend-api/codex/responses'), 'codex');
});

test('a Zen key serves a Go request from Zen\'s own endpoints; a Go key forwards verbatim', () => {
  assert.equal(upstreamPathFor(go('g'), '/zen/go/v1/chat/completions'), '/zen/go/v1/chat/completions');
  assert.equal(upstreamPathFor(zen('z'), '/zen/go/v1/chat/completions'), '/zen/v1/chat/completions');
  assert.equal(upstreamPathFor(zen('z'), '/zen/go/v1/messages?beta=true'), '/zen/v1/messages?beta=true');
});

test('one base URL serves every Go model: a missing /v1 is restored', () => {
  assert.equal(upstreamPathFor(go('g'), '/zen/go/chat/completions'), '/zen/go/v1/chat/completions');
  assert.equal(upstreamPathFor(go('g'), '/zen/go/responses'), '/zen/go/v1/responses');
  assert.equal(upstreamPathFor(go('g'), '/zen/go/v1'), '/zen/go/v1');
  assert.equal(upstreamPathFor(go('g'), '/zen/go/v1beta/x'), '/zen/go/v1/v1beta/x');
  assert.equal(upstreamPathFor(zen('z'), '/zen/go/chat/completions'), '/zen/v1/chat/completions');
  assert.equal(upstreamPathFor({ name: 'c', type: 'oauth' }, '/zen/go/chat/completions'), '/zen/go/chat/completions');
});

test('OpenCode keys and other accounts never cross, API keys included', () => {
  assert.equal(canServeProvider(go('g'), 'opencode-go'), true);
  assert.equal(canServeProvider(go('g'), 'anthropic'), false);
  assert.equal(canServeProvider(go('g'), 'codex'), false);
  assert.equal(canServeProvider(anthropicKey('a'), 'opencode-go'), false);
  assert.equal(canServeProvider(claude('c'), 'opencode-go'), false);
  // The pre-existing rule for an Anthropic key stands.
  assert.equal(canServeProvider(anthropicKey('a'), 'codex'), true);
});

test('selection for an OpenCode request picks Go subscriptions before the Zen fallback', () => {
  const am = new AccountManager([claude('c'), anthropicKey('a'), zen('z'), go('g1'), go('g2')], 0.98);
  const picked = am.getActiveAccount(null, null, null, null, 'opencode-go');
  assert.equal(picked.name, 'g1');
  const next = am.getActiveAccount(new Set([picked.index]), null, null, null, 'opencode-go');
  assert.equal(next.name, 'g2');
  const last = am.getActiveAccount(new Set([picked.index, next.index]), null, null, null, 'opencode-go');
  assert.equal(last.name, 'z');
  assert.equal(am.getActiveAccount(new Set([picked.index, next.index, last.index]), null, null, null, 'opencode-go'), null);
});

test('the Go usage reading parses into windows, and a non-ok status reads as spent', async () => {
  const body = { usage: {
    rolling: { status: 'ok', percent: 34, resetsAt: '2099-01-01T00:00:00.000Z' },
    weekly: { status: 'limited', percent: 98, resetsAt: '2099-01-02T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 27, resetsAt: '2099-02-01T00:00:00.000Z' },
  } };
  let asked = null;
  const fetchImpl = async (url, opts) => { asked = { url, auth: opts.headers.Authorization }; return { ok: true, headers: { get: () => null }, json: async () => body }; };
  const reading = await fetchBackendQuota({ ...go('g'), credential: 'k-g' }, { fetchImpl });
  assert.equal(asked.url, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(asked.auth, 'Bearer k-g');
  assert.equal(reading.windows.fiveHour.utilization, 0.34);
  assert.equal(reading.windows.weekly.utilization, 1);
  assert.equal(reading.utilization, 1);
  assert.equal(await fetchBackendQuota({ ...zen('z'), credential: 'k-z' }, { fetchImpl }), null, 'a Zen key has no plan to read');
});

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

// One local recorder stands in for opencode.ai: each account's `upstream`
// points at it, and `answer` decides per key what the gateway says.
async function withGateway(accounts, answer, run) {
  const seen = [];
  const { server: gateway, port: gwPort } = await listen((req, res) => {
    const key = req.headers['x-api-key'];
    seen.push({ url: req.url, key, bearer: req.headers.authorization, session: req.headers['x-opencode-session'] });
    if (req.url.endsWith('/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ usage: { rolling: { status: 'limited', percent: 100, resetsAt: new Date(Date.now() + 600_000).toISOString() } } }));
      return;
    }
    const [status, payload] = answer(key);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const upstream = `http://127.0.0.1:${gwPort}`;
  const am = new AccountManager(accounts.map(a => ({ ...a, upstream })), 0.98);
  const { server: proxy, port } = await listen(createProxyRequestListener({ accountManager: am, upstream }));
  try {
    return await run({ port, seen, am });
  } finally {
    proxy.closeAllConnections?.(); proxy.close();
    gateway.close();
  }
}

const chat = (port) => fetch(`http://127.0.0.1:${port}/zen/go/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer client-dummy', 'x-opencode-session': 'sess-1' },
  body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
});

test('a spent Go key is held until its window resets and the request moves to the next key', async () => {
  const answer = (key) => key === 'k-g1' ? [429, { error: { message: 'limit' } }] : [200, { ok: key }];
  await withGateway([go('g1'), go('g2'), claude('c')], answer, async ({ port, seen, am }) => {
    const res = await chat(port);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: 'k-g2' });
    const g1 = am.accounts.find(a => a.name === 'g1');
    assert.equal(g1.status, 'throttled');
    assert.ok(g1.rateLimitedUntil - Date.now() > 500_000, 'the hold should run to the spent window\'s reset');
    const inference = seen.filter(s => !s.url.endsWith('/usage'));
    assert.deepEqual(inference.map(s => s.key), ['k-g1', 'k-g2']);
    assert.ok(inference.every(s => s.bearer === `Bearer ${s.key}`), 'the client\'s own key must be replaced');
    assert.ok(inference.every(s => s.session === 'sess-1'), 'the session header reaches the gateway');
  });
});

test('once every Go key is spent, a Zen key serves the request on Zen\'s path; a 402 there rotates too', async () => {
  const answer = (key) => key === 'k-z2' ? [200, { ok: key }] : key === 'k-z1' ? [402, { error: { message: 'no credits' } }] : [429, {}];
  await withGateway([go('g1'), zen('z1'), zen('z2')], answer, async ({ port, seen }) => {
    const res = await chat(port);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: 'k-z2' });
    const inference = seen.filter(s => !s.url.endsWith('/usage'));
    assert.deepEqual(inference.map(s => [s.key, s.url]), [
      ['k-g1', '/zen/go/v1/chat/completions'],
      ['k-z1', '/zen/v1/chat/completions'],
      ['k-z2', '/zen/v1/chat/completions'],
    ]);
  });
});
