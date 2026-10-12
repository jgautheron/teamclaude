// Backend providers.
//
// TeamClaude was built around one upstream (Anthropic), so the things that
// differ per backend — which host to reach, how to present the account's
// credential, which request paths belong to it — were inlined at the call
// sites. Adding a second subscription backend (OpenAI's Codex) makes those the
// axis of variation, so they live here instead.
//
// This is deliberately NOT a translation layer. Each provider is a passthrough:
// the client speaks that provider's own protocol and the body is forwarded
// untouched. All that changes is which account's credential is injected, and
// where the request is sent. Converting between provider protocols would mean
// re-serialising tool calls, streaming events and cache breakpoints, which is
// exactly the fidelity loss this proxy exists to avoid.

import { classificationPath } from './classification-path.js';

/**
 * @typedef {{ id: string, label: string, upstream: string, rewritesBody: boolean, headersTimeoutMs: number|null, exclusive?: boolean }} Provider
 */

/**
 * Providers keyed by the value used in an account's `provider` field.
 * @type {Record<string, Provider>}
 */
export const PROVIDERS = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    upstream: 'https://api.anthropic.com',
    // Anthropic pins the account inside the request body (metadata.user_id),
    // so the body rewrites apply here and only here.
    rewritesBody: true,
    // No provider opinion on the header wait: a streamed completion delivers
    // its first token in seconds, so the fleet default already fits.
    headersTimeoutMs: null,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    // A Codex subscription authenticates against the ChatGPT backend, not the
    // API platform: the OAuth token is a ChatGPT token and api.openai.com
    // rejects it with "Missing scopes: api.responses.write".
    upstream: 'https://chatgpt.com',
    // OpenAI carries the account in a request header, so no body rewrite is
    // needed — and the Anthropic-specific tool-pair repair would be wrong to
    // apply to a Responses API body.
    rewritesBody: false,
    // The ChatGPT backend holds the response head open while the model
    // reasons, so time-to-first-byte here measures the length of the reasoning
    // rather than the health of the socket: a large-context turn passes two
    // minutes before its first byte and is still perfectly alive. Cutting it
    // does not degrade gracefully either — the client re-sends, pays for a
    // fresh reasoning run, and hits the same wall, so one short deadline turns
    // into a loop of them. Five minutes is the wait that keeps the
    // dead-socket guard useful while leaving a long reasoning turn alone.
    headersTimeoutMs: 300_000,
  },
  'opencode-go': {
    id: 'opencode-go',
    label: 'OpenCode Go',
    // The Go plan's gateway serves three protocols under one prefix —
    // /zen/go/v1/messages, /chat/completions and /responses — so the client
    // keeps its own base URL path and only the origin changes.
    upstream: 'https://opencode.ai',
    rewritesBody: false,
    // Reasoning models answer a non-streamed request only once they finish
    // thinking, the same wait as Codex.
    headersTimeoutMs: 300_000,
    // A Go key is a seat on one gateway: its paths mean nothing to any other
    // backend, and no other account can answer them. Partitioned like a
    // subscription although it is an API key.
    exclusive: true,
  },
};

export const DEFAULT_PROVIDER = 'anthropic';

/**
 * The provider an account belongs to. Accounts written before providers
 * existed have no `provider` field and are Anthropic, so the default keeps
 * every existing config working untouched.
 *
 * @param {Record<string, any>|null|undefined} account
 * @returns {keyof typeof PROVIDERS}
 */
export function providerOf(account) {
  const id = account?.provider;
  return (id && PROVIDERS[id]) ? id : DEFAULT_PROVIDER;
}

/**
 * Whether an account is a SUBSCRIPTION, and therefore tied to the app whose plan
 * it belongs to.
 *
 * An OAuth login is one: a Claude Max token is issued to Claude and a ChatGPT
 * token to Codex, and neither plan can be spent by the other's client. Those
 * accounts are partitioned by provider, strictly.
 *
 * An API key is not. It is metered capacity rather than a seat — nothing about
 * it says which app may spend it — so it stays eligible for any caller. That is
 * what lets a third-party backend (a `upstream` + `modelMap` account) serve
 * whichever app is asking, instead of being fenced off by a provider field it
 * never set.
 */
export function isSubscriptionAccount(account) {
  return account?.type === 'oauth';
}

/**
 * Whether `account` is a candidate for a request arriving on `provider`'s path.
 *
 * The partition above, stated as the predicate rather than as its complement,
 * because two places need it and they must not drift: selection expresses it as
 * an exclusion (`_excludeOtherProviders`), while the exhaustion report needs the
 * set itself — how many accounts the request could ever have landed on, and
 * whose windows may speak for when it becomes servable again.
 *
 * An `exclusive` provider (a gateway such as OpenCode Go) is fenced both ways:
 * its accounts serve only its paths, and only its accounts serve them.
 *
 * @param {Record<string, any>|null|undefined} account
 * @param {string} provider
 * @returns {boolean}
 */
export function canServeProvider(account, provider) {
  const own = providerOf(account);
  if (own === provider) return true;
  if (PROVIDERS[own].exclusive || (isKnownProvider(provider) && PROVIDERS[provider].exclusive)) return false;
  return !isSubscriptionAccount(account);
}

// The hosts each provider is reached on, for MITM interception.
//
// MITM is the mode that works without the client cooperating: a CLI that only
// honours HTTPS_PROXY has no base-URL to redirect, so if the proxy will not
// intercept the provider's host, that provider is simply unreachable through
// it. Codex is exactly that case.
const PROVIDER_HOSTS = { 'api.anthropic.com': 'anthropic', 'chatgpt.com': 'codex' };

// Hosts adjacent to a provider that must NOT be intercepted.
//
// `ab.chatgpt.com` is OpenAI's own telemetry/experiment endpoint. It carries no
// inference, nothing here would rewrite, and terminating it would mean
// presenting our leaf for a host we have no reason to read — so it is
// blind-tunnelled like any unrelated host. Listed rather than left to fall
// through, because `chatgpt.com` matching by suffix would otherwise swallow it.
const NEVER_INTERCEPT = new Set(['ab.chatgpt.com']);

/**
 * The provider reached on `host`, or null when the host is not one we intercept.
 *
 * Exact match, never a suffix: a subdomain of a provider is a different service
 * (see NEVER_INTERCEPT), and matching loosely would have the proxy terminate TLS
 * for hosts nobody asked it to read.
 */
export function providerForHost(host) {
  if (!host || NEVER_INTERCEPT.has(host)) return null;
  return PROVIDER_HOSTS[host] || null;
}

/** Whether `host` is one we deliberately refuse to intercept. */
export function isNeverIntercepted(host) {
  return NEVER_INTERCEPT.has(host);
}

/** Hosts to intercept for the providers this config actually uses. */
export function interceptHostsFor(accounts = []) {
  const wanted = new Set();
  for (const [host, id] of Object.entries(PROVIDER_HOSTS)) {
    // Anthropic is always intercepted — it is the default provider and the
    // configured `upstream` may name a different host anyway. A non-default
    // provider is intercepted only when an account actually uses it, so an
    // Anthropic-only fleet never has its ChatGPT traffic terminated.
    if (id === DEFAULT_PROVIDER || accounts.some(a => providerOf(a) === id)) wanted.add(host);
  }
  return [...wanted];
}

/** Whether `id` names a provider we know how to talk to. */
export function isKnownProvider(id) {
  return Object.hasOwn(PROVIDERS, id);
}

// Request paths that belong to Codex rather than Anthropic.
//
// The Codex CLI appends `/responses` and `/models` to whatever `base_url` it is
// given, so pointing it at `<proxy>/backend-api/codex` makes it emit exactly
// the paths the ChatGPT backend already expects. That keeps this a pure
// passthrough — the proxy forwards the path verbatim and never rewrites it —
// and it keeps the Codex namespace clearly separated from Anthropic's `/v1/*`.
const CODEX_PATHS = ['/backend-api/codex'];

// OpenCode Go clients (pi, opencode, …) take `<proxy>/zen/go` (or `/zen/go/v1`)
// as their base URL, so the gateway's own paths arrive here unchanged.
const OPENCODE_GO_PREFIX = '/zen/go';
// A Zen pay-as-you-go key answers the same protocols one level up, billed
// from credits instead of the Go plan.
const OPENCODE_ZEN_PREFIX = '/zen';

const underPrefix = (/** @type {string} */ path, /** @type {string} */ p) => path === p || path.startsWith(`${p}/`);

/**
 * Which provider should serve a request path.
 *
 * This is what lets one port serve both CLIs: Claude Code posts to
 * `/v1/messages` and Codex to `/backend-api/codex/responses`, so the path alone
 * says which pool of accounts is eligible. No second listener, no
 * client-supplied hint that could disagree with the body.
 */
export function providerForPath(url) {
  // Read on the classification path, never rewritten: the request goes out with
  // the path exactly as it arrived, so this test has to read it the way the
  // parser and the receiving server will. Otherwise
  // `/backend-api/codex/..%2fconversations` classifies as Codex and lands
  // somewhere else entirely, and `/backend-api\codex/responses` — which
  // `new URL()` folds to a Codex path before sending it — does not classify as
  // Codex at all, so it draws the wrong pool's credential.
  const path = classificationPath(url);
  if (CODEX_PATHS.some(p => underPrefix(path, p))) return 'codex';
  if (underPrefix(path, OPENCODE_GO_PREFIX)) return 'opencode-go';
  return DEFAULT_PROVIDER;
}

/**
 * Whether an OpenCode account is a Zen pay-as-you-go key rather than a Go
 * subscription key. Both are console API keys; only the account says which.
 * @param {Record<string, any>|null|undefined} account
 */
export function isOpencodeZenAccount(account) {
  return providerOf(account) === 'opencode-go' && account?.plan === 'zen';
}

/**
 * The path a request is sent upstream with for this account. Verbatim, except
 * on an OpenCode account:
 * - A missing `/v1` is restored. Go's Anthropic-shaped models use `/zen/go` as
 *   their base and the OpenAI-shaped ones `/zen/go/v1`, so a client given one
 *   base for all of them (pi's provider `baseUrl`) sends `/zen/go/chat/completions`.
 * - A Zen pay-as-you-go key serves the request from Zen's own endpoints:
 *   `/zen/go/v1/messages` becomes `/zen/v1/messages`.
 *
 * @param {Record<string, any>} account
 * @param {string} url  the request URL as it arrived
 */
export function upstreamPathFor(account, url) {
  if (providerOf(account) !== 'opencode-go' || !url.startsWith(`${OPENCODE_GO_PREFIX}/`)) return url;
  let rest = url.slice(OPENCODE_GO_PREFIX.length);
  if (!/^\/v1(?:[/?#]|$)/.test(rest)) rest = `/v1${rest}`;
  return (isOpencodeZenAccount(account) ? OPENCODE_ZEN_PREFIX : OPENCODE_GO_PREFIX) + rest;
}

/**
 * Put the account's credential on an outgoing request.
 *
 * Mutates `headers` in place, mirroring how the forward path already builds
 * them. Returns nothing: the caller owns the object.
 *
 * - Anthropic OAuth and Codex both use `Authorization: Bearer`.
 * - Anthropic API keys use `x-api-key`.
 * - Codex additionally needs `ChatGPT-Account-Id`, which is how OpenAI scopes
 *   a token to one ChatGPT account. It is the direct counterpart of the
 *   `account_uuid` that the Anthropic path patches into the request body —
 *   a header here, so no body rewrite is involved.
 * - OpenCode reads `x-api-key` on its Anthropic-shaped `/messages` endpoint and
 *   `Authorization: Bearer` everywhere else, so both carry the key.
 */
export function applyAuthHeaders(headers, account) {
  const provider = providerOf(account);
  if (provider === 'opencode-go') {
    headers['authorization'] = `Bearer ${account.credential}`;
    headers['x-api-key'] = account.credential;
    return;
  }
  if (provider === 'codex') {
    headers['authorization'] = `Bearer ${account.credential}`;
    if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
    return;
  }
  if (account.type === 'oauth') {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }
}

/**
 * Upstream base URL for an account: its own override first, then the
 * provider's default, then the configured Anthropic upstream.
 *
 * The configured `upstream` stays the Anthropic default rather than a global
 * one, because it predates providers and existing configs set it meaning
 * "where Anthropic lives". Applying it to Codex would silently send OpenAI
 * traffic to an Anthropic host.
 */
export function upstreamFor(account, configuredUpstream) {
  if (account?.upstream) return account.upstream;
  const provider = providerOf(account);
  if (provider !== DEFAULT_PROVIDER) return PROVIDERS[provider].upstream;
  return configuredUpstream || PROVIDERS.anthropic.upstream;
}

/** Whether the Anthropic-only body rewrites apply to this account. */
export function rewritesBody(account) {
  return PROVIDERS[providerOf(account)].rewritesBody;
}

/**
 * How long to wait for this account's upstream to send response HEADERS, when
 * nothing more specific has been asked for.
 *
 * `null` means the provider has no opinion and the fleet default applies. The
 * number is a default, not a setting: `TEAMCLAUDE_UPSTREAM_HEADERS_TIMEOUT_MS`
 * and a per-call `headersTimeoutMs` both still win over it (see
 * resolveHeadersTimeout in upstream-fetch.js).
 *
 * @param {Record<string, any>|null|undefined} account
 * @returns {number|null}
 */
export function defaultHeadersTimeoutFor(account) {
  return PROVIDERS[providerOf(account)].headersTimeoutMs;
}

/** Whether `account` is served by a process on this machine rather than by a
 *  vendor endpoint — typically a local translating proxy in front of another
 *  backend.
 *
 *  Keyed on the upstream resolving to loopback. Pairing the account against a
 *  declared local process does not generalise: such a declaration carries a
 *  COMMAND rather than a port, and the port sits inside its argv, where every
 *  program spells it differently. A loopback upstream says the same thing
 *  directly, and says it for a hand-started process too. A remote third-party
 *  backend (DeepSeek, GLM) keeps a public host and is not caught.
 *
 * @param {any} account
 */
export function isLocalUpstream(account) {
  if (!account?.upstream) return false;
  let hostname;
  try { hostname = new URL(account.upstream).hostname; }
  catch { return false; } // not a URL we can judge — treat it as a normal account
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase(); // URL brackets IPv6
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}
