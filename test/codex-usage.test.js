import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  parseCodexUsagePayload, parseCodexRateLimitsEvent, parseCodexQuota, fetchCodexUsage,
  classifyCodexRejection, familySlug,
} from '../src/codex-quota.js';
import { setUpstreamProxy, resolveUpstreamProxy, resetUpstreamProxy } from '../src/upstream-proxy.js';

test.beforeEach(() => setUpstreamProxy(resolveUpstreamProxy({ upstreamProxy: false }, {})));
test.afterEach(() => resetUpstreamProxy());

// A live `/backend-api/wham/usage` payload from a Pro plan (ids redacted, the
// numbers kept). The shape is the point: the weekly window sits in
// `primary_window` with `secondary_window` null, and the model-scoped family
// carries a 5-hour primary and a weekly secondary.
const USAGE_PRO = {
  user_id: 'user-redacted',
  account_id: 'acct-redacted',
  email: 'redacted@example.com',
  plan_type: 'pro',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 77, limit_window_seconds: 604800, reset_after_seconds: 503762, reset_at: 1789203359 },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: [{
    limit_name: 'GPT-5.3-Codex-Spark',
    metered_feature: 'codex_bengalfox',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: 1788717597 },
      secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800, reset_at: 1789304397 },
    },
    normal_model_slug: null,
  }],
  model_usage: { 'gpt-6-astra': { available: true, available_at: null, credits_would_enable: false } },
  credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: '0' },
  rate_limit_reached_type: null,
  rate_limit_reset_credits: { available_count: 0, applicable_available_count: 0 },
};

// The first WebSocket frame of every response, captured live (same account).
const RATE_LIMITS_EVENT = {
  type: 'codex.rate_limits',
  plan_type: 'pro',
  rate_limits: {
    allowed: true,
    limit_reached: false,
    primary: { used_percent: 78, window_minutes: 10080, reset_after_seconds: 503555, reset_at: 1789203359 },
    secondary: null,
  },
  code_review_rate_limits: null,
  additional_rate_limits: {
    'GPT-5.3-Codex-Spark': {
      allowed: true,
      limit_reached: false,
      primary: { used_percent: 0, window_minutes: 300, reset_after_seconds: 18000, reset_at: 1788717805 },
      secondary: { used_percent: 0, window_minutes: 10080, reset_after_seconds: 604800, reset_at: 1789304605 },
    },
  },
  credits: { has_credits: false, unlimited: false, balance: '0' },
};

// ── usage payload ────────────────────────────────────────────

test('a Pro usage payload lands the weekly window and the Spark family', () => {
  const q = parseCodexUsagePayload(USAGE_PRO);
  assert.equal(q.unified7d, 0.77);
  assert.equal(q.unified7dReset, 1789203359 * 1000);
  assert.equal(q.unified5h, undefined, 'no account-wide 5h window on this plan');
  assert.equal(q.unified30d, undefined);
  assert.equal(q.planType, 'pro');
  assert.equal(q.limitReached, false);
  assert.deepEqual(q.modelBuckets, [{
    slug: 'bengalfox', name: 'GPT-5.3-Codex-Spark', utilization: 0, resetAt: 1789304397 * 1000,
  }]);
});

// The family slug is what keys the bucket on the account, so the probe and the
// headers (`x-codex-bengalfox-*`) MUST agree on it.
test('the usage payload keys a family by the same slug the headers use', () => {
  const fromUsage = parseCodexUsagePayload(USAGE_PRO).modelBuckets[0].slug;
  const fromHeaders = parseCodexQuota({
    'x-codex-bengalfox-secondary-used-percent': '5',
    'x-codex-bengalfox-secondary-window-minutes': '10080',
    'x-codex-bengalfox-limit-name': 'GPT-5.3-Codex-Spark',
  }).modelBuckets[0].slug;
  assert.equal(fromUsage, fromHeaders);
  assert.equal(familySlug({ meteredFeature: 'codex_bengalfox' }), 'bengalfox');
  assert.equal(familySlug({ limitName: 'GPT-5.3-Codex-Spark' }), 'gpt-5-3-codex-spark');
  assert.equal(familySlug({}), null);
});

// A Go/Free plan meters only a month. That reading must gate, so it must
// land somewhere selection reads rather than being dropped as unrecognised.
test('a monthly-only plan lands in the 30-day bucket and nowhere else', () => {
  const q = parseCodexUsagePayload({
    plan_type: 'free',
    rate_limit: {
      primary_window: { used_percent: 100, limit_window_seconds: 30 * 24 * 3600, reset_at: 1790000000 },
      secondary_window: null,
    },
  });
  assert.equal(q.unified30d, 1);
  assert.equal(q.unified30dReset, 1790000000 * 1000);
  assert.equal(q.unified7d, undefined);
  assert.equal(q.unified5h, undefined);
});

test('a plan with a 5h window, a weekly and a month reports all three', () => {
  const q = parseCodexUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 2 },
      tertiary_window: { used_percent: 30, limit_window_seconds: 28 * 24 * 3600, reset_at: 3 },
    },
  });
  assert.equal(q.unified5h, 0.1);
  assert.equal(q.unified7d, 0.2);
  assert.equal(q.unified30d, 0.3);
  assert.equal(q.unified30dReset, 3000);
});

// Older payloads carry no `limit_window_seconds`; that was always the weekly.
test('a window with no stated duration is the legacy weekly reading', () => {
  const q = parseCodexUsagePayload({ rate_limit: { primary_window: { used_percent: 55, reset_at: 7 } } });
  assert.equal(q.unified7d, 0.55);
  assert.equal(q.unified7dReset, 7000);
});

test('a missing or null window contributes nothing', () => {
  assert.deepEqual(parseCodexUsagePayload({ rate_limit: { primary_window: null, secondary_window: null } }), {});
  assert.deepEqual(parseCodexUsagePayload({}), {});
  assert.deepEqual(parseCodexUsagePayload(null), {});
  assert.deepEqual(parseCodexUsagePayload('nope'), {});
});

test('a reached type on the payload is surfaced', () => {
  const q = parseCodexUsagePayload({ ...USAGE_PRO, rate_limit_reached_type: 'rate_limit_reached' });
  assert.equal(q.reachedType, 'rate_limit_reached');
});

// ── WebSocket event ──────────────────────────────────────────

test('a codex.rate_limits event parses to the same fields as the headers', () => {
  const q = parseCodexRateLimitsEvent(RATE_LIMITS_EVENT);
  assert.equal(q.unified7d, 0.78);
  assert.equal(q.unified7dReset, 1789203359 * 1000);
  assert.equal(q.planType, 'pro');
  assert.deepEqual(q.modelBuckets, [{
    // No metered_feature on the event, so the display name is slugified.
    slug: 'gpt-5-3-codex-spark', name: 'GPT-5.3-Codex-Spark', utilization: 0, resetAt: 1789304605 * 1000,
  }]);
});

test('the event parser accepts the raw frame text and rejects other frames', () => {
  assert.equal(parseCodexRateLimitsEvent(JSON.stringify(RATE_LIMITS_EVENT)).unified7d, 0.78);
  assert.equal(parseCodexRateLimitsEvent('{"type":"response.created"}'), null);
  assert.equal(parseCodexRateLimitsEvent('not json'), null);
  assert.equal(parseCodexRateLimitsEvent(null), null);
});

// ── fetch ────────────────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('fetchCodexUsage sends the token and the account id, and parses the reply', async () => {
  let seen = null;
  const server = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(USAGE_PRO));
  });
  const port = await listen(server);
  try {
    const q = await fetchCodexUsage('tok', 'acct-1', `http://127.0.0.1:${port}/backend-api/wham/usage`);
    assert.equal(q.unified7d, 0.77);
    assert.equal(seen.authorization, 'Bearer tok');
    assert.equal(seen['chatgpt-account-id'], 'acct-1');
  } finally {
    server.close();
  }
});

test('fetchCodexUsage reports a 401 as a status the prober can act on', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'expired' }));
  });
  const port = await listen(server);
  try {
    const r = await fetchCodexUsage('tok', 'acct-1', `http://127.0.0.1:${port}/`);
    assert.equal(r.status, 401);
    assert.match(r.error, /HTTP 401: expired/);
  } finally {
    server.close();
  }
});

test('fetchCodexUsage never throws on a dead endpoint', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  const r = await fetchCodexUsage('tok', 'acct-1', `http://127.0.0.1:${port}/`);
  assert.ok(r.error);
  assert.equal(r.status, null);
});

// ── rejection classification ─────────────────────────────────

test('a 429 carrying the reached-type header is a spent quota', () => {
  const c = classifyCodexRejection({ status: 429, headers: { 'X-Codex-Rate-Limit-Reached-Type': 'rate_limit_reached', 'retry-after': '120' } });
  assert.equal(c.kind, 'quota');
  assert.equal(c.reachedType, 'rate_limit_reached');
  assert.equal(c.retryAfter, 120);
});

test('a 429 whose body names a usage limit is a spent quota', () => {
  const c = classifyCodexRejection({ status: 429, body: JSON.stringify({ error: { type: 'usage_limit_reached', message: 'x' } }) });
  assert.equal(c.kind, 'quota');
  assert.equal(c.code, 'usage_limit_reached');
  assert.equal(classifyCodexRejection({ status: 429, body: JSON.stringify({ error: { code: 'usage_limit_exceeded' } }) }).kind, 'quota');
});

test('a plain 429 is a rate limit, and a 402 is spent credits', () => {
  assert.equal(classifyCodexRejection({ status: 429 }).kind, 'rate-limit');
  assert.equal(classifyCodexRejection({ status: 429, body: '{"error":{"type":"server_error"}}' }).kind, 'rate-limit');
  assert.equal(classifyCodexRejection({ status: 429, body: 'not json' }).kind, 'rate-limit');
  assert.equal(classifyCodexRejection({ status: 402 }).kind, 'quota');
});

test('an entitlement denial is neither quota nor credential', () => {
  assert.equal(classifyCodexRejection({ status: 403, body: '{"error":{"code":"codex_entitlement_missing"}}' }).kind, 'entitlement');
  assert.equal(classifyCodexRejection({ status: 403, body: '{"detail":{"code":"codex_workspace_access_denied"}}' }).kind, 'other');
  assert.equal(classifyCodexRejection({ status: 403, body: '{"code":"codex_workspace_access_denied"}' }).kind, 'entitlement');
  assert.equal(classifyCodexRejection({ status: 403 }).kind, 'other');
  assert.equal(classifyCodexRejection({ status: 400, body: '{"error":{"code":"model_not_found"}}' }).kind, 'entitlement');
  assert.equal(classifyCodexRejection({ status: 401 }).kind, 'credential');
  assert.equal(classifyCodexRejection({ status: 500 }).kind, 'other');
  assert.equal(classifyCodexRejection({}).kind, 'other');
});
