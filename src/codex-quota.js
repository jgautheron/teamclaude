// Codex rate limits.
//
// A Codex account reports its quota three ways, all carrying the same numbers:
//
//   1. `x-codex-*` response headers on every HTTP response. The shape observed
//      on a live response (values here are illustrative):
//
//        x-codex-primary-used-percent: 42
//        x-codex-primary-window-minutes: 10080
//        x-codex-primary-reset-at: <epoch seconds>
//        x-codex-secondary-used-percent: 0
//        x-codex-secondary-window-minutes: 0
//        x-codex-<slug>-primary-used-percent: 0
//        x-codex-<slug>-primary-window-minutes: 300
//        x-codex-<slug>-secondary-window-minutes: 10080
//        x-codex-<slug>-limit-name: <model family>
//
//   2. A `codex.rate_limits` event, the first frame the WebSocket transport
//      sends for every response. Same windows, spelled as JSON:
//
//        { "rate_limits": { "primary": { "used_percent", "window_minutes",
//          "reset_at" }, "secondary": null },
//          "additional_rate_limits": { "<limit name>": { "primary", "secondary" } } }
//
//   3. `GET /backend-api/wham/usage`, the zero-spend endpoint the Codex CLI
//      polls for its own status line. Windows here carry
//      `limit_window_seconds` instead of minutes, and the families are an
//      array of `{ limit_name, metered_feature, rate_limit }`.
//
// Three things follow from those shapes.
//
// First, limits arrive in FAMILIES: an unnamed one that is the account-wide
// limit, and named ones (carrying `-limit-name`) that are model-scoped — the
// direct counterpart of Anthropic's `7d_oi` Fable bucket. The header slug of a
// named family (`bengalfox`) is the `metered_feature` of the usage payload with
// its `codex_` prefix removed, which is how the three sources key one bucket.
//
// Second, `primary` and `secondary` are positions, not durations. The
// account-wide family above puts the 7-day window in `primary` while a
// model-scoped family puts a 5-hour window there, and a Go/Free plan reports a
// single 30-day window. So windows are classified by their stated duration,
// never by position — reading `primary` as "the 5h bucket" would file a weekly
// reading as a session one and rotate on the wrong number.
//
// Third, the monthly window is a real gate, not a curiosity: a plan that
// meters only a 30-day window has no weekly reading at all, so an account at
// 100% of its month must read as spent rather than as "no weekly, all clear".

import { proxyFetch } from './upstream-fetch.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Window durations we recognise, in minutes, with a tolerance for rounding. */
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;
// Anything from 28 days up is the monthly window. It is not a fixed length
// upstream (28-day and 30-day readings both occur), so a floor rather than a
// tolerance band.
const MONTH_MINUTES_MIN = 28 * 24 * 60;
const WINDOW_TOLERANCE = 0.1;

const near = (value, target) => Math.abs(value - target) <= target * WINDOW_TOLERANCE;

const HEADER_RE = /^x-codex-(?:(.+)-)?(primary|secondary)-(used-percent|window-minutes|reset-at)$/;
const LIMIT_NAME_RE = /^x-codex-(.+)-limit-name$/;

/**
 * Group `x-codex-*` headers into families keyed by slug ('' for the
 * account-wide family), each holding its primary/secondary window readings.
 */
function collectFamilies(headers) {
  const families = new Map();
  const family = (slug) => {
    if (!families.has(slug)) families.set(slug, { slug, name: null, windows: {} });
    return families.get(slug);
  };

  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = rawKey.toLowerCase();
    const value = String(rawValue ?? '').trim();
    if (value === '') continue;

    const named = LIMIT_NAME_RE.exec(key);
    if (named) { family(named[1]).name = value; continue; }

    const m = HEADER_RE.exec(key);
    if (!m) continue;
    const [, slug = '', position, field] = m;
    const w = (family(slug).windows[position] ??= {});
    if (field === 'used-percent') w.usedPercent = Number(value);
    else if (field === 'window-minutes') w.windowMinutes = Number(value);
    else w.resetAt = Number(value);
  }
  return families;
}

/** The bucket a window of `minutes` belongs to, or null when unrecognised. */
function bucketForMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (near(minutes, FIVE_HOUR_MINUTES)) return 'fiveHour';
  if (near(minutes, SEVEN_DAY_MINUTES)) return 'weekly';
  if (minutes >= MONTH_MINUTES_MIN) return 'monthly';
  return null;
}

/**
 * Turn one family's windows into `{ fiveHour, weekly, monthly }` readings,
 * keyed by the window's own duration rather than its primary/secondary
 * position.
 *
 * A window with no `window-minutes`, a zero duration, or an unparseable
 * utilization is dropped: a zeroed window is how this API says "not
 * applicable", and treating that as 0% used would look like full headroom.
 */
function classify(windows) {
  const out = {};
  for (const w of Object.values(windows)) {
    if (!w) continue;
    const bucket = bucketForMinutes(Number(w.windowMinutes));
    const percent = Number(w.usedPercent);
    if (!bucket || !Number.isFinite(percent)) continue;
    out[bucket] = {
      // Anthropic reports utilization as a 0-1 fraction and the rest of the
      // manager compares against `switchThreshold` in those units, so convert
      // here rather than teaching every consumer about percentages.
      utilization: percent / 100,
      // Epoch seconds upstream, milliseconds everywhere in this codebase.
      resetAt: Number.isFinite(w.resetAt) && w.resetAt > 0 ? w.resetAt * 1000 : null,
    };
  }
  return out;
}

/**
 * Assemble the quota object every consumer reads from an account-wide reading
 * plus the named families. Shared by the three parsers so they cannot drift:
 * a header response, a WebSocket event and a usage probe all land in the same
 * fields, and the account manager treats them alike.
 */
function assemble(accountWindows, namedFamilies) {
  const quota = {};
  const account = classify(accountWindows);
  if (account.fiveHour) {
    quota.unified5h = account.fiveHour.utilization;
    if (account.fiveHour.resetAt) quota.unified5hReset = account.fiveHour.resetAt;
  }
  if (account.weekly) {
    quota.unified7d = account.weekly.utilization;
    if (account.weekly.resetAt) quota.unified7dReset = account.weekly.resetAt;
  }
  if (account.monthly) {
    quota.unified30d = account.monthly.utilization;
    if (account.monthly.resetAt) quota.unified30dReset = account.monthly.resetAt;
  }

  // Model-scoped families. Their 5-hour window is not modelled separately —
  // the manager scopes eligibility by weekly family buckets — so only the
  // weekly reading is carried, alongside the name upstream gave it.
  for (const fam of namedFamilies) {
    if (!fam.slug) continue;
    const scoped = classify(fam.windows);
    if (!scoped.weekly) continue;
    (quota.modelBuckets ??= []).push({
      slug: fam.slug,
      name: fam.name || fam.slug,
      utilization: scoped.weekly.utilization,
      resetAt: scoped.weekly.resetAt,
    });
  }
  return quota;
}

/**
 * Parse Codex rate-limit headers into the fields `account.quota` already uses.
 *
 * Returns only what the headers actually stated, so a caller can assign over
 * an existing quota without blanking readings this response did not mention.
 * An empty object means "this response carried no quota", which is normal:
 * the catalog fetch (`/models`) has none.
 */
export function parseCodexQuota(headers) {
  const families = collectFamilies(headers);
  const named = [...families.values()].filter(f => f.slug);
  return assemble(families.get('')?.windows || {}, named);
}

/** The subscription plan upstream reports, for status output. Null when absent. */
export function parseCodexPlanType(headers) {
  const value = headers?.['x-codex-plan-type'];
  return value ? String(value).trim() || null : null;
}

// ── Family slugs ────────────────────────────────────────────────────────────

/**
 * The bucket slug for a named family from the usage payload, matching the
 * header spelling: `metered_feature: "codex_bengalfox"` is the family the
 * headers call `x-codex-bengalfox-*`. Without a metered feature the display
 * name is slugified, which is what the headers would have done too.
 */
export function familySlug({ meteredFeature, limitName }) {
  const feature = String(meteredFeature || '').trim().toLowerCase();
  if (feature) return feature.replace(/^codex_/, '');
  return String(limitName || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || null;
}

// ── WebSocket rate-limit event ──────────────────────────────────────────────

/** A JSON window (`used_percent`, `window_minutes`, `reset_at`) as the header
 * collector would have recorded it. */
function eventWindow(w) {
  if (!w || typeof w !== 'object') return null;
  return { usedPercent: Number(w.used_percent), windowMinutes: Number(w.window_minutes), resetAt: Number(w.reset_at) };
}

/**
 * Parse a `codex.rate_limits` event (the first frame of every WebSocket
 * response) into the same fields the header parser fills. Null when the
 * payload is not that event, so a relay can call it on every text frame.
 */
export function parseCodexRateLimitsEvent(event) {
  let payload = event;
  if (typeof event === 'string') {
    try { payload = JSON.parse(event); } catch { return null; }
  }
  if (!payload || typeof payload !== 'object' || payload.type !== 'codex.rate_limits') return null;

  const rl = payload.rate_limits || {};
  const account = { primary: eventWindow(rl.primary), secondary: eventWindow(rl.secondary) };
  const named = [];
  for (const [name, fam] of Object.entries(payload.additional_rate_limits || {})) {
    if (!fam || typeof fam !== 'object') continue;
    named.push({
      slug: familySlug({ meteredFeature: fam.metered_feature, limitName: name }),
      name,
      windows: { primary: eventWindow(fam.primary), secondary: eventWindow(fam.secondary) },
    });
  }
  const quota = assemble(account, named);
  const plan = typeof payload.plan_type === 'string' && payload.plan_type.trim();
  if (plan) quota.planType = plan;
  return quota;
}

// ── Usage endpoint ──────────────────────────────────────────────────────────

/** A usage-payload window (`used_percent`, `limit_window_seconds`, `reset_at`)
 * in the collector's minutes-based shape. A window with no stated duration is
 * the legacy weekly reading, which is what every plan reported before the
 * field existed. */
function usageWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const seconds = Number(w.limit_window_seconds);
  return {
    usedPercent: Number(w.used_percent),
    windowMinutes: Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : SEVEN_DAY_MINUTES,
    resetAt: Number(w.reset_at),
  };
}

/**
 * Map a `/backend-api/wham/usage` payload to the quota fields. Pure, so the
 * shape can be asserted from fixtures. Returns the same object the header
 * parser does, plus `planType` and `limitReached` (upstream's own verdict, kept
 * for logging — the buckets are what selection reads).
 */
export function parseCodexUsagePayload(data) {
  if (!data || typeof data !== 'object') return {};
  const rl = data.rate_limit || {};
  const account = {
    primary: usageWindow(rl.primary_window),
    secondary: usageWindow(rl.secondary_window),
    tertiary: usageWindow(rl.tertiary_window),
  };
  const named = [];
  for (const entry of Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []) {
    if (!entry || typeof entry !== 'object') continue;
    const fam = entry.rate_limit || {};
    named.push({
      slug: familySlug({ meteredFeature: entry.metered_feature, limitName: entry.limit_name }),
      name: entry.limit_name || null,
      windows: { primary: usageWindow(fam.primary_window), secondary: usageWindow(fam.secondary_window) },
    });
  }
  const quota = assemble(account, named);
  const plan = typeof data.plan_type === 'string' && data.plan_type.trim();
  if (plan) quota.planType = plan;
  if (typeof rl.limit_reached === 'boolean') quota.limitReached = rl.limit_reached;
  if (typeof data.rate_limit_reached_type === 'string') quota.reachedType = data.rate_limit_reached_type;
  return quota;
}

/**
 * Read a Codex account's quota from the zero-spend usage endpoint.
 *
 * Same contract as the Anthropic `fetchUsage`: the parsed quota on success,
 * `{ error, status }` otherwise, with `status: 401` distinguishable so the
 * prober can force one refresh and retry. Never throws.
 */
export async function fetchCodexUsage(accessToken, accountId, endpoint = USAGE_URL) {
  try {
    const headers = { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' };
    // The token alone names a person; this header names which of their
    // ChatGPT accounts the reading is for, exactly as on a Responses call.
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    const res = await proxyFetch(endpoint, { headers });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message || body?.detail || JSON.stringify(body).slice(0, 200);
      } catch {
        detail = await res.text().catch(() => '');
      }
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status };
    }
    return parseCodexUsagePayload(await res.json());
  } catch (err) {
    return { error: err.message || String(err), status: null };
  }
}

// ── Rejection classification ────────────────────────────────────────────────

// Body codes upstream uses for a spent quota. `usage_limit_reached` is the
// documented one; `usage_limit_exceeded` and `usage_not_included` were seen in
// the wild by other proxies and cost nothing to recognise.
const QUOTA_CODES = new Set(['usage_limit_reached', 'usage_limit_exceeded', 'usage_not_included', 'rate_limit_reached']);
// A 403 that names a workspace or entitlement problem: the account is fine,
// this model (or this workspace's policy) is not available to it.
const ENTITLEMENT_CODES = new Set(['codex_entitlement_missing', 'codex_workspace_access_denied', 'model_not_found', 'model_not_supported']);

/** The `code`/`type` string of an error body, looking one level into `error`.
 * Fails closed to null on anything that is not JSON or does not carry one. */
function errorCode(bodyText) {
  if (!bodyText) return null;
  let body;
  try { body = typeof bodyText === 'string' ? JSON.parse(bodyText) : bodyText; } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  const pick = (o) => (o && typeof o === 'object')
    ? [o.code, o.type].find(v => typeof v === 'string' && v) || null
    : null;
  return pick(body.error) || pick(body);
}

/**
 * Classify an upstream refusal from a Codex account.
 *
 *   - `quota`: a spent window. Durable, so the account is held for its reset
 *     and the request moves to another account. Signalled by the
 *     `x-codex-rate-limit-reached-type` header, a quota body code, or a 402
 *     (credits depleted).
 *   - `entitlement`: this account cannot serve this model or workspace at all.
 *     Scoped to the account for a cooldown; shared quota is untouched.
 *   - `rate-limit`: any other 429, the per-minute throttle. Pause and retry
 *     the same account, one failover hop at most, never a rotation.
 *   - `credential`: 401, the injected token was rejected.
 *   - `other`: not a refusal this function has an opinion on.
 *
 * `retryAfter` is the header value in seconds when present, so callers do
 * not parse it twice.
 */
export function classifyCodexRejection({ status, headers = {}, body = null } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
  const reachedType = h['x-codex-rate-limit-reached-type'] ? String(h['x-codex-rate-limit-reached-type']).trim() : null;
  const code = errorCode(body);
  const retryAfterRaw = parseInt(h['retry-after'], 10);
  const retryAfter = Number.isFinite(retryAfterRaw) ? retryAfterRaw : null;
  const base = { status, code, reachedType, retryAfter };

  if (status === 401) return { ...base, kind: 'credential' };
  if (status === 402) return { ...base, kind: 'quota' };
  if (status === 403) return { ...base, kind: ENTITLEMENT_CODES.has(code) ? 'entitlement' : 'other' };
  if (status === 400 && ENTITLEMENT_CODES.has(code)) return { ...base, kind: 'entitlement' };
  if (status === 429) {
    if (reachedType || QUOTA_CODES.has(code)) return { ...base, kind: 'quota' };
    return { ...base, kind: 'rate-limit' };
  }
  return { ...base, kind: 'other' };
}
