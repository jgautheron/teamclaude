import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { codexBucketEntries, codexBucketLabel, codexGatingUtilization } from '../src/model.js';

const codex = (name, extra = {}) => ({
  name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name,
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra,
});

const weekly = (usedPercent, extra = {}) => ({
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': String(usedPercent),
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
  ...extra,
});

// Headers of a Spark response: the account-wide weekly plus the family's own
// 5h and weekly windows, named by `-limit-name`.
const spark = (familyPercent, weeklyPercent = 10) => weekly(weeklyPercent, {
  'x-codex-bengalfox-primary-used-percent': '0',
  'x-codex-bengalfox-primary-window-minutes': '300',
  'x-codex-bengalfox-secondary-used-percent': String(familyPercent),
  'x-codex-bengalfox-secondary-window-minutes': '10080',
  'x-codex-bengalfox-secondary-reset-at': String(Math.floor(Date.now() / 1000) + 7200),
  'x-codex-bengalfox-limit-name': 'GPT-5.3-Codex-Spark',
});

const monthly = (usedPercent) => ({
  'x-codex-plan-type': 'free',
  'x-codex-primary-used-percent': String(usedPercent),
  'x-codex-primary-window-minutes': String(30 * 24 * 60),
  'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 86400),
});

// ── monthly window ───────────────────────────────────────────

test('a monthly-only plan at its limit is spent, not "no weekly, all clear"', () => {
  const am = new AccountManager([codex('go'), codex('pro')], 0.98);
  am.updateQuota(0, monthly(100));
  am.updateQuota(1, weekly(10));
  assert.equal(am.accounts[0].quota.unified30d, 1);
  assert.equal(am.accounts[0].quota.unified7d, null);
  assert.equal(am.getActiveAccount(null, null, null, null, 'codex').name, 'pro');
});

test('learning a monthly window ends probing like a weekly one does', () => {
  const am = new AccountManager([codex('go')], 0.98);
  assert.equal(am.accounts[0].probing, true);
  am.updateQuota(0, monthly(5));
  assert.equal(am.accounts[0].probing, false);
});

test('the monthly window has its own threshold and cap keys', () => {
  const am = new AccountManager([codex('go', { maxUsage: { unified30d: 0.5 } })], { default: 0.98, unified30d: 0.7 });
  am.updateQuota(0, monthly(60));
  assert.equal(am.capExceeded(am.accounts[0]), 'unified30d');
  am.accounts[0].maxUsage = null;
  assert.equal(am._isNearQuota(am.accounts[0]), false);
  am.updateQuota(0, monthly(75));
  assert.equal(am._isNearQuota(am.accounts[0]), true);
});

test('a monthly window that has reset is forgotten', () => {
  const am = new AccountManager([codex('go')], 0.98);
  am.updateQuota(0, monthly(100));
  am.accounts[0].quota.unified30dReset = Date.now() - 1;
  assert.equal(am._isNearQuota(am.accounts[0]), false);
  assert.equal(am.accounts[0].quota.unified30d, null);
});

// ── model-scoped buckets ─────────────────────────────────────

test('a spent Spark bucket bars Spark on that account and nothing else', () => {
  const am = new AccountManager([codex('a'), codex('b')], 0.98);
  am.updateQuota(0, spark(100));
  am.updateQuota(1, spark(0, 50));
  // Spark goes to the account whose Spark bucket has headroom...
  assert.equal(am.getActiveAccount(null, 'gpt-5.3-codex-spark', null, null, 'codex').name, 'b');
  // ...while the ordinary model stays on the first account, which has more weekly left.
  assert.equal(am.getActiveAccount(null, 'gpt-5.4-mini', null, null, 'codex').name, 'a');
  assert.equal(am.modelBucketSpent(0, 'gpt-5.3-codex-spark'), 'GPT-5.3-Codex-Spark');
  assert.equal(am.modelBucketSpent(0, 'gpt-5.4-mini'), null);
});

test('a family bucket is matched by its display name, case-insensitively, prefix included', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, spark(100));
  assert.ok(am._codexBucket(am.accounts[0], 'GPT-5.3-CODEX-SPARK'));
  assert.ok(am._codexBucket(am.accounts[0], 'gpt-5.3-codex-spark-2026-01-01'));
  assert.equal(am._codexBucket(am.accounts[0], 'gpt-5.3-codex'), null);
  assert.equal(am._codexBucket(am.accounts[0], null), null);
});

test('the shared weekly still gates a family, since family spend meters into both', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, spark(0, 99));
  assert.equal(am._isNearQuota(am.accounts[0], 'gpt-5.3-codex-spark'), true);
  // Not "Spark only": the shared weekly is what is spent.
  assert.equal(am.modelBucketSpent(0, 'gpt-5.3-codex-spark'), null);
});

test('a family bucket has its own threshold and cap keys, `codex:<slug>`', () => {
  const am = new AccountManager([codex('a', { maxUsage: { 'codex:bengalfox': 0.5 } })], { default: 0.98, 'codex:bengalfox': 0.7 });
  am.updateQuota(0, spark(60));
  assert.equal(am.capExceeded(am.accounts[0], 'gpt-5.3-codex-spark'), 'codex:bengalfox');
  assert.equal(am.capExceeded(am.accounts[0], 'gpt-5.4-mini'), null);
  am.accounts[0].maxUsage = null;
  assert.equal(am._isNearQuota(am.accounts[0], 'gpt-5.3-codex-spark'), false);
  am.updateQuota(0, spark(75));
  assert.equal(am._isNearQuota(am.accounts[0], 'gpt-5.3-codex-spark'), true);
});

// The bucket rides only on Spark responses and selection stops sending those
// once it reads spent, so a spent reading must expire on its own (#167).
test('a spent family reading goes stale and is revalidated, a healthy one is kept', () => {
  const am = new AccountManager([codex('a')], 0.98, { familyStaleMs: 1000 });
  am.updateQuota(0, spark(100));
  const q = am.accounts[0].quota;
  q.codexModelBuckets.bengalfox.seenAt = Date.now() - 2000;
  assert.equal(am._isNearQuota(am.accounts[0], 'gpt-5.3-codex-spark'), false);
  assert.equal(q.codexModelBuckets.bengalfox, undefined);

  am.updateQuota(0, spark(20));
  q.codexModelBuckets.bengalfox.seenAt = Date.now() - 2000;
  am._clearExpiredQuotas(am.accounts[0]);
  assert.equal(q.codexModelBuckets.bengalfox.utilization, 0.2, 'a reading with headroom gates nothing and is kept');
});

test('a family bucket whose window has reset is forgotten', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, spark(100));
  am.accounts[0].quota.codexModelBuckets.bengalfox.resetAt = Date.now() - 1;
  assert.equal(am._isNearQuota(am.accounts[0], 'gpt-5.3-codex-spark'), false);
});

// ── probe application ────────────────────────────────────────

test('a usage-probe reading applies through the same fields and refreshes the stamp', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, spark(100));
  const before = am.accounts[0].quota.codexModelBuckets.bengalfox.seenAt = 1;
  am.applyCodexUsageData(0, {
    unified7d: 0.4, unified7dReset: Date.now() + 1000, planType: 'pro',
    modelBuckets: [{ slug: 'bengalfox', name: 'GPT-5.3-Codex-Spark', utilization: 0.1, resetAt: Date.now() + 5000 }],
  });
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, 0.4);
  assert.equal(q.planType, 'pro');
  assert.equal(q.codexModelBuckets.bengalfox.utilization, 0.1);
  assert.ok(q.codexModelBuckets.bengalfox.seenAt > before);
  assert.equal(am.accounts[0].usage.totalRequests, 1, 'a probe is not a request');
});

test('a failed probe changes nothing', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, weekly(42));
  am.applyCodexUsageData(0, { error: 'HTTP 500', status: 500 });
  am.applyCodexUsageData(0, null);
  assert.equal(am.accounts[0].quota.unified7d, 0.42);
});

// ── persistence ──────────────────────────────────────────────

test('the monthly window, the family buckets and the plan survive a restart', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, spark(30));
  am.updateQuota(0, monthly(40));
  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  const fresh = new AccountManager([codex('a')], 0.98);
  fresh.restoreQuotaState(saved);
  const q = fresh.accounts[0].quota;
  assert.equal(q.unified30d, 0.4);
  assert.equal(q.planType, 'free');
  assert.equal(q.codexModelBuckets.bengalfox.utilization, 0.3);
  assert.equal(fresh.accounts[0].probing, false);
});

// ── renderer helpers ─────────────────────────────────────────

test('bucket entries are sorted, keyed and labelled for the renderers', () => {
  const entries = codexBucketEntries({
    unified7d: 0.5,
    codexModelBuckets: {
      zebra: { name: 'GPT-9-Codex-Zebra', utilization: 0.2 },
      bengalfox: { name: 'GPT-5.3-Codex-Spark', utilization: 0.9, resetAt: 5 },
      broken: null,
      unknown: { name: 'x' },
    },
  });
  assert.deepEqual(entries.map(e => [e.slug, e.key, e.label, e.name]), [
    ['bengalfox', 'codex:bengalfox', 'Sp7', 'GPT-5.3-Codex-Spark'],
    ['zebra', 'codex:zebra', 'Ze7', 'GPT-9-Codex-Zebra'],
  ]);
  assert.equal(codexGatingUtilization({ unified7d: 0.5 }, entries[0]), 0.9);
  assert.equal(codexGatingUtilization({ unified7d: 0.95 }, entries[0]), 0.95);
  assert.equal(codexGatingUtilization({}, { utilization: null }), null);
  assert.deepEqual(codexBucketEntries({}), []);
  assert.deepEqual(codexBucketEntries(null), []);
  assert.equal(codexBucketLabel('spark'), 'Sp7');
  assert.equal(codexBucketLabel(''), '?7');
});
