import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, sessionIdOf } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const codex = (name) => ({
  name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name,
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000,
});

// An upstream that answers per account (by the injected bearer token), so a
// test can spend one account and leave the other healthy.
async function withProxy(answers, run) {
  const hits = [];
  const upstream = http.createServer((req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    hits.push({ token, accountId: req.headers['chatgpt-account-id'], url: req.url });
    const answer = answers[token] || answers.default;
    res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers || {}) });
    res.end(JSON.stringify(answer.body || { ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([codex('a'), codex('b')], 0.98);
  // Codex accounts default to chatgpt.com; the test upstream stands in for it.
  for (const a of am.accounts) a.upstream = `http://127.0.0.1:${upstreamPort}`;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}` });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/backend-api/codex/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', session_id: 'sess-1' },
      body: JSON.stringify({ model: 'gpt-5.4-mini', input: [] }),
    });
    const text = await res.text();
    return await run({ res, text, hits, am });
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('a Codex quota 429 (reached-type header) rotates to the next account and holds the first', async () => {
  await withProxy({
    't-a': { status: 429, headers: { 'x-codex-rate-limit-reached-type': 'rate_limit_reached', 'retry-after': '90',
      'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '10080' } },
    't-b': { status: 200, headers: { 'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '10080' } },
  }, ({ res, hits, am }) => {
    assert.equal(res.status, 200);
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b']);
    assert.equal(hits[1].accountId, 'acct-b');
    assert.equal(am.accounts[0].quota.unified7d, 1, 'the spent reading came off the 429 headers');
    assert.equal(am.accounts[0].status, 'throttled');
    assert.equal(am.accounts[1].quota.unified7d, 0.12);
  });
});

test('a Codex quota 429 named only in the body also rotates', async () => {
  await withProxy({
    't-a': { status: 429, body: { error: { type: 'usage_limit_reached', message: 'spent' } } },
    't-b': { status: 200 },
  }, ({ res, hits }) => {
    assert.equal(res.status, 200);
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b']);
  });
});

test('a 402 (credits depleted) is treated as a spent quota', async () => {
  await withProxy({
    't-a': { status: 402, body: { error: { code: 'insufficient_quota' } } },
    't-b': { status: 200 },
  }, ({ res, hits, am }) => {
    assert.equal(res.status, 200);
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b']);
    assert.equal(am.accounts[0].status, 'throttled');
  });
});

// A plain 429 is the per-minute throttle: the shared path pauses and retries
// the SAME account, with one hop to an idle sibling — never a rotation.
test('a plain Codex 429 is a rate limit, not a rotation', async () => {
  await withProxy({
    't-a': { status: 429, headers: { 'retry-after': '1' }, body: { error: { type: 'rate_limit_error' } } },
    't-b': { status: 200 },
  }, ({ res, am }) => {
    assert.equal(res.status, 200);
    assert.equal(am.accounts[0].status, 'active', 'not throttled: no rotation on a rate-limit 429');
    assert.ok(am.accounts[0].pausedUntil > Date.now(), 'paused so concurrent requests wait');
  });
});

test('a Codex entitlement 403 cools the account down and fails over', async () => {
  await withProxy({
    't-a': { status: 403, body: { error: { code: 'codex_entitlement_missing', message: 'no' } } },
    't-b': { status: 200 },
  }, ({ res, hits, am }) => {
    assert.equal(res.status, 200);
    assert.deepEqual(hits.map(h => h.token), ['t-a', 't-b']);
    assert.ok(am.accounts[0].entitlementDeniedUntil > Date.now());
  });
});

test('with every Codex account spent the client gets a 429 with a retry-after', async () => {
  await withProxy({
    default: { status: 429, headers: { 'x-codex-rate-limit-reached-type': 'rate_limit_reached', 'retry-after': '30' } },
  }, ({ res }) => {
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
  });
});

test('Codex headers on a 200 feed the quota, and the session is tracked by session_id', async () => {
  await withProxy({
    't-a': { status: 200, headers: { 'x-codex-primary-used-percent': '33', 'x-codex-primary-window-minutes': '10080', 'x-codex-plan-type': 'pro' } },
  }, ({ res, am }) => {
    assert.equal(res.status, 200);
    assert.equal(am.accounts[0].quota.unified7d, 0.33);
    assert.equal(am.accounts[0].quota.planType, 'pro');
  });
});

// ── sessionIdOf ──────────────────────────────────────────────

test('sessionIdOf reads the Claude header first, then a namespaced Codex session id', () => {
  const req = (url, headers) => ({ url, headers });
  assert.equal(sessionIdOf(req('/v1/messages', { 'x-claude-code-session-id': 'abc' })), 'abc');
  assert.equal(sessionIdOf(req('/backend-api/codex/responses', { session_id: 'sess-1' })), 'codex:sess-1');
  assert.equal(sessionIdOf(req('/backend-api/codex/responses', { 'session-id': 'sess-2' })), 'codex:sess-2');
  // The parent thread is affinity, not identity: two siblings must not collapse.
  assert.equal(sessionIdOf(req('/backend-api/codex/responses', { 'x-codex-parent-thread-id': 'p' })), null);
  // A Codex header on an Anthropic path names nothing.
  assert.equal(sessionIdOf(req('/v1/messages', { session_id: 'sess-1' })), null);
  assert.equal(sessionIdOf(req('/v1/messages', {})), null);
  // Control characters are client-supplied and are stripped.
  assert.equal(sessionIdOf(req('/backend-api/codex/responses', { session_id: 'a\x1b[31mb' })), 'codex:a b');
});
