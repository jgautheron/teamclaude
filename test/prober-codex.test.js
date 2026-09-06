import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

const codex = (name) => ({
  name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name,
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000,
});
const claude = (name) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000 });

const reading = (weekly) => ({
  unified7d: weekly, unified7dReset: Date.now() + 3600_000, planType: 'pro',
  modelBuckets: [{ slug: 'bengalfox', name: 'GPT-5.3-Codex-Spark', utilization: 0.05, resetAt: Date.now() + 7200_000 }],
});

// A Codex account is probed through its own endpoint, which needs the account
// id as well as the token, and never through Anthropic's profile endpoint.
test('a Codex account is probed with its token and account id, and skips the Anthropic profile', async () => {
  const am = new AccountManager([codex('c'), claude('a')], 0.98);
  const codexCalls = [];
  const anthropicCalls = [];
  let profileCalls = 0;
  const prober = new Prober(am, {
    codexProbeFn: async (token, accountId) => { codexCalls.push([token, accountId]); return reading(0.3); },
    probeFn: async (token) => { anthropicCalls.push(token); return { fiveHour: { utilization: 0.1 } }; },
    profileFn: async () => { profileCalls++; return {}; },
    log: () => {},
  });
  await prober.probeAll();

  assert.deepEqual(codexCalls, [['t-c', 'acct-c']]);
  assert.deepEqual(anthropicCalls, ['t-a']);
  assert.equal(profileCalls, 1, 'only the Anthropic account has a profile to fetch');
  const q = am.accounts[0].quota;
  assert.equal(q.unified7d, 0.3);
  assert.equal(q.planType, 'pro');
  assert.equal(q.codexModelBuckets.bengalfox.utilization, 0.05);
  assert.equal(am.accounts[0].probing, false);
  assert.equal(prober.getStatus().accounts.find(a => a.name === 'c').status, 'ok');
});

test('a 401 from the usage endpoint forces one refresh and retries', async () => {
  const am = new AccountManager([codex('c')], 0.98, {
    codexRefreshFn: async () => ({ accessToken: 't-fresh', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }),
  });
  const tokens = [];
  const prober = new Prober(am, {
    codexProbeFn: async (token) => { tokens.push(token); return tokens.length === 1 ? { error: 'HTTP 401', status: 401 } : reading(0.5); },
    log: () => {},
  });
  await prober.probeAll();
  assert.deepEqual(tokens, ['t-c', 't-fresh']);
  assert.equal(am.accounts[0].quota.unified7d, 0.5);
});

test('a failed Codex probe is recorded and leaves the quota alone', async () => {
  const am = new AccountManager([codex('c')], 0.98);
  am.updateQuota(0, { 'x-codex-primary-used-percent': '42', 'x-codex-primary-window-minutes': '10080' });
  const prober = new Prober(am, { codexProbeFn: async () => ({ error: 'HTTP 503', status: 503 }), log: () => {} });
  await prober.probeAll();
  assert.equal(am.accounts[0].quota.unified7d, 0.42);
  assert.equal(prober.getStatus().accounts[0].status, 'error');
});
