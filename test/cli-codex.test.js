// `teamclaude run --codex`, `env --codex`, `import --codex` and `accounts`
// for a Codex entry, driven through the CLI with a fake `codex` on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

// Stands in for a running proxy: `run` only probes the port, and a config
// change posts a reload that any HTTP answer satisfies.
function listen() {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function withSandbox(fn, { proxyUp = true, accounts = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-codex-cli-'));
  const { server, port } = await listen();
  if (!proxyUp) await new Promise(r => server.close(r));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { port, apiKey: 'tc-test' }, holdSeconds: 300, accounts }));
  // A fake `codex` that records its argv and environment.
  const argvPath = join(dir, 'argv.json');
  const bin = join(dir, 'bin');
  await writeFile(join(dir, 'codex.js'), `require('fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify({ argv: process.argv.slice(2), tcAcct: process.env.TC_ACCT ?? null }));`);
  await import('node:fs/promises').then(fs => fs.mkdir(bin));
  await writeFile(join(bin, 'codex'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'codex.js'))} "$@"\n`);
  await chmod(join(bin, 'codex'), 0o755);
  const run = (args, env = {}) => spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath, PATH: `${bin}:${process.env.PATH}`, ...env },
    encoding: 'utf8', timeout: 15_000,
  });
  const recorded = async () => JSON.parse(await readFile(argvPath, 'utf8'));
  try {
    await fn({ run, recorded, port, configPath });
  } finally {
    if (proxyUp) await new Promise(r => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
}

test('run --codex launches codex with the provider overrides ahead of the user args', async () => {
  await withSandbox(async ({ run, recorded, port }) => {
    const res = run(['run', '--codex', '--', 'exec', 'hello there']);
    assert.equal(res.status, 0, res.stderr);
    const { argv, tcAcct } = await recorded();
    assert.deepEqual(argv.slice(-2), ['exec', 'hello there']);
    assert.equal(argv[0], '-c');
    assert.equal(argv[1], 'model_provider="teamclaude"');
    assert.ok(argv.includes(`model_providers.teamclaude.base_url="http://127.0.0.1:${port}/backend-api/codex"`), argv.join(' '));
    assert.ok(argv.includes('model_providers.teamclaude.supports_websockets=true'));
    assert.ok(argv.includes('model_providers.teamclaude.stream_idle_timeout_ms=360000'), 'holdSeconds 300 + 60s');
    assert.ok(!argv.some(a => a.includes('x-api-key')), 'no proxy key on a local command line');
    assert.equal(tcAcct, null);
  });
});

test('TC_ACCT pins through the base_url and never reaches codex', async () => {
  await withSandbox(async ({ run, recorded, port }) => {
    const res = run(['run', '--codex'], { TC_ACCT: 'me@example.com' });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /Pinned to account "me@example.com"/);
    const { argv, tcAcct } = await recorded();
    assert.ok(argv.includes(`model_providers.teamclaude.base_url="http://127.0.0.1:${port}/tc-acct/me%40example.com/backend-api/codex"`), argv.join(' '));
    assert.equal(tcAcct, null);
  });
});

test('run --codex refuses when the proxy is down, unless --auto-fallback launches codex bare', async () => {
  await withSandbox(async ({ run, recorded }) => {
    const refused = run(['run', '--codex', '--', 'exec', 'x']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Proxy not running/);
    assert.match(refused.stderr, /--auto-fallback/);

    const direct = run(['run', '--codex', '--auto-fallback', '--', 'exec', 'x']);
    assert.equal(direct.status, 0, direct.stderr);
    assert.match(direct.stderr, /launching codex directly/);
    assert.deepEqual((await recorded()).argv, ['exec', 'x'], 'no overrides when bypassing the proxy');
  }, { proxyUp: false });
});

test('run --codex reports a missing codex binary', async () => {
  await withSandbox(async ({ run }) => {
    const res = spawnSync(process.execPath, [cliPath, 'run', '--codex'], {
      env: { ...process.env, TEAMCLAUDE_CONFIG: run.configPath, PATH: '/nonexistent' }, encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Codex CLI not found in PATH/);
  });
});

test('env --codex prints the TOML provider on stdout and the hints on stderr', async () => {
  await withSandbox(async ({ run, port }) => {
    const res = run(['env', '--codex'], { TC_ACCT: 'nobody' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, [
      'model_provider = "teamclaude"',
      '',
      '[model_providers.teamclaude]',
      'name = "teamclaude"',
      `base_url = "http://127.0.0.1:${port}/tc-acct/nobody/backend-api/codex"`,
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'experimental_bearer_token = "tc-bootstrap"',
      'supports_websockets = true',
      'stream_idle_timeout_ms = 360000',
      '',
    ].join('\n'));
    assert.match(res.stderr, /pinned to account "nobody"/);
    assert.match(res.stderr, /warning: no account named "nobody"/);
    assert.match(res.stderr, /codex -c 'model_provider="teamclaude"'/);
    assert.match(res.stderr, /http_headers = \{ "x-api-key" = "<proxy.apiKey>" \}/);
  });
});

// A JWT with the given payload; the signature is never verified.
const jwt = (payload) => ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

test('import --codex reads the Codex CLI login, keys it by account id, and warns about the single-use refresh token', async () => {
  await withSandbox(async ({ run, configPath }) => {
    const dir = join(configPath, '..');
    const authPath = join(dir, 'auth.json');
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await writeFile(authPath, JSON.stringify({ tokens: {
      access_token: jwt({ exp }), refresh_token: 'rt-1', account_id: 'acct-1',
      id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'pro' } }),
    } }));

    const first = run(['import', '--codex', '--from', authPath]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Added account "me@example.com" \(pro\)/);
    assert.match(first.stdout, /refresh token can be used once/);
    let cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(cfg.accounts.length, 1);
    const a = cfg.accounts[0];
    assert.equal(a.provider, 'codex');
    assert.equal(a.accountId, 'acct-1');
    assert.equal(a.email, 'me@example.com');
    assert.equal(a.planType, 'pro');
    assert.equal(a.refreshToken, 'rt-1');
    assert.equal(a.expiresAt, exp * 1000, 'expiry taken from the access token claim');
    assert.equal(a.source, 'import');

    // The same account again, renamed: updated in place, name kept.
    const second = run(['import', '--codex', '--from', authPath, '--name', 'other']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Updated account "me@example.com"/);
    cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(cfg.accounts.length, 1);

    const missing = run(['import', '--codex', '--from', join(dir, 'nope.json')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Failed to import from/);
    // Port closed: the reload notification a config change posts has nothing
    // to reach, and could not be answered anyway while spawnSync blocks us.
  }, { proxyUp: false });
});

test('accounts lists a Codex entry from its stored identity, without an Anthropic profile lookup', async () => {
  await withSandbox(async ({ run }) => {
    const res = run(['accounts', '-v']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[1\] work \(Codex pro, login\)/);
    assert.match(res.stdout, /Email: me@example.com/);
    assert.match(res.stdout, /ID:    acct-9/);
    assert.match(res.stdout, /Token: expires in/);
  }, { accounts: [{ name: 'work', type: 'oauth', provider: 'codex', source: 'login', accountId: 'acct-9', email: 'me@example.com', planType: 'pro', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 7200_000 }] });
});
