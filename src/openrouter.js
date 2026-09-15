// OpenRouter guard: terminates openrouter.ai for the client's own requests, blocks model
// families the subscription pools serve, and retries transient upstream failures.
//
// The client's key goes to OpenRouter untouched and no account credential is ever added.

import { upstreamFetch } from './upstream-fetch.js';
import { HOP_BY_HOP_HEADERS, isTransientUpstreamError, readWithIdleTimeout, describeConnectError } from './server.js';
import { modelGlobMatches } from './model.js';
import { safeLine } from './safe-text.js';

export const OPENROUTER_HOST = 'openrouter.ai';
export const DEFAULT_OPENROUTER_BLOCKED = ['anthropic/*', 'openai/*'];
const DEFAULT_OPENROUTER_UPSTREAM = 'https://openrouter.ai';
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 1000;
const MAX_RETRIES = 10;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const MAX_EVENT_CHARS = 8 * 1024 * 1024;
const MAX_BACKOFF_MS = 8_000;
const MAX_RETRY_AFTER_MS = 30_000;

// Appended to a transient error the proxy gives up on, so the client's own retry
// (pi matches /connection.?error/) takes over instead of ending the run.
export const RETRY_HINT = ' (teamclaude: upstream connection error, safe to retry)';

const RETRY_STATUSES = new Set([408, 500, 502, 503, 504, 520, 522, 524, 529]);
const TRANSIENT_MESSAGE = /h2 protocol error|error reading a body|stream error|connection (?:reset|closed|lost|error|refused|terminated)|disconnected|socket hang up|econnreset|epipe|timed? ?out|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway timeout|internal server error/i;
const PERMANENT_MESSAGE = /context (?:length|window)|too many tokens|invalid|not supported|unsupported|moderation|flagged|insufficient|credits|billing|quota|unauthori[sz]ed|forbidden|not found|no endpoints/i;

/** Whether this config asks the proxy to terminate openrouter.ai at all. */
export function openrouterIntercepted(/** @type {any} */ config) {
  return config?.openrouter?.intercept === true;
}

/** @param {any} config */
function settings(config) {
  const o = config?.openrouter || {};
  const retries = Number.isInteger(o.retries) ? Math.min(Math.max(o.retries, 0), MAX_RETRIES) : DEFAULT_RETRIES;
  return {
    upstream: typeof o.upstream === 'string' && o.upstream ? o.upstream.replace(/\/+$/, '') : DEFAULT_OPENROUTER_UPSTREAM,
    blocked: Array.isArray(o.blockedModels) ? o.blockedModels.filter((/** @type {unknown} */ p) => typeof p === 'string') : DEFAULT_OPENROUTER_BLOCKED,
    retries,
    retryBaseMs: Number.isFinite(o.retryBaseMs) && o.retryBaseMs >= 0 ? o.retryBaseMs : DEFAULT_RETRY_BASE_MS,
  };
}

/**
 * The first model a request names that a pattern blocks, or null. Checks `model`
 * and the `models` fallback list, with OpenRouter's `~` latest-alias prefix removed.
 */
export function blockedOpenRouterModel(/** @type {Buffer} */ body, /** @type {string[]} */ patterns) {
  if (!patterns?.length || !body?.length) return null;
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const named = [parsed.model, ...(Array.isArray(parsed.models) ? parsed.models : [])];
  for (const raw of named) {
    if (typeof raw !== 'string') continue;
    const model = raw.trim().replace(/^~/, '');
    const pattern = patterns.find((p) => modelGlobMatches(p, model));
    if (pattern) return { model: raw, pattern };
  }
  return null;
}

/** Whether an upstream failure is worth retrying: a transport fault, not a refusal. */
export function isTransientFailure({ status = null, code = null, message = '' } = {}) {
  const text = String(message || '');
  if (PERMANENT_MESSAGE.test(text)) return false;
  if (TRANSIENT_MESSAGE.test(text)) return true;
  const numeric = Number(code ?? status);
  if (RETRY_STATUSES.has(numeric)) return true;
  return code === 'server_error';
}

/** The error message with the retry hint appended once. */
export function withRetryHint(/** @type {unknown} */ message) {
  const text = String(message || 'Upstream connection error');
  return text.includes(RETRY_HINT) ? text : text + RETRY_HINT;
}

function openAIError(/** @type {number} */ status, /** @type {string} */ message, /** @type {string} */ type) {
  return JSON.stringify({ error: { message, code: status, type } });
}

function blockedMessage(/** @type {string} */ model, /** @type {string} */ pattern) {
  return `Model "${model}" is blocked on OpenRouter by teamclaude (matched "${pattern}"). `
    + 'Use a teamclaude/* model instead, so the request is served from the subscription pool.';
}

/** The host a request inside the tunnel names, lowercased, without port or root dot. */
function requestHost(/** @type {any} */ req) {
  const raw = String(req.headers[':authority'] || req.headers.host || '').toLowerCase();
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  return host.replace(/\.$/, '');
}

function forwardHeaders(/** @type {any} */ req) {
  /** @type {Record<string, string|string[]>} */
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'proxy-connection' || lk === 'content-length' || lk === 'accept-encoding') continue;
    if (value !== undefined) headers[lk] = value;
  }
  // Identity, so error events in the body can be read without decompressing it.
  headers['accept-encoding'] = 'identity';
  return headers;
}

function responseHeaders(/** @type {any} */ upstreamRes) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of upstreamRes.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key) || key === 'content-length') continue;
    out[key] = value;
  }
  return out;
}

async function readCapped(/** @type {ReadableStream<Uint8Array>} */ webStream, /** @type {number} */ cap) {
  const reader = webStream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks);
}

/** The error object a JSON body or SSE data payload carries, if any. */
function errorOf(/** @type {any} */ json) {
  if (!json || typeof json !== 'object') return null;
  if (json.error && typeof json.error === 'object') return json.error;
  if (typeof json.error === 'string') return { message: json.error };
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  if (choice?.finish_reason === 'error') return { message: 'Provider finish_reason: error', code: 'server_error' };
  return null;
}

function parseJson(/** @type {string} */ text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Whether an SSE data payload carries anything the client would render or act on. */
function carriesOutput(/** @type {any} */ json) {
  if (json === undefined) return true;
  if (!json || typeof json !== 'object') return true;
  const choices = Array.isArray(json.choices) ? json.choices : [];
  if (!choices.length) return !('usage' in json) && !('id' in json);
  return choices.some((/** @type {any} */ c) => {
    const d = c?.delta || c?.message || {};
    if (c?.finish_reason && c.finish_reason !== 'error') return true;
    if (typeof d.content === 'string' && d.content.length) return true;
    if (Array.isArray(d.tool_calls) && d.tool_calls.length) return true;
    for (const f of ['reasoning', 'reasoning_content', 'reasoning_text', 'refusal']) {
      if (typeof d[f] === 'string' && d[f].length) return true;
    }
    return Array.isArray(d.reasoning_details) && d.reasoning_details.length > 0;
  });
}

/** Split a buffer of SSE text into complete events and the unfinished tail. */
export function splitSseEvents(/** @type {string} */ text) {
  const events = [];
  const re = /\r?\n\r?\n/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    events.push(text.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  return { events, rest: text.slice(last) };
}

function eventData(/** @type {string} */ raw) {
  const lines = raw.split(/\r?\n/).filter(l => l.startsWith('data:'));
  if (!lines.length) return null;
  return lines.map(l => l.slice(5).replace(/^ /, '')).join('\n');
}

function sseError(/** @type {string} */ message, /** @type {number} */ code) {
  return `data: ${JSON.stringify({ error: { message, code } })}\n\n`;
}

function sleep(/** @type {number} */ ms, /** @type {AbortSignal} */ signal) {
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  }));
}

function backoffMs(/** @type {number} */ attempt, /** @type {string|null|undefined} */ retryAfter, /** @type {number} */ baseMs) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return Math.min(baseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

function bodyIdleMs() {
  const env = Number(process.env.TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS);
  return env > 0 ? env : 120_000;
}

function write(/** @type {any} */ res, /** @type {string|Uint8Array} */ chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  if (res.write(chunk)) return Promise.resolve();
  return /** @type {Promise<void>} */ (new Promise((resolve) => {
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  }));
}

/**
 * Request listener for the terminated openrouter.ai tunnel.
 * @param {{ config: any, hooks?: any, log?: (line: string) => void }} opts
 */
export function createOpenRouterListener({ config, hooks = {}, log = () => {} }) {
  let counter = 0;
  return async (/** @type {any} */ req, /** @type {any} */ res) => {
    const id = `openrouter-${++counter}`;
    const path = `${OPENROUTER_HOST}${safeLine(req.url || '/', 200)}`;
    /** @type {string|null} */
    let model = null;
    let ended = false;
    const end = (/** @type {number} */ status, /** @type {string} */ account) => {
      if (ended) return;
      ended = true;
      hooks.onRequestEnd?.(id, { method: req.method, path, account, status, model, sessionId: null, pinned: false });
    };
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    hooks.onRequestStart?.(id, { method: req.method, path, sessionId: null, pinned: false, client: null });
    try {
      if (requestHost(req) !== OPENROUTER_HOST) {
        res.writeHead(421, { 'content-type': 'application/json' });
        res.end(openAIError(421, 'This tunnel only serves openrouter.ai', 'misdirected_request'));
        end(421, '(misdirected)');
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(openAIError(413, 'Request body too large', 'invalid_request_error'));
          end(413, '(too large)');
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const s = settings(config);
      const parsedModel = parseJson(body.toString('utf8'))?.model;
      if (typeof parsedModel === 'string') {
        model = safeLine(parsedModel, 64);
        hooks.onRequestModel?.(id, { model });
      }

      const blocked = blockedOpenRouterModel(body, s.blocked);
      if (blocked) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(openAIError(400, blockedMessage(blocked.model, blocked.pattern), 'invalid_request_error'));
        end(400, '(blocked)');
        return;
      }

      const outcome = await forwardWithRetry({ req, res, body, s, signal: ctrl.signal, log, label: model || req.url });
      end(outcome.status, outcome.retries ? `openrouter, ${outcome.retries} ${outcome.retries === 1 ? 'retry' : 'retries'}` : 'openrouter');
    } catch (err) {
      log(`[TeamClaude] OpenRouter: ${describeConnectError(err)}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(openAIError(502, withRetryHint('OpenRouter request failed in teamclaude'), 'proxy_error'));
      } else if (!res.writableEnded) {
        res.destroy();
      }
      end(502, 'openrouter');
    }
  };
}

/** @param {{ req: any, res: any, body: Buffer, s: ReturnType<typeof settings>, signal: AbortSignal, log: (line: string) => void, label: string }} opts */
async function forwardWithRetry({ req, res, body, s, signal, log, label }) {
  const url = `${s.upstream}${req.url || '/'}`;
  const headers = forwardHeaders(req);
  const hasBody = body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';
  const attempts = s.retries + 1;
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    const retry = async (/** @type {string} */ reason, /** @type {string|null} */ retryAfter = null) => {
      const wait = backoffMs(attempt, retryAfter, s.retryBaseMs);
      log(`[TeamClaude] OpenRouter: ${safeLine(label || '', 64)} failed (${safeLine(reason, 160)}), retry ${attempt}/${s.retries} in ${wait < 1000 ? `${wait}ms` : `${Math.round(wait / 1000)}s`}`);
      await sleep(wait, signal);
    };

    let upstreamRes;
    try {
      upstreamRes = await upstreamFetch(url, { method: req.method, headers, body: hasBody ? body : undefined, signal });
    } catch (err) {
      if (signal.aborted) return { status: 499, retries: attempt - 1 };
      const reason = describeConnectError(err);
      const transient = isTransientUpstreamError(err) || isTransientFailure({ message: /** @type {any} */ (err)?.message });
      if (transient && !last) { await retry(reason); if (signal.aborted) return { status: 499, retries: attempt }; continue; }
      const message = transient ? withRetryHint(`OpenRouter unreachable: ${reason}`) : `OpenRouter unreachable: ${reason}`;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(openAIError(502, message, 'proxy_error'));
      } else {
        await write(res, sseError(message, 502));
        res.end();
      }
      return { status: 502, retries: attempt - 1 };
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const encoded = (upstreamRes.headers.get('content-encoding') || 'identity') !== 'identity';

    if (upstreamRes.status < 200 || upstreamRes.status >= 300) {
      const errBody = await readCapped(upstreamRes.body, MAX_ERROR_BODY_BYTES);
      const json = errBody && !encoded ? parseJson(errBody.toString('utf8')) : undefined;
      const err = errorOf(json);
      const transient = isTransientFailure({ status: upstreamRes.status, code: err?.code, message: err?.message });
      if (transient && !last) { await retry(`${upstreamRes.status} ${err?.message || ''}`.trim(), upstreamRes.headers.get('retry-after')); if (signal.aborted) return { status: 499, retries: attempt }; continue; }
      if (res.headersSent) {
        await write(res, sseError(transient ? withRetryHint(err?.message || `OpenRouter returned ${upstreamRes.status}`) : (err?.message || `OpenRouter returned ${upstreamRes.status}`), upstreamRes.status));
        res.end();
      } else if (transient && json && err) {
        err.message = withRetryHint(err.message || `OpenRouter returned ${upstreamRes.status}`);
        res.writeHead(upstreamRes.status, { ...responseHeaders(upstreamRes), 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      } else {
        res.writeHead(upstreamRes.status, responseHeaders(upstreamRes));
        res.end(errBody ?? '');
      }
      return { status: upstreamRes.status, retries: attempt - 1 };
    }

    if (encoded || !/text\/event-stream/i.test(contentType)) {
      if (encoded) {
        if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders(upstreamRes));
        await pipeRaw(upstreamRes.body, res);
        return { status: upstreamRes.status, retries: attempt - 1 };
      }
      const full = await readCapped(upstreamRes.body, MAX_REQUEST_BYTES);
      if (!full) {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(openAIError(502, 'OpenRouter response too large for teamclaude to relay', 'proxy_error'));
        } else {
          res.destroy();
        }
        return { status: 502, retries: attempt - 1 };
      }
      const err = errorOf(parseJson(full.toString('utf8')));
      if (err && isTransientFailure({ code: err.code, message: err.message }) && !last) {
        await retry(err.message || 'error in response body');
        if (signal.aborted) return { status: 499, retries: attempt };
        continue;
      }
      if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders(upstreamRes));
      res.end(full);
      return { status: upstreamRes.status, retries: attempt - 1 };
    }

    if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders(upstreamRes));
    const streamed = await relaySse(upstreamRes.body, res, { canRetry: !last });
    if (streamed.retry) {
      await retry(streamed.reason || 'stream failed');
      if (signal.aborted) return { status: 499, retries: attempt };
      continue;
    }
    return { status: upstreamRes.status, retries: attempt - 1 };
  }
}

async function pipeRaw(/** @type {ReadableStream<Uint8Array>} */ webStream, /** @type {any} */ res) {
  const reader = webStream.getReader();
  try {
    for (;;) {
      const { done, value } = await readWithIdleTimeout(reader, bodyIdleMs());
      if (done) break;
      await write(res, value);
    }
    res.end();
  } catch {
    res.destroy();
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/**
 * Relay one SSE attempt. Data events are held until one carries output; a transient
 * failure before that asks for a retry, after it the error is tagged for the client.
 * @param {ReadableStream<Uint8Array>} webStream
 * @param {any} res
 * @param {{ canRetry: boolean }} opts
 * @returns {Promise<{ retry: boolean, reason?: string }>}
 */
export async function relaySse(webStream, res, { canRetry }) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  /** @type {string[]} */
  let held = [];
  let output = false;
  let finished = false;
  const flush = async () => {
    for (const e of held) await write(res, e);
    held = [];
  };
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await readWithIdleTimeout(reader, bodyIdleMs());
      } catch (err) {
        const reason = describeConnectError(err);
        if (!output && canRetry) return { retry: true, reason };
        await flush();
        await write(res, sseError(withRetryHint(`OpenRouter stream failed: ${reason}`), 502));
        res.end();
        return { retry: false };
      }
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const { events, rest } = splitSseEvents(pending);
      pending = rest;
      if (pending.length > MAX_EVENT_CHARS) { events.push(pending); pending = ''; }
      for (const raw of events) {
        const data = eventData(raw);
        if (data === null) {
          await write(res, raw);
          continue;
        }
        if (data.trim() === '[DONE]') {
          finished = true;
          await flush();
          await write(res, raw);
          continue;
        }
        const json = parseJson(data);
        const err = errorOf(json);
        if (err) {
          const transient = isTransientFailure({ code: err.code, message: err.message });
          if (transient && !output && canRetry) return { retry: true, reason: String(err.message || err.code || 'stream error') };
          await flush();
          if (transient) {
            json.error = { ...(json.error && typeof json.error === 'object' ? json.error : {}), message: withRetryHint(err.message) };
            await write(res, `data: ${JSON.stringify(json)}\n\n`);
          } else {
            await write(res, raw);
          }
          finished = true;
          continue;
        }
        if (!output && !carriesOutput(json)) {
          held.push(raw);
          continue;
        }
        if (!output) { output = true; await flush(); }
        if (json?.choices?.some?.((/** @type {any} */ c) => c?.finish_reason)) finished = true;
        await write(res, raw);
      }
    }
    if (pending.trim()) { await flush(); await write(res, pending); }
    if (!finished) {
      if (!output && canRetry) return { retry: true, reason: 'stream ended before a finish_reason' };
      await flush();
      await write(res, sseError(withRetryHint('OpenRouter stream ended before a finish_reason'), 502));
    } else {
      await flush();
    }
    res.end();
    return { retry: false };
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}
