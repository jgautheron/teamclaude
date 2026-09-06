import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, blockedFamilies } from '../src/tui.js';
import { renderStatus } from '../src/status-renderer.js';
import { scopedWeeklyRows } from '../src/dashboard.js';

const codex = (name, extra = {}) => ({
  name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name,
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra,
});

const spark = (familyPercent, weeklyPercent = 10) => ({
  'x-codex-plan-type': 'pro',
  'x-codex-primary-used-percent': String(weeklyPercent),
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 3600),
  'x-codex-bengalfox-secondary-used-percent': String(familyPercent),
  'x-codex-bengalfox-secondary-window-minutes': '10080',
  'x-codex-bengalfox-secondary-reset-at': String(Math.floor(Date.now() / 1000) + 7200),
  'x-codex-bengalfox-limit-name': 'GPT-5.3-Codex-Spark',
});

function makeTUI(am) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  tui.render = () => {};
  return tui;
}

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── TUI ──────────────────────────────────────────────────────

test('a Codex family bucket draws its own bar, labelled like the Anthropic family bars', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, spark(40));
  const row = strip(makeTUI(am)._renderAcct(0, 10, true, [], [], {}, true, 12, ['bengalfox']));
  assert.match(row, /Ses /);
  assert.match(row, /Wk /);
  assert.match(row, /Sp7 /);
});

test('an account without the fleet-wide family leaves its column blank rather than shifting', () => {
  const am = new AccountManager([codex('a'), codex('b')], 0.98);
  am.updateQuota(0, spark(40));
  am.updateQuota(1, { 'x-codex-primary-used-percent': '5', 'x-codex-primary-window-minutes': '10080' });
  const tui = makeTUI(am);
  const a = strip(tui._renderAcct(0, 10, true, [], [], {}, true, 12, ['bengalfox']));
  const b = strip(tui._renderAcct(1, 10, true, [], [], {}, true, 12, ['bengalfox']));
  assert.doesNotMatch(b, /Sp7/);
  assert.equal(a.length, b.length, 'the rows stay the same width');
});

test('a monthly-only plan draws the month in the weekly slot', () => {
  const am = new AccountManager([codex('go')], 0.98);
  am.updateQuota(0, {
    'x-codex-primary-used-percent': '60',
    'x-codex-primary-window-minutes': String(30 * 24 * 60),
    'x-codex-primary-reset-at': String(Math.floor(Date.now() / 1000) + 86400),
  });
  const row = strip(makeTUI(am)._renderAcct(0, 10, true, [], [], {}, true, 12, []));
  assert.match(row, /Mo /);
  assert.doesNotMatch(row, /Wk /);
});

test('a spent Codex family is named in the blocked tag', () => {
  const q = { unified7d: 0.1, codexModelBuckets: { bengalfox: { name: 'GPT-5.3-Codex-Spark', utilization: 0.99 } } };
  assert.deepEqual(blockedFamilies(q, 0.98), ['GPT-5.3-Codex-Spark']);
  assert.deepEqual(blockedFamilies({ unified7d: 0.1, codexModelBuckets: { bengalfox: { utilization: 0.5 } } }, 0.98), []);
  // The shared weekly bars the family too.
  assert.deepEqual(blockedFamilies({ unified7d: 0.99, codexModelBuckets: { bengalfox: { name: 'Spark', utilization: 0.1 } } }, 0.98), ['Spark']);
});

// ── status text ──────────────────────────────────────────────

test('teamclaude status lists the monthly window and each Codex family', () => {
  const now = Date.now();
  const output = renderStatus({
    currentAccount: 'a', switchThreshold: 0.98,
    accounts: [{
      name: 'a', type: 'oauth', provider: 'codex', priority: 0, status: 'active',
      quota: {
        unified7d: 0.5, unified7dReset: now + 3600_000,
        unified30d: 0.2, unified30dReset: now + 86400_000,
        codexModelBuckets: { bengalfox: { name: 'GPT-5.3-Codex-Spark', utilization: 0.99, resetAt: now + 7200_000 } },
      },
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0 },
    }],
  }, { color: false, now });
  assert.match(output, /Weekly\s+\[.*\] 50%/);
  assert.match(output, /Monthly\s+\[.*\] 20%/);
  assert.match(output, /GPT-5\.3-Codex-Spark\s+\[.*\] 99%/);
  assert.match(output, /Models\s+GPT-5\.3-Codex-Spark ✗/);
  assert.doesNotMatch(output, /Opus/, 'no Anthropic family cell on a Codex account');
});

test('a monthly-only Codex account shows the month instead of an empty weekly', () => {
  const now = Date.now();
  const output = renderStatus({
    currentAccount: 'go', switchThreshold: 0.98,
    accounts: [{
      name: 'go', type: 'oauth', provider: 'codex', priority: 0, status: 'active',
      quota: { unified30d: 0.7, unified30dReset: now + 86400_000 },
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0 },
    }],
  }, { color: false, now });
  assert.match(output, /Monthly\s+\[.*\] 70%/);
  assert.doesNotMatch(output, /Weekly/);
});

// ── dashboard + quota endpoint ───────────────────────────────

test('the dashboard lists Codex family buckets beside the learned Anthropic ones', () => {
  const rows = scopedWeeklyRows({
    unified7dFable: 0.3,
    codexModelBuckets: { bengalfox: { name: 'GPT-5.3-Codex-Spark', utilization: 0.4, resetAt: 9 }, empty: { name: 'x' } },
  });
  assert.deepEqual(rows.map(r => [r.family, r.label, r.utilization]), [
    ['codex:bengalfox', 'GPT-5.3-Codex-Spark', 0.4],
    ['fable', 'Fable', 0.3],
  ]);
});

test('the quota summary carries the monthly window and the family buckets', () => {
  const am = new AccountManager([codex('a')], 0.98);
  am.updateQuota(0, spark(40));
  am.updateQuota(0, { 'x-codex-primary-used-percent': '15', 'x-codex-primary-window-minutes': String(30 * 24 * 60) });
  const summary = am.getQuotaSummary();
  const buckets = summary.accounts[0].buckets;
  assert.equal(buckets.monthly.utilization, 0.15);
  assert.equal(buckets['codex:bengalfox'].utilization, 0.4);
  assert.equal(buckets['codex:bengalfox'].name, 'GPT-5.3-Codex-Spark');
  assert.ok('monthly' in summary.aggregate);
});
