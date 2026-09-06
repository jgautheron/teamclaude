// Point the Codex CLI at the proxy.
//
// Codex has no `ANTHROPIC_BASE_URL` equivalent that a ChatGPT login honours
// (`OPENAI_BASE_URL` is ignored under ChatGPT auth), so it is redirected
// through a `model_providers` entry instead. Codex accepts the same settings
// as `-c key=value` overrides on the command line, values parsed as TOML, so
// `teamclaude run --codex` needs no config.toml editing and leaves the user's
// own provider untouched. `teamclaude env --codex` prints the TOML for those
// who would rather make it permanent.
//
// The provider always sends a fixed bootstrap bearer token. Verified on Codex
// 0.153.4 with an empty CODEX_HOME: `requires_openai_auth = true` alone sends
// no Authorization header at all, and with `experimental_bearer_token` it
// sends that token — with or without a local login, identically. The proxy
// replaces it with the selected account's credential, so a machine with no
// Codex login at all can run Codex through the pool.

import { encodePinComponent } from './claude-env.js';

export const CODEX_PROVIDER_ID = 'teamclaude';
export const CODEX_BOOTSTRAP_TOKEN = 'tc-bootstrap';

/** A TOML basic string. JSON's escapes are a subset of TOML's for every
 * character JSON.stringify emits, so the two agree on the wire. */
export function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlValue(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    // An inline table, e.g. http_headers. Keys are quoted so `x-api-key` is legal.
    return `{ ${Object.entries(value).map(([k, v]) => `${tomlString(k)} = ${tomlValue(v)}`).join(', ')} }`;
  }
  return tomlString(value);
}

/**
 * The proxy URL Codex appends `/responses` and `/models` to. A pinned session
 * carries its account in the path exactly as Claude's base-URL mode does.
 */
export function codexBaseUrl({ port, account = null, host = '127.0.0.1' }) {
  const pin = (account || '').trim();
  return `http://${host}:${port}${pin ? `/tc-acct/${encodePinComponent(pin)}` : ''}/backend-api/codex`;
}

/**
 * The provider entry, as plain data, shared by the `-c` and TOML renderings.
 *
 * - `supports_websockets` keeps Codex on the transport it uses against OpenAI
 *   directly; a custom provider defaults to `false`, which would silently
 *   downgrade every turn to SSE.
 * - `holdSeconds` raises Codex's stream idle timeout the way `run` raises
 *   `API_TIMEOUT_MS` for Claude: on exhaustion the proxy may hold a request
 *   silently, and the client must not give up first.
 * - `proxyApiKey` is emitted as an `http_headers` entry and is meant for a
 *   REMOTE client only: loopback callers are exempt from the proxy key, and a
 *   key in a command line is visible to every user on the machine.
 */
export function codexProviderSettings({ port, account = null, websockets = true, holdSeconds = 0, proxyApiKey = null } = {}) {
  const settings = {
    name: CODEX_PROVIDER_ID,
    base_url: codexBaseUrl({ port, account }),
    wire_api: 'responses',
    requires_openai_auth: true,
    experimental_bearer_token: CODEX_BOOTSTRAP_TOKEN,
    supports_websockets: !!websockets,
  };
  const holdMs = (holdSeconds || 0) * 1000;
  if (holdMs > 0) settings.stream_idle_timeout_ms = holdMs + 60_000;
  if (proxyApiKey) settings.http_headers = { 'x-api-key': proxyApiKey };
  return settings;
}

/** The `-c` overrides for one `codex` invocation; safe to spawn without a shell. */
export function buildCodexOverrides(settings) {
  const args = ['-c', `model_provider=${tomlString(CODEX_PROVIDER_ID)}`];
  for (const [key, value] of Object.entries(settings)) {
    args.push('-c', `model_providers.${CODEX_PROVIDER_ID}.${key}=${tomlValue(value)}`);
  }
  return args;
}

/** The same provider as a `config.toml` fragment. */
export function buildCodexConfigToml(settings) {
  const lines = [`model_provider = ${tomlString(CODEX_PROVIDER_ID)}`, '', `[model_providers.${CODEX_PROVIDER_ID}]`];
  for (const [key, value] of Object.entries(settings)) lines.push(`${key} = ${tomlValue(value)}`);
  return lines;
}
