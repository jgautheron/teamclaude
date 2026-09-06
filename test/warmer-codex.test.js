import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Warmer } from '../src/warmer.js';

const codex = (name) => ({
  name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name,
  accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000,
});
const claude = (name) => ({ name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'uuid-' + name });

function fakeSpawner() {
  const calls = [];
  const fn = async (spec) => { calls.push(spec); return 0; };
  fn.calls = calls;
  return fn;
}

test('a Codex account is warmed by `codex exec` pinned through the provider override, not by claude', async () => {
  const am = new AccountManager([codex('me@example.com'), claude('c')], 0.98);
  const spawn = fakeSpawner();
  await new Warmer(am, { intervalMs: 0, port: 3456, apiKey: 'tc-key', spawnFn: spawn, log: () => {} }).warmAll();

  assert.equal(spawn.calls.length, 2);
  const [cx, cl] = spawn.calls;
  assert.equal(cx.command, 'codex');
  assert.deepEqual(cx.args.slice(0, 2), ['exec', '--skip-git-repo-check']);
  assert.equal(cx.args.at(-1), 'hi');
  assert.ok(!cx.args.includes('-m'), 'no model flag unless configured');
  assert.ok(cx.args.includes('model_providers.teamclaude.base_url="http://127.0.0.1:3456/tc-acct/me%40example.com/backend-api/codex"'), cx.args.join(' '));
  assert.ok(cx.args.includes('model_providers.teamclaude.supports_websockets=false'), 'warm-ups take the SSE path');
  assert.ok(cx.args.includes('model_providers.teamclaude.experimental_bearer_token="tc-bootstrap"'));
  assert.equal(cx.env.ANTHROPIC_BASE_URL, undefined, 'no Anthropic environment for a Codex warm-up');

  assert.equal(cl.command, 'claude');
  assert.ok(cl.env.ANTHROPIC_BASE_URL.endsWith('/tc-acct/uuid-c'));
});

test('codexModel selects the warm-up model', async () => {
  const am = new AccountManager([codex('a')], 0.98);
  const spawn = fakeSpawner();
  await new Warmer(am, { intervalMs: 0, port: 1, spawnFn: spawn, log: () => {}, codexModel: 'gpt-5.4-mini' }).warmAll();
  const i = spawn.calls[0].args.indexOf('-m');
  assert.ok(i > 0);
  assert.equal(spawn.calls[0].args[i + 1], 'gpt-5.4-mini');
});
