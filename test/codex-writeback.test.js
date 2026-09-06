// A Codex `importFrom` account delegates to the Codex CLI's auth.json. OpenAI
// refresh tokens are single-use, so a refresh the proxy performs must land in
// that file, or both the CLI and the next start hold a dead token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { writeCodexCredentials, importCodexCredentials } from '../src/codex-auth.js';

const jwt = (o) => ['e30', Buffer.from(JSON.stringify(o)).toString('base64url'), 'sig'].join('.');

async function authFile(dir) {
  const path = join(dir, 'auth.json');
  await writeFile(path, JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: '2026-01-01T00:00:00.000Z',
    tokens: { id_token: jwt({ email: 'me@x.com' }), access_token: jwt({ exp: 1 }), refresh_token: 'rt-old', account_id: 'acct-1' },
  }), { mode: 0o600 });
  return path;
}

test('writeCodexCredentials replaces the token pair, stamps last_refresh, keeps the rest, and stays 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  try {
    const path = await authFile(dir);
    await writeCodexCredentials(path, { accessToken: 'at-new', refreshToken: 'rt-new' });
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.tokens.access_token, 'at-new');
    assert.equal(raw.tokens.refresh_token, 'rt-new');
    assert.equal(raw.tokens.account_id, 'acct-1');
    assert.ok(raw.tokens.id_token);
    assert.equal(raw.auth_mode, 'chatgpt');
    assert.notEqual(raw.last_refresh, '2026-01-01T00:00:00.000Z');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await importCodexCredentials(path)).refreshToken, 'rt-new', 'a re-import reads the new pair');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manager writes a Codex importFrom refresh back to the file; an inline account is left alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  try {
    const path = await authFile(dir);
    const written = [];
    const am = new AccountManager([
      { name: 'cli', type: 'oauth', provider: 'codex', accountId: 'acct-1', importFrom: path, accessToken: 'at', refreshToken: 'rt-old', expiresAt: Date.now() - 1 },
      { name: 'own', type: 'oauth', provider: 'codex', accountId: 'acct-2', accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() - 1 },
    ], 0.98, {
      codexRefreshFn: async (rt) => ({ accessToken: `at-from-${rt}`, refreshToken: `rt-from-${rt}`, expiresAt: Date.now() + 3600_000 }),
      codexWriteBackFn: async (p, tokens) => { written.push({ p, tokens }); return writeCodexCredentials(p, tokens); },
    });
    await am.ensureTokenFresh(0);
    await am.ensureTokenFresh(1);
    assert.equal(written.length, 1, 'only the delegating account writes back');
    assert.equal(written[0].p, path);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.tokens.refresh_token, 'rt-from-rt-old');
    assert.equal(am.accounts[0].credential, 'at-from-rt-old');
    assert.equal(am.accounts[1].credential, 'at-from-rt2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write-back failure is logged and does not undo the refresh', async () => {
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const am = new AccountManager([
      { name: 'cli', type: 'oauth', provider: 'codex', accountId: 'acct-1', importFrom: '/nonexistent/auth.json', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() - 1 },
    ], 0.98, { codexRefreshFn: async () => ({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 }) });
    await am.ensureTokenFresh(0);
    assert.equal(am.accounts[0].credential, 'at-new');
    assert.equal(am.accounts[0].status, 'active');
    assert.ok(errors.some(e => /Could not write the refreshed Codex token back/.test(e)), errors.join('\n'));
  } finally {
    console.error = orig;
  }
});
