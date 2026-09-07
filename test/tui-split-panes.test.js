// A fleet with both providers is drawn as two panes — Claude left, Codex
// right — so the list is as tall as the larger pool, not both stacked. The
// pane titles take the spacer line the list always had. Too narrow for two
// panes, and it is one column again, Claude first, the type column naming the
// provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, holdTag } from '../src/tui.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const h = 3600_000;

const claude = (name) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + h });
const codex = (name) => ({ name, type: 'oauth', provider: 'codex', accountId: 'acct-' + name, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + h });

function fleet(accounts) {
  const am = new AccountManager(accounts, 0.98);
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.2;
    a.quota.unified5hReset = Date.now() + 3 * h;
    a.quota.unified7d = 0.3 + i / 20;
    a.quota.unified7dReset = Date.now() + (i + 1) * 24 * h;
    if (a.provider === 'codex') {
      a.quota.codexModelBuckets = { bengalfox: { name: 'GPT-5.3-Codex-Spark', utilization: 0.1, resetAt: Date.now() + 5 * 24 * h, seenAt: Date.now() } };
    } else {
      a.quota.unified7dFable = 0.4;
      a.quota.unified7dFableReset = Date.now() + 2 * 24 * h;
    }
  });
  return am;
}

/** Render the dashboard at `width`, returning the screen's lines, ANSI stripped. */
function screen(am, width) {
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: width, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
  let buf = '';
  try {
    tui._paint = (b) => { buf = b; };
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  return strip(buf).replace(/^\x1b\[H/, '').split('\r\n').map(l => l.replace(/\x1b\[\?25[hl]$/, ''));
}

const listLines = (lines) => lines.slice(2, lines.findIndex(l => /^ Activity/.test(l)));

test('a mixed fleet at a wide terminal is two panes, as tall as the larger pool', () => {
  const am = fleet([claude('a@x.com'), claude('b@x.com'), claude('c@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  const lines = screen(am, 160);
  const list = listLines(lines);
  assert.match(list[0], /^ Claude ─+ │  Codex ─+\s*$/, list[0]);
  const rows = list.slice(1).filter(l => l.trim());
  assert.equal(rows.length, 3, 'three rows: the larger pool');
  for (const l of lines) assert.ok(l.length <= 160, `overflow: ${l.length}`);
  // Row by row: Claude on the left of the gutter, Codex on the right.
  const [left, right] = [rows[0].split(' │ ')[0], rows[0].split(' │ ')[1]];
  assert.match(left, /a@x\.com/);
  assert.match(right, /k1@x\.com/);
  assert.match(left, /Ses .*Wk .*F7/, 'Claude pane keeps its family bar');
  assert.match(right, /Ses .*Wk .*Sp7/, 'Codex pane draws its own family bar');
  assert.doesNotMatch(left, /Sp7/);
  assert.doesNotMatch(right, /F7/);
  assert.doesNotMatch(rows[0], /oauth/, 'the type column is dropped in a pane');
  // The third row has no Codex account; the pane stays aligned.
  assert.match(rows[2], /c@x\.com/);
  assert.equal(rows[2].split(' │ ')[1].trim(), '');
  // Each pane marks its own current account.
  const curLeft = rows.filter(r => r.split(' │ ')[0].includes('►'));
  const curRight = rows.filter(r => (r.split(' │ ')[1] || '').includes('►'));
  assert.equal(curLeft.length, 1);
  assert.equal(curRight.length, 1);
});

test('the split costs no height: the titles sit in the spacer line', () => {
  const am = fleet([claude('a@x.com'), codex('k1@x.com')]);
  const mixed = screen(am, 160);
  const only = screen(fleet([claude('a@x.com')]), 160);
  assert.equal(mixed.findIndex(l => /^ Activity/.test(l)), only.findIndex(l => /^ Activity/.test(l)));
});

test('a narrow terminal keeps one column: Claude first, then Codex, typed by provider', () => {
  const am = fleet([codex('k1@x.com'), claude('a@x.com'), claude('b@x.com')]);
  const list = listLines(screen(am, 80));
  assert.equal(list[0].trim(), '', 'no pane titles');
  const rows = list.slice(1).filter(l => l.trim());
  assert.equal(rows.length, 3);
  assert.match(rows[0], /a@x\.com\s+oauth/);
  assert.match(rows[1], /b@x\.com\s+oauth/);
  assert.match(rows[2], /k1@x\.com\s+codex/);
  assert.ok(!rows.some(r => r.includes('│')));
  assert.equal(rows.filter(r => r.includes('►')).length, 2, 'both pools mark their current account');
});

test('a single-provider fleet is unchanged: one column, no titles', () => {
  for (const accounts of [[claude('a@x.com'), claude('b@x.com')], [codex('k1@x.com'), codex('k2@x.com')]]) {
    const list = listLines(screen(fleet(accounts), 160));
    assert.equal(list[0].trim(), '');
    assert.ok(!list.some(r => r.includes('│')));
    assert.equal(list.slice(1).filter(l => l.trim()).length, 2);
  }
});

test('the split never overflows the terminal across widths', () => {
  const am = fleet([claude('a-long-name@example.com'), claude('b@x.com'), codex('k1-long-name@example.com'), codex('k2@x.com')]);
  for (const w of [70, 90, 100, 110, 120, 140, 160, 200]) {
    for (const l of screen(am, w)) assert.ok(l.length <= w, `W=${w}: ${l.length} columns`);
  }
});

test('a Codex row never draws or bars the Claude families, even from a stale state file', () => {
  // Same display name on both sides (one person's two logins), and a Fable
  // bucket left on the Codex row by a state file written before identities
  // were provider-scoped.
  const am = fleet([claude('me@x.com'), codex('me@x.com')]);
  am.accounts[1].quota.unified7dFable = 0.99;
  am.accounts[1].quota.unified7dFableReset = Date.now() + 2 * h;
  am.accounts[1].quota.unified7d = 0.99;
  const rows = listLines(screen(am, 180)).slice(1).filter(l => l.trim());
  const [left, right] = rows[0].split(' │ ');
  assert.match(left, /F7/, 'the Claude row keeps its Fable bar');
  assert.doesNotMatch(right, /F7/, 'no Fable bar on the Codex row');
  assert.match(right, /⊘ GPT-5\.3-Codex-Spark/, 'the spent weekly bars the Codex family');
  assert.doesNotMatch(right, /Fable/, 'and never a Claude family');
});

test('a throttled or paused account shows when it is tried again', () => {
  const now = 1_000_000_000_000;
  assert.equal(holdTag({ status: 'throttled', rateLimitedUntil: now + 12 * 60_000 }, now), '↻ 12m');
  assert.equal(holdTag({ status: 'throttled', rateLimitedUntil: new Date(now + 90 * 60_000).toISOString() }, now), '↻ 1h30m', 'status payloads carry ISO strings');
  assert.equal(holdTag({ status: 'active', pausedUntil: now + 45_000 }, now), '↻ 1m');
  assert.equal(holdTag({ status: 'throttled', rateLimitedUntil: now - 1 }, now), '', 'a hold that has passed says nothing');
  assert.equal(holdTag({ status: 'active', rateLimitedUntil: now + 60_000 }, now), '', 'a stale timestamp on an active account is not a hold');
  assert.equal(holdTag({ status: 'active' }, now), '');
});

test('the hold countdown is drawn on the row and budgeted in the layout', () => {
  const am = fleet([claude('a@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  am.markRateLimited(2, 12 * 60);
  for (const width of [180, 120]) {
    const lines = screen(am, width);
    const rows = listLines(lines).slice(1).filter(l => l.trim());
    const k2 = rows.find(l => /k2@x\.com/.test(l));
    assert.match(k2, /throttled.*↻ 12m/, `the throttled row carries the countdown at ${width}`);
    assert.doesNotMatch(rows.find(l => /k1@x\.com/.test(l)), /↻/);
    for (const l of lines) assert.ok(l.length <= width, `overflow at ${width}: ${l.length}`);
  }
});
