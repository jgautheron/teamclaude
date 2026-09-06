import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { codexBaseUrl, codexProviderSettings, buildCodexOverrides, buildCodexConfigToml, tomlString } from '../src/codex-env.js';

test('the base URL carries the Codex suffix, with the pin ahead of it when set', () => {
  assert.equal(codexBaseUrl({ port: 3456 }), 'http://127.0.0.1:3456/backend-api/codex');
  assert.equal(codexBaseUrl({ port: 3456, account: 'me@example.com' }), 'http://127.0.0.1:3456/tc-acct/me%40example.com/backend-api/codex');
  assert.equal(codexBaseUrl({ port: 3456, account: "work (Acme)'s" }), 'http://127.0.0.1:3456/tc-acct/work%20%28Acme%29%27s/backend-api/codex');
  assert.equal(codexBaseUrl({ port: 3456, account: '  ' }), 'http://127.0.0.1:3456/backend-api/codex', 'a blank pin is no pin');
});

test('provider settings: bootstrap auth, websockets on, no timeout or key unless asked', () => {
  assert.deepEqual(codexProviderSettings({ port: 3456 }), {
    name: 'teamclaude',
    base_url: 'http://127.0.0.1:3456/backend-api/codex',
    wire_api: 'responses',
    requires_openai_auth: true,
    experimental_bearer_token: 'tc-bootstrap',
    supports_websockets: true,
  });
});

test('holdSeconds raises the stream idle timeout past the hold, as run does for API_TIMEOUT_MS', () => {
  const s = codexProviderSettings({ port: 1, holdSeconds: 600 });
  assert.equal(s.stream_idle_timeout_ms, 660_000);
  assert.equal('stream_idle_timeout_ms' in codexProviderSettings({ port: 1, holdSeconds: 0 }), false);
});

test('a proxy key becomes an http_headers entry, and websockets can be turned off', () => {
  const s = codexProviderSettings({ port: 1, proxyApiKey: 'k1', websockets: false });
  assert.deepEqual(s.http_headers, { 'x-api-key': 'k1' });
  assert.equal(s.supports_websockets, false);
});

test('the -c overrides are one flag per setting, strings TOML-quoted', () => {
  const args = buildCodexOverrides(codexProviderSettings({ port: 3456, account: 'a', holdSeconds: 60, proxyApiKey: 'k"1' }));
  assert.deepEqual(args, [
    '-c', 'model_provider="teamclaude"',
    '-c', 'model_providers.teamclaude.name="teamclaude"',
    '-c', 'model_providers.teamclaude.base_url="http://127.0.0.1:3456/tc-acct/a/backend-api/codex"',
    '-c', 'model_providers.teamclaude.wire_api="responses"',
    '-c', 'model_providers.teamclaude.requires_openai_auth=true',
    '-c', 'model_providers.teamclaude.experimental_bearer_token="tc-bootstrap"',
    '-c', 'model_providers.teamclaude.supports_websockets=true',
    '-c', 'model_providers.teamclaude.stream_idle_timeout_ms=120000',
    '-c', 'model_providers.teamclaude.http_headers={ "x-api-key" = "k\\"1" }',
  ]);
});

test('the TOML fragment is what goes into config.toml', () => {
  const lines = buildCodexConfigToml(codexProviderSettings({ port: 3456 }));
  assert.deepEqual(lines, [
    'model_provider = "teamclaude"',
    '',
    '[model_providers.teamclaude]',
    'name = "teamclaude"',
    'base_url = "http://127.0.0.1:3456/backend-api/codex"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'experimental_bearer_token = "tc-bootstrap"',
    'supports_websockets = true',
  ]);
});

test('tomlString escapes what TOML basic strings need escaped', () => {
  assert.equal(tomlString('plain'), '"plain"');
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(tomlString('tab\there'), '"tab\\there"');
});

test('the -c values survive a shell-less spawn byte for byte', () => {
  const args = buildCodexOverrides(codexProviderSettings({ port: 1, account: "it's (odd)" }));
  const out = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '--', ...args], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.stdout), args);
});
