// Opt-in background quota probe.
//
// DISABLED BY DEFAULT. When enabled (config.quotaProbeSeconds > 0), periodically
// reads an OAuth account's quota zero-spend /api/oauth/usage endpoint so idle
// accounts' utilization/reset stay fresh without waiting to rotate onto them.
// A sanctioned active-upstream feature (the other is the opt-in keep-warm
// scheduler, warmer.js); the proxy is otherwise passive. Unlike keep-warm, this
// probe reads a zero-spend endpoint and never consumes message quota.

import { fetchUsage } from './oauth.js';
import { fetchCodexUsage } from './codex-quota.js';

export class Prober {
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, codexProbeFn = fetchCodexUsage, profileFn = null, timeoutMs = 10_000, log = console.log } = {}) {
    this.am = accountManager;
    this.intervalMs = intervalMs;
    this.probeFn = probeFn;
    // A Codex account reads its own zero-spend endpoint, which needs the
    // ChatGPT account id as well as the token.
    this.codexProbeFn = codexProbeFn;
    this.profileFn = profileFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.timer = null;
    this._running = false;
    this.lastRunStartedAt = null;
    this.lastRunFinishedAt = null;
    this.nextRunAt = intervalMs > 0 ? Date.now() + intervalMs : null;
    this.accountStatus = new Map();
  }

  start() {
    if (this.intervalMs > 0) this.reschedule(this.intervalMs);
  }

  /** Change interval at runtime (0 = off). Probes once immediately when on. */
  reschedule(intervalMs) {
    const wasOn = this.intervalMs > 0 && this.timer;
    this.intervalMs = intervalMs;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    if (intervalMs > 0) {
      this.nextRunAt = Date.now() + intervalMs;
      // Immediate probe only on an off→on transition — not on every interval
      // change (mirrors warmer.js; avoids an extra burst when the interval is edited).
      if (!wasOn) this.probeAll().catch(() => {});
      this.timer = setInterval(() => this.probeAll().catch(() => {}), intervalMs);
      this.timer.unref?.();
      this.log(`[TeamClaude] Quota probe enabled (every ${Math.round(intervalMs / 1000)}s)`);
    } else if (wasOn) {
      this.nextRunAt = null;
      this.log('[TeamClaude] Quota probe disabled');
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.nextRunAt = null;
  }

  /** Probe every OAuth account once. Overlapping cycles are skipped. */
  async probeAll() {
    if (this._running) return;
    this._running = true;
    this.lastRunStartedAt = Date.now();
    this.nextRunAt = this.intervalMs > 0 ? this.lastRunStartedAt + this.intervalMs : null;
    try {
      const accounts = this.am.accounts.filter(account => account.type === 'oauth' && account.credential);
      await Promise.all(accounts.map(account => this.probeAccount(account)));
    } finally {
      this.lastRunFinishedAt = Date.now();
      this._running = false;
    }
  }

  async probeAccount(account) {
    const startedAt = Date.now();
    this._recordAccount(account, { status: 'running', startedAt });
    try {
      const isCodex = account.provider === 'codex';
      const probe = () => isCodex
        ? this.codexProbeFn(account.credential, account.accountId)
        : this.probeFn(account.credential);
      await this.am.ensureTokenFresh(account.index);
      let usage = await this._withTimeout(probe());
      if (usage?.status === 401) {
        // Token rejected: force refresh and retry once.
        await this.am.ensureTokenFresh(account.index, true);
        usage = await this._withTimeout(probe());
      }

      if (!usage || usage.error) {
        const finishedAt = Date.now();
        this._recordAccount(account, {
          status: usage?.error ? 'error' : 'timeout',
          error: usage?.error || 'probe timed out',
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt,
        });
        return;
      }

      if (isCodex) this.am.applyCodexUsageData(account.index, usage);
      else this.am.applyUsageData(account.index, usage);
      // The profile endpoint is Anthropic's; a Codex reading already names its plan.
      const missingTier = !isCodex && !account.rateLimitTier && !account.seatTier
        && account.hasClaudeMax == null && account.hasClaudePro == null;
      if (missingTier && this.profileFn) {
        const profile = await this._withTimeout(this.profileFn(account.credential));
        this.am.applyProfileData(account.index, profile);
      }
      const finishedAt = Date.now();
      this._recordAccount(account, {
        status: 'ok',
        error: null,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    } catch (err) {
      const finishedAt = Date.now();
      this._recordAccount(account, {
        status: 'error',
        error: err?.message || String(err),
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      });
    }
  }

  getStatus() {
    return {
      enabled: this.intervalMs > 0,
      intervalSeconds: Math.round(this.intervalMs / 1000),
      running: this._running,
      lastRunStartedAt: iso(this.lastRunStartedAt),
      lastRunFinishedAt: iso(this.lastRunFinishedAt),
      nextRunAt: iso(this.nextRunAt),
      accounts: this.am.accounts.map(account => {
        const status = this.accountStatus.get(account.name);
        return {
          name: account.name,
          status: account.type === 'oauth' ? (status?.status || 'never') : 'not-applicable',
          lastProbedAt: iso(status?.finishedAt),
          startedAt: iso(status?.startedAt),
          durationMs: status?.durationMs ?? null,
          error: status?.error || null,
        };
      }),
    };
  }

  _recordAccount(account, status) {
    this.accountStatus.set(account.name, {
      ...(this.accountStatus.get(account.name) || {}),
      ...status,
    });
  }

  _withTimeout(promise) {
    return Promise.race([
      promise,
      new Promise(resolve => {
        const t = setTimeout(() => resolve(null), this.timeoutMs);
        t.unref?.();
      }),
    ]);
  }
}

function iso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}
