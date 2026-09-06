// A Codex `importFrom` account delegates to the Codex CLI's auth.json. OpenAI
// refresh tokens are single-use, so a refresh the proxy performs must land in
// that file, or both the CLI and the next start hold a dead token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
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

test('the write-back refuses a file that no longer holds what was refreshed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  try {
    const path = await authFile(dir);
    // The CLI logged into another account meanwhile.
    const other = await writeCodexCredentials(path, { accessToken: 'x', refreshToken: 'y' }, { expectAccountId: 'acct-9' });
    assert.deepEqual(other.written, false);
    assert.match(other.reason, /acct-1/);
    // Another process already rotated the pair.
    const rotated = await writeCodexCredentials(path, { accessToken: 'x', refreshToken: 'y' }, { expectRefreshToken: 'rt-someone-else' });
    assert.equal(rotated.written, false);
    assert.match(rotated.reason, /rotated/);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.tokens.refresh_token, 'rt-old', 'the file is untouched');
    // Expectations that hold: written.
    const ok = await writeCodexCredentials(path, { accessToken: 'x', refreshToken: 'y' }, { expectAccountId: 'acct-1', expectRefreshToken: 'rt-old' });
    assert.equal(ok.written, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the manager passes the account id and the refresh token it spent as the write-back expectations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const path = await authFile(dir);
    // Simulate the CLI switching accounts under us before our refresh lands.
    await writeFile(path, JSON.stringify({ tokens: { access_token: 'b', refresh_token: 'rt-b', account_id: 'acct-B' } }));
    const am = new AccountManager([
      { name: 'cli', type: 'oauth', provider: 'codex', accountId: 'acct-1', importFrom: path, accessToken: 'at', refreshToken: 'rt-old', expiresAt: Date.now() - 1 },
    ], 0.98, { codexRefreshFn: async () => ({ accessToken: 'at-new', refreshToken: 'rt-new', expiresAt: Date.now() + 3600_000 }) });
    await am.ensureTokenFresh(0);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(raw.tokens.account_id, 'acct-B');
    assert.equal(raw.tokens.refresh_token, 'rt-b', 'account B\'s login is left alone');
    assert.equal(am.accounts[0].credential, 'at-new', 'the in-memory refresh still stands');
    assert.ok(errors.some(e => /Not writing the refreshed Codex token/.test(e) && /acct-B/.test(e)), errors.join('\n'));
  } finally {
    console.error = orig;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the write-back refuses a file that lost its token pair, but not one that merely lacks account_id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  try {
    const path = join(dir, 'auth.json');
    // `codex login --with-api-key` leaves no tokens at all.
    await writeFile(path, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x', tokens: null }), { mode: 0o600 });
    const refused = await writeCodexCredentials(path, { accessToken: 'at', refreshToken: 'rt' }, { expectAccountId: 'acct-1', expectRefreshToken: 'rt-old' });
    assert.equal(refused.written, false);
    assert.match(refused.reason, /no longer holds a token pair/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).tokens, null, 'the API-key login is untouched');
    // The CLI's account_id is optional; its absence is not evidence of another login.
    await writeFile(path, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a', refresh_token: 'rt-old' } }), { mode: 0o600 });
    const ok = await writeCodexCredentials(path, { accessToken: 'at', refreshToken: 'rt' }, { expectAccountId: 'acct-1', expectRefreshToken: 'rt-old' });
    assert.equal(ok.written, true);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).tokens.refresh_token, 'rt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the swap is abandoned when the file changes between the check and the rename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  try {
    const path = await authFile(dir);
    const newLogin = JSON.stringify({ tokens: { access_token: 'b', refresh_token: 'rt-b', account_id: 'acct-B' } });
    const result = await writeCodexCredentials(path, { accessToken: 'at-new', refreshToken: 'rt-new' }, {
      expectAccountId: 'acct-1', expectRefreshToken: 'rt-old',
      // The CLI saves a new login after the guards passed and the temp file is
      // written — the interleaving a snapshot check alone cannot see.
      beforeReplace: () => writeFile(path, newLogin),
    });
    assert.equal(result.written, false);
    assert.match(result.reason, /changed while/);
    assert.equal(await readFile(path, 'utf8'), newLogin, 'the concurrent login survives');
    assert.deepEqual((await readdir(dir)).filter(f => f.includes('.tmp')), [], 'no temp file left behind');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('before spending its refresh token, the manager adopts a newer pair the CLI put in the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  try {
    const path = join(dir, 'auth.json');
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    // The CLI refreshed on its own: the file holds a live pair we have never seen.
    await writeFile(path, JSON.stringify({ tokens: { access_token: fresh, refresh_token: 'rt-cli', account_id: 'acct-1' } }), { mode: 0o600 });
    const refreshed = [];
    const am = new AccountManager([
      { name: 'cli', type: 'oauth', provider: 'codex', accountId: 'acct-1', importFrom: path, accessToken: 'at', refreshToken: 'rt-old', expiresAt: Date.now() - 1 },
    ], 0.98, { codexRefreshFn: async (rt) => { refreshed.push(rt); return { accessToken: `at-from-${rt}`, refreshToken: `rt-from-${rt}`, expiresAt: Date.now() + 3600_000 }; } });
    await am.ensureTokenFresh(0);
    assert.deepEqual(refreshed, [], 'the spent-elsewhere token is never sent');
    assert.equal(am.accounts[0].credential, fresh);
    assert.equal(am.accounts[0].refreshToken, 'rt-cli');
    // The file's pair is itself expired: adopt it, then refresh THAT one and write back.
    const stale = jwt({ exp: 1 });
    await writeFile(path, JSON.stringify({ tokens: { access_token: stale, refresh_token: 'rt-cli2', account_id: 'acct-1' } }), { mode: 0o600 });
    am.accounts[0].expiresAt = Date.now() - 1;
    await am.ensureTokenFresh(0);
    assert.deepEqual(refreshed, ['rt-cli2']);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).tokens.refresh_token, 'rt-from-rt-cli2');
    // A file that now holds another account is left alone and ours is refreshed as usual.
    await writeFile(path, JSON.stringify({ tokens: { access_token: stale, refresh_token: 'rt-b', account_id: 'acct-B' } }), { mode: 0o600 });
    am.accounts[0].expiresAt = Date.now() - 1;
    await am.ensureTokenFresh(0);
    assert.deepEqual(refreshed, ['rt-cli2', 'rt-from-rt-cli2']);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).tokens.refresh_token, 'rt-b');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rejected refresh token is recovered from by a CLI re-login in the file, without a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-wb-'));
  const orig = console.error;
  console.error = () => {};
  try {
    const path = await authFile(dir);
    const refreshed = [];
    const am = new AccountManager([
      { name: 'cli', type: 'oauth', provider: 'codex', accountId: 'acct-1', importFrom: path, accessToken: 'at', refreshToken: 'rt-old', expiresAt: Date.now() - 1 },
    ], 0.98, { codexRefreshFn: async (rt) => { refreshed.push(rt); throw Object.assign(new Error('invalid_grant'), { status: 400 }); } });
    await am.ensureTokenFresh(0);
    assert.equal(am.accounts[0].status, 'error');
    await am.ensureTokenFresh(0);
    assert.deepEqual(refreshed, ['rt-old'], 'the dead token is not re-sent');
    // The user runs `codex login`: the file holds a live pair again.
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await writeFile(path, JSON.stringify({ tokens: { access_token: fresh, refresh_token: 'rt-cli', account_id: 'acct-1' } }), { mode: 0o600 });
    await am.ensureTokenFresh(0);
    assert.equal(am.accounts[0].status, 'active');
    assert.equal(am.accounts[0].credential, fresh);
    assert.equal(am.accounts[0].refreshToken, 'rt-cli');
    assert.deepEqual(refreshed, ['rt-old'], 'the adopted pair is fresh, so nothing is refreshed');
  } finally {
    console.error = orig;
    await rm(dir, { recursive: true, force: true });
  }
});
