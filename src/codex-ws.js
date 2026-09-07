// The Codex WebSocket relay.
//
// Codex CLI 0.133+ speaks the Responses API over a WebSocket to
// `chatgpt.com/backend-api/codex/responses` whenever its provider says
// `supports_websockets = true`, and only falls back to the HTTP/SSE path on a
// 426. One connection carries one turn: Codex opens it lazily, may send a
// prewarm `response.create` first, and reuses it for the turn's follow-up
// requests with `previous_response_id`. So the connection is bound to ONE
// account for its lifetime, and an account can only be changed between
// connections — which is fine, because closing the connection after a
// response makes Codex open a fresh one, with the full input, for the next
// (verified live: input length 3, 7, 11, 14, 18 across one closed-and-reopened
// turn, and the turn finished correctly).
//
// That shapes the design:
//
//   1. The relay TERMINATES the client's handshake itself and answers the 101
//      at once. Codex sends nothing until it has the 101, so the first frame
//      is never in the upgrade's `head`; it arrives a few hundred ms later.
//   2. The upstream is dialed on that first frame, which is the
//      `response.create` naming the model — so account selection is
//      model-aware, like the HTTP path. A client that connects and says
//      nothing is dialed after a timeout with no model.
//   3. Bytes are then spliced RAW in both directions: a client's masked frame
//      is valid for upstream as it is, and upstream's unmasked frames are
//      valid for the client. A passive decoder reads each direction alongside
//      the splice, never rewriting it: `codex.rate_limits` events feed the
//      quota, error events classify a refusal.
//   4. A handshake refusal (429, 402, 403, 401) is classified exactly as on
//      the HTTP path and redialed on another account; the client never sees
//      it. Once an account has become ineligible mid-connection, the relay
//      waits for the response in flight to end and then closes the client
//      with 1012, so the next connection is routed afresh.
//   5. When no account has headroom and `holdSeconds` is set, the relay holds
//      the (already open) client connection and re-selects on a bounded poll,
//      as forwardRequest holds a request. Codex is waiting for its first
//      response event, so this is invisible to it as long as its stream idle
//      timeout outlasts the hold — which is what `run --codex` arranges.
//
// The upstream 101 carried no quota headers in any live capture; the
// `codex.rate_limits` frame that opens every response does. Both are read.

import http from 'node:http';
import https from 'node:https';
import { parseRequestModel } from './model.js';
import { applyAuthHeaders, upstreamFor } from './provider.js';
import { proxyForHost, proxyAgent } from './upstream-proxy.js';
import { parseCodexRateLimitsEvent, classifyCodexRejection } from './codex-quota.js';
import { FrameDecoder, computeAccept, handshakeKey, closeFrame, encodeFrame, OPCODE } from './ws-frames.js';

export const WS_BETA = 'responses_websockets=2026-02-06';

// How long to wait for the client's first frame before dialing without a
// model. Codex's own connect timeout is 10s; a client idle that long is not
// Codex, and dialing anyway keeps a plain WebSocket client working.
const FIRST_FRAME_TIMEOUT_MS = 3_000;
// Time-to-101 on the upstream dial.
const DIAL_TIMEOUT_MS = 30_000;
// Hold after a refusal that states no retry-after (see server.js for the same
// interval on the HTTP path and why it is a revalidation interval).
const QUOTA_HOLD_SECONDS = 15 * 60;
// Bound the diagnostic read of a refusal body, as readErrorBody does.
const ERROR_BODY_LIMIT = 64 * 1024;
// Bytes a client may send before the upstream is open. Codex's first message
// is the whole transcript; anything past this is not a client worth dialing for.
const PENDING_LIMIT = 16 * 1024 * 1024;

// Client headers that must not reach upstream: the handshake fields the relay
// regenerates, hop-by-hop fields, and the proxy's own credentials.
const STRIP_UPSTREAM = new Set([
  'host', 'connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version',
  'sec-websocket-extensions', 'x-api-key', 'proxy-authorization', 'content-length',
  'transfer-encoding', 'keep-alive',
]);

// Body codes that mean a spent quota when they arrive as an EVENT rather than
// an HTTP status. Kept in step with classifyCodexRejection's quota codes.
const EVENT_QUOTA_CODES = new Set(['usage_limit_reached', 'usage_limit_exceeded', 'usage_not_included', 'rate_limit_reached']);
// Events that end a response, after which the connection may be rotated away.
const TERMINAL_EVENTS = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
// Events that open a response without committing any of its output — a
// `response.created` says the request was accepted, not that anything came
// of it. While only these have arrived the response can still be retried
// elsewhere; the first event outside this set commits it to this account.
const PREAMBLE_EVENTS = new Set(['codex.rate_limits', 'codex.response.metadata', 'response.created', 'response.in_progress']);
// How much of a response's preamble is held back before it is forwarded
// regardless — a bound on memory, far above what a preamble carries.
const HELD_LIMIT = 4 * 1024 * 1024;

let upgradeCounter = 0;

// Upstream hosts that answered a WebSocket handshake with 426, and until
// when to believe it. The relay answers the client's 101 before it dials, so
// a 426 met upstream can only reach THIS connection as a close — Codex then
// finishes the turn over SSE — but the next upgrade from any client can be
// refused with an honest HTTP 426 before anything is committed, which is the
// status Codex's transport fallback keys on.
const WS_REFUSED_TTL_MS = 10 * 60 * 1000;
const wsRefusedUntil = new Map();

export function noteWebSocketRefused(host, ttlMs = WS_REFUSED_TTL_MS, now = Date.now()) {
  wsRefusedUntil.set(host, now + ttlMs);
}

/** Whether `host` refused WebSockets recently; expired entries are dropped. */
export function webSocketRefused(host, now = Date.now()) {
  const until = wsRefusedUntil.get(host);
  if (until == null) return false;
  if (now >= until) { wsRefusedUntil.delete(host); return false; }
  return true;
}

/** Test seam. */
export function clearWebSocketRefusals() { wsRefusedUntil.clear(); }

/** A fresh activity-row id for a WebSocket session. Strings, so they can
 * never collide with the request listener's numeric ids in the TUI's map. */
export function nextUpgradeId() {
  return `ws-${++upgradeCounter}`;
}

/** Write an HTTP error on a socket that has not been upgraded, then close it. */
export function refuseUpgrade(socket, status, message) {
  const body = JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } });
  socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  socket.destroy();
}

/**
 * Relay one Codex WebSocket session.
 *
 * `req`, `socket`, `head` are Node's 'upgrade' arguments, with `req.url`
 * already stripped of any `/tc-acct/` pin prefix (the pin arrives as
 * `pinnedIndex`). `ctx` carries what the request path has: the account
 * manager, the configured upstream (Anthropic's; a Codex account resolves its
 * own), sx and its agent factory, the activity hooks, and the session and
 * client identity already derived from the headers.
 */
export function relayCodexUpgrade(req, socket, head, ctx) {
  const {
    accountManager: am, upstream, sx = null, sxAgent = null, hooks = {},
    reqId = nextUpgradeId(), pinnedIndex = null, sessionId = null, client = null,
    log = console.log,
    firstFrameTimeoutMs = FIRST_FRAME_TIMEOUT_MS, dialTimeoutMs = DIAL_TIMEOUT_MS,
    holdBudgetMs = 0, retryAfter = () => 60, holdPollMaxMs = 60_000,
  } = ctx;
  const path = req.url || '/';
  const key = req.headers['sec-websocket-key'];
  if (!/websocket/i.test(String(req.headers.upgrade || '')) || !key) {
    refuseUpgrade(socket, 400, 'Expected a WebSocket upgrade');
    return;
  }

  hooks.onRequestStart?.(reqId, { method: 'WS', path, sessionId, pinned: pinnedIndex != null, client });
  // The session is "in flight" for the connection's whole life, exactly as a
  // request is for its duration: counted as active, never expired mid-turn.
  // And once an account is chosen, the session is pinned to it — that pin is
  // what keeps a Codex thread on ONE account across its turns, which is what
  // its prompt cache (keyed by the thread's `prompt_cache_key`, held per
  // account for 24h) depends on. Without it, session distribution would treat
  // every connection as a new session and spread one thread across the pool.
  am.beginSession(sessionId, { client });

  // Step 1: the client's handshake completes here, before any account exists.
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`);

  const clientDecoder = new FrameDecoder();
  let upstreamDecoder = new FrameDecoder();
  const state = {
    closed: false,
    dialing: false,
    connected: false,
    model: null,
    account: null,
    tried: new Set(),
    reauthed: false,
    pending: [],           // raw client bytes buffered until upstream is open
    pendingBytes: 0,
    upstreamSocket: null,
    upstreamReq: null,
    observeUpstream: true, // dropped if the passive decoder loses sync
    observeClient: true,
    inResponse: false,     // a response is streaming; rotation waits for its end
    rotateAfterResponse: false,
    // The client's latest `response.create`, replayed on another account
    // when this one refuses the response before producing any of it.
    lastRequest: null,
    // While `holding`, upstream bytes are kept in `heldRaw` (verbatim chunks,
    // so a commit forwards exactly what upstream sent) instead of spliced.
    holding: false,
    heldRaw: [],
    heldBytes: 0,
    endStatus: null,
    holdBudgetMs,
    holdTimer: null,
  };
  // Declared before anything that can run finish() or startDial(): the
  // upgrade's `head` bytes are fed to the decoder below, and a client that
  // coalesces its first frame with the handshake reaches both from there.
  let firstFrameTimer = null;

  const finish = (code, reason, status) => {
    if (state.closed) return;
    state.closed = true;
    clearTimeout(firstFrameTimer);
    clearTimeout(state.holdTimer);
    if (!socket.destroyed) {
      if (code != null) { try { socket.write(closeFrame(code, reason)); } catch { /* peer gone */ } }
      socket.end();
      // A peer that never answers the close frame must not pin the socket open.
      setTimeout(() => socket.destroy(), 1000).unref();
    }
    state.upstreamSocket?.destroy();
    state.upstreamReq?.destroy();
    am.endSession(sessionId);
    hooks.onRequestEnd?.(reqId, {
      method: 'WS', path,
      account: state.account ? state.account.name : '(no account)',
      status: status ?? state.endStatus ?? (state.connected ? 200 : 502),
      model: state.model, sessionId, pinned: pinnedIndex != null,
    });
  };

  // ── client side ──────────────────────────────────────────────────────────

  const onClientFrame = (frame) => {
    if (frame.opcode === OPCODE.TEXT) {
      // Each request opens a response whose preamble is held until output
      // starts (see observeEvent); the request itself is kept for a replay.
      state.lastRequest = Buffer.from(frame.payload);
      state.holding = true;
    }
    if (frame.opcode === OPCODE.TEXT && !state.dialing) {
      // The first message names the model. Anything else (a prewarm sends
      // `input: []` but still carries `model`) is dialed as-is.
      state.model = parseRequestModel(frame.payload);
      if (state.model) hooks.onRequestModel?.(reqId, { model: state.model });
      startDial();
    } else if (frame.opcode === OPCODE.CLOSE && !state.connected) {
      // Closed before upstream was ever reached: nothing to relay the close to.
      finish(null, '', 200);
    }
  };

  // Splice one chunk across, pausing the reader while the writer is behind.
  const relay = (from, to, chunk) => {
    if (to.destroyed) return;
    if (!to.write(chunk)) { from.pause(); to.once('drain', () => from.resume()); }
  };

  const onClientData = (chunk) => {
    if (state.closed) return;
    if (state.upstreamSocket) {
      relay(socket, state.upstreamSocket, chunk);
    } else {
      state.pending.push(chunk);
      state.pendingBytes += chunk.length;
      if (state.pendingBytes > PENDING_LIMIT) { finish(1009, 'too much data before the upstream was open', 413); return; }
    }
    if (!state.observeClient) return;
    let frames;
    try {
      frames = clientDecoder.push(chunk);
    } catch (err) {
      // The client's framing is broken. Before upstream is open there is
      // nothing to splice, so refuse; after it, upstream will judge the bytes.
      if (!state.connected) finish(err.code || 1002, err.message, 400);
      state.observeClient = false;
      return;
    }
    for (const frame of frames) onClientFrame(frame);
  };

  socket.on('data', onClientData);
  socket.on('end', () => { state.upstreamSocket?.destroy(); finish(null, '', state.connected ? 200 : 499); });
  socket.on('close', () => finish(null, '', state.connected ? 200 : 499));
  socket.on('error', () => finish(null, '', state.connected ? 200 : 499));
  if (head?.length) onClientData(head);

  // A client that connects and stays silent is dialed without a model. Not
  // armed when the head already settled it (dialing, or closed).
  if (!state.dialing && !state.closed) {
    firstFrameTimer = setTimeout(() => startDial(), firstFrameTimeoutMs);
    firstFrameTimer.unref?.();
  }

  // ── upstream side ────────────────────────────────────────────────────────

  function startDial() {
    if (state.dialing || state.closed) return;
    state.dialing = true;
    clearTimeout(firstFrameTimer);
    attempt().catch((err) => {
      log(`[TeamClaude] Codex WebSocket relay failed: ${err?.message || err}`);
      finish(1011, 'relay failure', 502);
    });
  }

  async function attempt() {
    if (state.closed) return;
    // A pin is hard: the pinned account or nothing, never a failover.
    const pinned = pinnedIndex != null ? am.accounts[pinnedIndex] : null;
    if (pinned && !state.tried.has(pinnedIndex)) {
      // As on the HTTP path: a pin targets exactly this account, and one that
      // cannot serve right now is refused rather than dialed and rotated.
      const why = am.unavailableReason(pinned, state.model);
      if (why) {
        state.endStatus = 429;
        finish(1013, `teamclaude: pinned account is unavailable (${why}); retry shortly`, 429);
        return;
      }
    }
    const account = pinnedIndex != null
      ? (state.tried.has(pinnedIndex) ? null : pinned)
      : am.getActiveAccount(state.tried, state.model, null, sessionId, 'codex');
    if (!account) {
      // Long-hold mode, as on the HTTP path: keep the client open and poll
      // until an account recovers or the budget runs out. The per-poll sleep
      // is capped so an account re-enabled or reset early is picked up within
      // a minute. `tried` is cleared for the retry: an account whose window
      // reset during the hold is exactly the one to try next. A pin never
      // holds — the pinned account is unavailable, and that is the answer.
      if (pinnedIndex == null && state.holdBudgetMs > 0) {
        const waitMs = Math.min(retryAfter() * 1000, state.holdBudgetMs, holdPollMaxMs);
        state.holdBudgetMs -= waitMs;
        log(`[TeamClaude] All Codex accounts exhausted — holding WebSocket, retry in ${Math.ceil(waitMs / 1000)}s (${Math.ceil(state.holdBudgetMs / 1000)}s budget left)`);
        await new Promise((resolve) => { state.holdTimer = setTimeout(resolve, waitMs); });
        if (state.closed) return;
        state.tried.clear();
        return attempt();
      }
      state.endStatus = 429;
      finish(1013, 'teamclaude: no Codex account has headroom; retry later', 429);
      return;
    }
    state.account = account;
    am.recordSession(sessionId, account.index, state.model);
    hooks.onRequestRouted?.(reqId, { account: account.name });

    // The account is chosen after the 101, so a host already known to refuse
    // WebSockets (accounts may sit behind different upstreams) can only be
    // answered with a close here; it is at least not dialed again.
    if (webSocketRefused(new URL(upstreamFor(account, upstream)).hostname)) {
      log(`[TeamClaude] Upstream for "${account.name}" refused WebSockets recently; closing so the client takes HTTP`);
      finish(1011, 'teamclaude: upstream 426; use HTTP', 426);
      return;
    }
    try {
      await am.ensureTokenFresh(account.index);
    } catch (err) {
      log(`[TeamClaude] Codex WebSocket: token refresh failed for "${account.name}": ${err?.message || err}`);
      state.tried.add(account.index);
      return pinnedIndex != null ? finish(1011, 'token refresh failed', 502) : attempt();
    }
    if (state.closed) return;
    if (!await am.admit(account.index, () => state.closed)) return;
    if (state.closed) { am.release(account.index); return; }

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lk = name.toLowerCase();
      if (lk.startsWith(':') || STRIP_UPSTREAM.has(lk)) continue;
      headers[lk] = value;
    }
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers['sec-websocket-version'] = '13';
    headers['sec-websocket-key'] = handshakeKey();
    // Codex sends the beta itself; a bare WebSocket client may not.
    if (!String(headers['openai-beta'] || '').includes('responses_websockets')) {
      headers['openai-beta'] = headers['openai-beta'] ? `${headers['openai-beta']}, ${WS_BETA}` : WS_BETA;
    }
    applyAuthHeaders(headers, account);

    const target = new URL(`${upstreamFor(account, upstream)}${path}`);
    const transport = target.protocol === 'http:' ? http : https;
    const useSx = !!(sx?.useByDefault() && sx.isProvisioned());
    // The configured upstream proxy is how this host reaches the network at
    // all (see proxy-modes.md); an sx.org egress, when chosen, wins as it does
    // for requests. Never the default (keep-alive) agent otherwise: a refused
    // upgrade leaves a socket the server has already ended, and a pooled
    // redial would land on it.
    const corporate = proxyForHost(target.hostname);
    const agent = useSx && sxAgent ? sxAgent(sx, target.hostname)
      : corporate ? proxyAgent(corporate, { targetHost: target.hostname, targetPort: Number(target.port) || (target.protocol === 'http:' ? 80 : 443), tls: target.protocol !== 'http:' })
        : false;
    const expectedAccept = computeAccept(headers['sec-websocket-key']);

    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; am.release(account.index); resolve(); } };
      const upstreamReq = transport.request(target, { method: 'GET', headers, agent, timeout: dialTimeoutMs });
      state.upstreamReq = upstreamReq;

      upstreamReq.on('upgrade', (ures, usock, uhead) => {
        done();
        if (state.closed) { usock.destroy(); return; }
        if (ures.headers['sec-websocket-accept'] !== expectedAccept) {
          usock.destroy();
          finish(1011, 'upstream handshake mismatch', 502);
          return;
        }
        bind(account, ures, usock, uhead);
      });

      upstreamReq.on('response', (ures) => {
        const chunks = [];
        let length = 0;
        ures.on('data', (c) => { if (length < ERROR_BODY_LIMIT) { chunks.push(c); length += c.length; } });
        ures.on('end', async () => {
          done();
          try {
            await onRefused(account, ures.statusCode, ures.headers, Buffer.concat(chunks).toString('utf8'), target.hostname);
          } catch (err) {
            log(`[TeamClaude] Codex WebSocket relay failed: ${err?.message || err}`);
            finish(1011, 'relay failure', 502);
          }
        });
        ures.on('error', () => { done(); finish(1011, 'upstream response error', 502); });
      });

      upstreamReq.on('timeout', () => { upstreamReq.destroy(new Error('upstream handshake timed out')); });
      upstreamReq.on('error', (err) => {
        done();
        if (state.closed || state.connected) return;
        log(`[TeamClaude] Codex WebSocket dial to "${account.name}" failed: ${err?.message || err}`);
        finish(1011, `upstream unreachable: ${err?.code || err?.message || 'error'}`, 502);
      });
      upstreamReq.end();
    });
  }

  /** The upstream refused the handshake with an ordinary HTTP response. */
  async function onRefused(account, status, headers, bodyText, host) {
    if (state.closed) return;
    const cls = classifyCodexRejection({ status, headers, body: bodyText });
    const quotaHeaders = {};
    for (const [k, v] of Object.entries(headers)) if (k.startsWith('x-codex-')) quotaHeaders[k] = v;
    if (Object.keys(quotaHeaders).length) am.updateQuota(account.index, quotaHeaders);

    if (cls.kind === 'credential' && !state.reauthed) {
      state.reauthed = true;
      log(`[TeamClaude] 401 on "${account.name}" (WebSocket) — token rejected; forcing refresh and redialing`);
      await am.ensureTokenFresh(account.index, true);
      return attempt();
    }
    if (cls.kind === 'quota') {
      const modelOnly = state.model && am.modelBucketSpent(account.index, state.model);
      if (modelOnly) {
        log(`[TeamClaude] ${modelOnly} weekly exhausted on "${account.name}" (WebSocket) — switching account`);
      } else {
        const hold = Math.min(Math.max(cls.retryAfter ?? QUOTA_HOLD_SECONDS, 1), 3600);
        log(`[TeamClaude] Codex quota exhausted (${status}${cls.reachedType ? ' ' + cls.reachedType : ''}) on "${account.name}" (WebSocket) — throttling ${hold}s and switching account`);
        am.markRateLimited(account.index, hold);
      }
      state.tried.add(account.index);
      if (pinnedIndex != null) { state.endStatus = 429; return finish(1013, 'teamclaude: pinned account is out of quota', 429); }
      return attempt();
    }
    if (cls.kind === 'entitlement') {
      am.markEntitlementDenied(account.index);
      log(`[TeamClaude] ${status} on "${account.name}" (WebSocket); Codex refused the model or workspace (${cls.code || 'no code'})`);
      state.tried.add(account.index);
      if (pinnedIndex != null) return finish(1008, 'teamclaude: pinned account cannot serve this model', status);
      return attempt();
    }
    if (cls.kind === 'rate-limit') {
      const wait = Math.min(Math.max(cls.retryAfter ?? 60, 1), 300);
      // Not a rotation (see routing.md, "the two kinds of 429"): pause the
      // account so concurrent dials wait, and let Codex's own retry come back.
      am.pauseAccount(account.index, Math.min(wait, 60));
      log(`[TeamClaude] Rate-limit ${status} on "${account.name}" (WebSocket) — retry-after ${wait}s; asking the client to retry`);
      state.endStatus = 429;
      return finish(1013, `teamclaude: rate limited; retry in ${wait}s`, 429);
    }
    // A 426 means this upstream wants HTTP. This connection can only be
    // closed (the client already has its 101; Codex falls back to SSE for
    // the turn on the failure), but the next upgrade is refused with a real
    // 426 before any 101 — see webSocketRefused.
    if (status === 426) {
      noteWebSocketRefused(host);
      log(`[TeamClaude] Upstream 426 on Codex WebSocket handshake for "${account.name}" — refusing WebSockets for ${Math.round(WS_REFUSED_TTL_MS / 60000)} min so clients take SSE`);
      finish(1011, 'teamclaude: upstream 426; use HTTP', 426);
      return;
    }
    // Anything else is an upstream problem; the client is told the status
    // and decides itself.
    log(`[TeamClaude] Upstream ${status} on Codex WebSocket handshake for "${account.name}"`);
    finish(1011, `teamclaude: upstream ${status}`, status);
  }

  /** Both handshakes are done: splice, flush, and start observing. */
  function bind(account, ures, usock, uhead) {
    state.connected = true;
    state.upstreamSocket = usock;
    const quotaHeaders = {};
    for (const [k, v] of Object.entries(ures.headers)) if (k.startsWith('x-codex-')) quotaHeaders[k] = v;
    // Counts as one request for the account's bookkeeping, like an HTTP call;
    // the per-response readings then arrive as frames.
    am.updateQuota(account.index, quotaHeaders);

    for (const chunk of state.pending) usock.write(chunk);
    state.pending = [];
    state.pendingBytes = 0;
    if (uhead?.length) onUpstreamData(uhead);

    usock.on('data', onUpstreamData);
    // An upgraded socket is half-open by default (see relayUpgrade): react to
    // both 'end' and 'close' on each side so neither can linger. Guarded by
    // identity: a socket left behind by a retry (see retryElsewhere) must not
    // end the client when it finally closes.
    // A preamble still held when upstream goes away is forwarded first: the
    // client gets what upstream said (a close frame among it) before its end.
    const current = () => state.upstreamSocket === usock;
    usock.on('end', () => { if (current()) { flushHeld(); finish(null, '', 200); } });
    usock.on('close', () => { if (current()) { flushHeld(); finish(null, '', 200); } });
    usock.on('error', () => { if (current()) { flushHeld(); finish(null, '', 200); } });
  }

  /** Forward the held preamble and go back to splicing. */
  function flushHeld() {
    if (!state.holding) return;
    state.holding = false;
    const held = state.heldRaw;
    state.heldRaw = [];
    state.heldBytes = 0;
    for (const chunk of held) relay(state.upstreamSocket, socket, chunk);
  }

  /**
   * The account refused the response before producing any of it (a spent
   * window, a workspace spend cap, an entitlement): nothing has reached the
   * client, so the same request can be answered by another account. Drop the
   * held preamble, leave this upstream, and dial again with the request queued
   * as the first thing the new upstream hears — the client sees one response.
   */
  function retryElsewhere(account, why) {
    const usock = state.upstreamSocket;
    state.upstreamSocket = null;
    state.connected = false;
    usock.removeAllListeners('data');
    usock.destroy();
    state.heldRaw = [];
    state.heldBytes = 0;
    state.holding = true;
    state.inResponse = false;
    state.rotateAfterResponse = false;
    state.observeUpstream = true;
    upstreamDecoder = new FrameDecoder();
    state.tried.add(account.index);
    // Client-to-server frames are masked on the wire; the replay is one.
    const replay = encodeFrame(OPCODE.TEXT, state.lastRequest, { mask: true });
    state.pending.unshift(replay);
    state.pendingBytes += replay.length;
    log(`[TeamClaude] Codex refused the response on "${account.name}" (${why}) before any output — retrying it on another account`);
    attempt().catch((err) => {
      log(`[TeamClaude] Codex WebSocket relay failed: ${err?.message || err}`);
      finish(1011, 'relay failure', 502);
    });
  }

  function onUpstreamData(chunk) {
    if (state.closed) return;
    const usock = state.upstreamSocket;
    if (state.holding) {
      state.heldRaw.push(chunk);
      state.heldBytes += chunk.length;
    } else {
      relay(usock, socket, chunk);
    }
    // Holding is only possible while the frames can be read; without that
    // there is nothing to judge, and the bytes go through as they are.
    if (!state.observeUpstream) { flushHeld(); return; }
    let frames;
    try {
      frames = upstreamDecoder.push(chunk);
    } catch {
      // Lost sync with upstream's framing: keep splicing, stop reading.
      state.observeUpstream = false;
      flushHeld();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode !== OPCODE.TEXT) continue;
      observeEvent(frame.payload);
      // A retry left this socket behind; the rest of the chunk is its.
      if (state.upstreamSocket !== usock) return;
    }
    if (state.holding && state.heldBytes > HELD_LIMIT) flushHeld();
  }

  /** Read one upstream event for quota and refusal signals. */
  function observeEvent(payload) {
    const account = state.account;
    if (!account) return;
    // Cheap pre-check: most frames are deltas that carry nothing of interest.
    const headText = payload.subarray(0, 256).toString('utf8');
    const typeMatch = /"type"\s*:\s*"([^"]+)"/.exec(headText);
    const type = typeMatch ? typeMatch[1] : null;
    if (!type) return;

    if (type === 'codex.rate_limits') {
      const parsed = parseCodexRateLimitsEvent(payload.toString('utf8'));
      if (parsed) am.applyCodexUsageData(account.index, parsed);
      state.inResponse = true;
      return;
    }
    if (type === 'response.created') state.inResponse = true;
    if (PREAMBLE_EVENTS.has(type)) return;

    if (type === 'error' || type === 'response.failed') {
      let code = null;
      let resetsIn = null;
      try {
        const body = JSON.parse(payload.toString('utf8'));
        const err = body.error || body.response?.error || body;
        code = [err?.code, err?.type].find(v => typeof v === 'string' && v) || null;
        // Codex's usage-limit errors say when the window reopens; a spend
        // cap says nothing, and is re-checked after the default hold.
        if (Number.isFinite(err?.resets_in_seconds)) resetsIn = err.resets_in_seconds;
        else if (Number.isFinite(err?.resets_at)) resetsIn = err.resets_at * 1000 - Date.now() > 0 ? (err.resets_at * 1000 - Date.now()) / 1000 : null;
      } catch { /* not JSON: nothing to classify */ }
      if (code && EVENT_QUOTA_CODES.has(code)) {
        const modelOnly = state.model && am.modelBucketSpent(account.index, state.model);
        const hold = resetsIn != null ? Math.min(Math.max(Math.ceil(resetsIn), 60), 8 * 24 * 3600) : QUOTA_HOLD_SECONDS;
        if (!modelOnly) am.markRateLimited(account.index, hold);
        // Nothing of this response has reached the client yet, and this is
        // no pin: another account can answer the very same request. Only
        // when one has headroom — otherwise the true error is the answer.
        const canRetry = state.holding && pinnedIndex == null && state.lastRequest
          && am.getActiveAccount(new Set([...state.tried, account.index]), state.model, null, sessionId, 'codex');
        if (canRetry) { retryElsewhere(account, code); return; }
        log(`[TeamClaude] Codex quota exhausted mid-connection (${code}) on "${account.name}" — rotating on the next connection`);
        state.rotateAfterResponse = true;
      }
    }
    // Anything else is output, or a verdict the client must see: commit.
    flushHeld();

    if (TERMINAL_EVENTS.has(type)) {
      state.inResponse = false;
      // The account may have crossed the threshold on this very response.
      // Closing here, between responses, is what makes Codex reconnect with
      // its full input and land on whichever account is eligible now.
      if (state.rotateAfterResponse || am.unavailableReason(account, state.model)) {
        log(`[TeamClaude] Closing Codex WebSocket on "${account.name}" so the next response is routed afresh`);
        finish(1012, 'teamclaude: account rotated; reconnect', 200);
      }
    }
  }
}
