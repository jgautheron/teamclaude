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
//
// The upstream 101 carried no quota headers in any live capture; the
// `codex.rate_limits` frame that opens every response does. Both are read.

import http from 'node:http';
import https from 'node:https';
import { parseRequestModel } from './model.js';
import { applyAuthHeaders, upstreamFor } from './provider.js';
import { parseCodexRateLimitsEvent, classifyCodexRejection } from './codex-quota.js';
import { FrameDecoder, computeAccept, handshakeKey, closeFrame, OPCODE } from './ws-frames.js';

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

let upgradeCounter = 0;

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
  } = ctx;
  const path = req.url || '/';
  const key = req.headers['sec-websocket-key'];
  if (!/websocket/i.test(String(req.headers.upgrade || '')) || !key) {
    refuseUpgrade(socket, 400, 'Expected a WebSocket upgrade');
    return;
  }

  hooks.onRequestStart?.(reqId, { method: 'WS', path, sessionId, pinned: pinnedIndex != null, client });

  // Step 1: the client's handshake completes here, before any account exists.
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${computeAccept(key)}\r\n\r\n`);

  const clientDecoder = new FrameDecoder();
  const upstreamDecoder = new FrameDecoder();
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
    endStatus: null,
  };

  const finish = (code, reason, status) => {
    if (state.closed) return;
    state.closed = true;
    clearTimeout(firstFrameTimer);
    if (!socket.destroyed) {
      if (code != null) { try { socket.write(closeFrame(code, reason)); } catch { /* peer gone */ } }
      socket.end();
      // A peer that never answers the close frame must not pin the socket open.
      setTimeout(() => socket.destroy(), 1000).unref();
    }
    state.upstreamSocket?.destroy();
    state.upstreamReq?.destroy();
    hooks.onRequestEnd?.(reqId, {
      method: 'WS', path,
      account: state.account ? state.account.name : '(no account)',
      status: status ?? state.endStatus ?? (state.connected ? 200 : 502),
      model: state.model, sessionId, pinned: pinnedIndex != null,
    });
  };

  // ── client side ──────────────────────────────────────────────────────────

  const onClientFrame = (frame) => {
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

  // A client that connects and stays silent is dialed without a model.
  const firstFrameTimer = setTimeout(() => startDial(), firstFrameTimeoutMs);
  firstFrameTimer.unref?.();

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
    const account = pinnedIndex != null
      ? (state.tried.has(pinnedIndex) ? null : am.accounts[pinnedIndex])
      : am.getActiveAccount(state.tried, state.model, null, sessionId, 'codex');
    if (!account) {
      state.endStatus = 429;
      finish(1013, 'teamclaude: no Codex account has headroom; retry later', 429);
      return;
    }
    state.account = account;
    hooks.onRequestRouted?.(reqId, { account: account.name });

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
    const useProxy = !!(sx?.useByDefault() && sx.isProvisioned());
    // Never the default (keep-alive) agent: a refused upgrade leaves a socket
    // the server has already ended, and a pooled redial would land on it.
    const agent = useProxy && sxAgent ? sxAgent(sx, target.hostname) : false;
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
            await onRefused(account, ures.statusCode, ures.headers, Buffer.concat(chunks).toString('utf8'));
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
  async function onRefused(account, status, headers, bodyText) {
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
    // A 426 means this upstream wants HTTP; anything else is an upstream
    // problem. Either way the client is told the status and decides itself.
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
    // both 'end' and 'close' on each side so neither can linger.
    usock.on('end', () => finish(null, '', 200));
    usock.on('close', () => finish(null, '', 200));
    usock.on('error', () => finish(null, '', 200));
  }

  function onUpstreamData(chunk) {
    if (state.closed) return;
    relay(state.upstreamSocket, socket, chunk);
    if (!state.observeUpstream) return;
    let frames;
    try {
      frames = upstreamDecoder.push(chunk);
    } catch {
      // Lost sync with upstream's framing: keep splicing, stop reading.
      state.observeUpstream = false;
      return;
    }
    for (const frame of frames) {
      if (frame.opcode !== OPCODE.TEXT) continue;
      observeEvent(frame.payload);
    }
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
    if (type === 'response.created') { state.inResponse = true; return; }

    if (type === 'error' || type === 'response.failed') {
      let code = null;
      try {
        const body = JSON.parse(payload.toString('utf8'));
        const err = body.error || body.response?.error || body;
        code = [err?.code, err?.type].find(v => typeof v === 'string' && v) || null;
      } catch { /* not JSON: nothing to classify */ }
      if (code && EVENT_QUOTA_CODES.has(code)) {
        const modelOnly = state.model && am.modelBucketSpent(account.index, state.model);
        if (!modelOnly) am.markRateLimited(account.index, QUOTA_HOLD_SECONDS);
        log(`[TeamClaude] Codex quota exhausted mid-connection (${code}) on "${account.name}" — rotating on the next connection`);
        state.rotateAfterResponse = true;
      }
    }

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
