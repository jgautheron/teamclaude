// A fleet with both providers is drawn as two panes, Claude left and Codex
// right, so the list is as tall as the larger pool rather than both stacked.
// The pane titles take the spacer line the list always had. Too narrow for two
// panes, and it is one column again, Claude rows first, the provider column
// naming each row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';
import { RemoteAccountManager } from '../src/tui-remote.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const h = 3600_000;

const claude = (name, extra = {}) => ({ name, type: 'oauth', accessToken: `t-${name}`, refreshToken: 'r', expiresAt: Date.now() + h, ...extra });
const codex = (name) => ({ name, type: 'oauth', provider: 'codex', accountId: `acct-${name}`, accessToken: `c-${name}`, refreshToken: 'r', expiresAt: Date.now() + h });

/** A manager whose accounts all carry readings: Claude rows a Fable bucket too. */
function fleet(accounts, opts = {}) {
  const am = new AccountManager(accounts, 0.98, opts);
  am.accounts.forEach((a, i) => {
    a.quota.unified5h = 0.2;
    a.quota.unified5hReset = Date.now() + 3 * h;
    a.quota.unified7d = 0.3 + i / 20;
    a.quota.unified7dReset = Date.now() + (i + 1) * 24 * h;
    if (a.provider !== 'codex') {
      a.quota.unified7dFable = 0.4;
      a.quota.unified7dFableReset = Date.now() + 2 * 24 * h;
    }
  });
  return am;
}

/**
 * Render the dashboard at `width`. Returns the frame's lines (ANSI stripped)
 * and every row _renderRow produced, BEFORE fitLine pads or cuts it: the frame
 * is always exactly `width` wide, so only the raw rows can show an overrun.
 */
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
  const drawn = [];
  try {
    const real = tui._renderRow.bind(tui);
    tui._renderRow = (idx, L) => {
      const out = real(idx, L);
      drawn.push({ idx, compact: L.compact, text: strip(out) });
      return out;
    };
    tui._paint = (b) => { buf = b; };
    tui.running = true;
    tui.render(true);
  } finally {
    if (cols) Object.defineProperty(process.stdout, 'columns', cols);
    if (rows) Object.defineProperty(process.stdout, 'rows', rows);
  }
  const lines = strip(buf).replace(/^\x1b\[H/, '').split('\r\n').map(l => l.replace(/\x1b\[\?25[hl]$/, ''));
  return { lines, drawn, tui };
}

/** The account list: from the spacer (or title) line down to the Activity header. */
const listLines = (lines) => lines.slice(2, lines.findIndex(l => /^ Activity/.test(l)));
const accountRows = (lines) => listLines(lines).slice(1).filter(l => l.trim());
const halves = (row) => row.split(' │ ');
// The name the current-account ► sits in front of. Matched against the name, not
// the glyph alone: a Claude row also draws ► before the F7 bar of the account
// the Fable route targets.
const currentNames = (rows) => rows.map(r => r.match(/►\s+(\S+@\S+)/)?.[1]).filter(Boolean);

test('a mixed fleet at a wide terminal is two panes, as tall as the larger pool', () => {
  const am = fleet([claude('a@x.com'), claude('b@x.com'), claude('c@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  const { lines } = screen(am, 160);
  const list = listLines(lines);
  assert.match(list[0], /^ Claude ─+ │  Codex ─+\s*$/, list[0]);
  const rows = accountRows(lines);
  assert.equal(rows.length, 3, 'three rows: the larger pool');
  const [left, right] = halves(rows[0]);
  assert.match(left, /a@x\.com/);
  assert.match(right, /k1@x\.com/);
  assert.match(left, /Ses .*Wk .*F7/, 'the Claude pane keeps its family bar');
  assert.match(right, /Ses .*Wk /);
  assert.doesNotMatch(right, /F7/);
  assert.doesNotMatch(rows[0], /oauth|Anthropic|Codex /, 'a pane draws no type column');
  // The third row has no Codex account; the gutter stays aligned.
  assert.match(rows[2], /c@x\.com/);
  assert.equal(halves(rows[2])[1].trim(), '');
});

test('the split costs no height: the titles sit in the spacer line', () => {
  const activityAt = ({ lines }) => lines.findIndex(l => /^ Activity/.test(l));
  assert.equal(
    activityAt(screen(fleet([claude('a@x.com'), codex('k1@x.com')]), 160)),
    activityAt(screen(fleet([claude('a@x.com')]), 160)),
  );
});

test('each pane marks the account its own provider cursor names', () => {
  const am = fleet([claude('a@x.com'), claude('b@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  // An operator switch on each side. The single currentIndex ends on the Codex
  // account, which used to leave the Claude pane without a marker at all.
  am.setCurrentAccount(1);
  am.setCurrentAccount(3);
  const rows = accountRows(screen(am, 160).lines);
  assert.deepEqual(currentNames(rows.map(r => halves(r)[0])), ['b@x.com']);
  assert.deepEqual(currentNames(rows.map(r => halves(r)[1] || '')), ['k2@x.com']);
});

test('a narrow terminal keeps one column: Claude rows first, each named by provider', () => {
  const am = fleet([codex('k1@x.com'), claude('a@x.com'), claude('b@x.com')]);
  const { lines } = screen(am, 100);
  assert.equal(listLines(lines)[0].trim(), '', 'no pane titles');
  const rows = accountRows(lines);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /a@x\.com\s+Anthropic/);
  assert.match(rows[1], /b@x\.com\s+Anthropic/);
  assert.match(rows[2], /k1@x\.com\s+Codex/);
  assert.ok(!rows.some(r => r.includes('│')));
  assert.equal(currentNames(rows).length, 2, 'both pools mark their current account');
});

test('a single-provider fleet is unchanged: one column, no titles, one marker', () => {
  for (const accounts of [[claude('a@x.com'), claude('b@x.com')], [codex('k1@x.com'), codex('k2@x.com')]]) {
    const { lines } = screen(fleet(accounts), 160);
    assert.equal(listLines(lines)[0].trim(), '');
    const rows = accountRows(lines);
    assert.ok(!rows.some(r => r.includes('│')));
    assert.equal(rows.length, 2);
    assert.match(rows[0], /oauth/, 'the type column keeps the auth kind');
    assert.equal(currentNames(rows).length, 1);
  }
});

test('no row outgrows its pane or the terminal, across widths', () => {
  const routes = [{ name: 'fast', match: ['claude-*'], accounts: ['a-long-name@example.com', 'b@x.com'] }];
  const am = fleet([
    claude('a-long-name@example.com'), claude('b@x.com'),
    codex('k1-long-name@example.com'), codex('k2@x.com'),
  ], { routes });
  // A blocked family and a spend tag widen the reservations on the Claude side.
  am.accounts[1].quota.unified7dFable = 0.995;
  am.accounts[0].quota.spend = { enabled: true, usedMinor: 0 };
  let split = 0;
  for (let w = 60; w <= 240; w += 7) {
    const { drawn } = screen(am, w);
    const paneW = Math.floor((w - 3) / 2);
    for (const row of drawn) {
      const limit = row.compact ? paneW : w;
      assert.ok(row.text.length <= limit, `W=${w} ${row.compact ? 'pane' : 'list'} row is ${row.text.length} > ${limit}: ${row.text}`);
    }
    if (drawn.some(r => r.compact)) split++;
  }
  assert.ok(split > 0, 'the sweep reached widths that split');
});

test('a Codex pane whose plans meter no short window drops the Ses column; Wk takes the first slot', () => {
  const am = fleet([claude('a@x.com'), codex('k1@x.com'), codex('k2@x.com')]);
  for (const i of [1, 2]) { am.accounts[i].quota.unified5h = null; am.accounts[i].quota.unified5hReset = null; }
  const [left, right] = halves(accountRows(screen(am, 160).lines)[0]);
  assert.match(left, /Ses .*Wk .*F7/, 'the Claude pane is unchanged');
  assert.doesNotMatch(right, /Ses/, 'no short-window bar in the Codex pane');
  assert.match(right, /k1@x\.com\s+active\s+Wk /, 'weekly takes the first slot');
  // One account reporting a 5h window brings the column back for the pane.
  am.accounts[2].quota.unified5h = 0.1;
  am.accounts[2].quota.unified5hReset = Date.now() + h;
  assert.match(halves(accountRows(screen(am, 160).lines)[0])[1], /Ses .*Wk /);
});

test('without a short window, a Codex-only list drops Ses and a mixed single column keeps it', () => {
  const only = fleet([codex('k1@x.com'), codex('k2@x.com')]);
  for (const a of only.accounts) a.quota.unified5h = null;
  const rows = accountRows(screen(only, 120).lines);
  assert.equal(rows.length, 2);
  for (const r of rows) { assert.doesNotMatch(r, /Ses/); assert.match(r, /Wk /); }
  // Too narrow to split: the Claude rows in the shared column need their Ses bar.
  const mixed = fleet([claude('a@x.com'), codex('k1@x.com')]);
  mixed.accounts[1].quota.unified5h = null;
  const narrow = accountRows(screen(mixed, 100).lines);
  assert.equal(narrow.length, 2);
  for (const r of narrow) assert.match(r, /Ses /);
});

test('selection walks the Claude pane, then the Codex pane, and stores manager indices', () => {
  const am = fleet([codex('k1@x.com'), claude('a@x.com'), codex('k2@x.com'), claude('b@x.com')]);
  const { tui } = screen(am, 160);
  assert.deepEqual(tui._displayOrder(), [1, 3, 0, 2]);
  tui.render = () => {};
  tui.mode = 'select';
  tui.selAction = 'toggle';
  tui.selIdx = 1;
  const seen = [tui.selIdx];
  for (let i = 0; i < 3; i++) { tui._keySelect('down'); seen.push(tui.selIdx); }
  assert.deepEqual(seen, [1, 3, 0, 2]);
});

test('attach mode marks each pool from the per-provider cursor the server sends', () => {
  const rm = new RemoteAccountManager();
  const status = {
    // The same address on both sides: the match has to be by provider too.
    accounts: [
      { name: 'me@x.com', type: 'oauth', provider: 'anthropic', quota: {} },
      { name: 'other@x.com', type: 'oauth', provider: 'anthropic', quota: {} },
      { name: 'me@x.com', type: 'oauth', provider: 'codex', quota: {} },
    ],
    currentAccount: 'other@x.com',
    currentAccounts: { anthropic: 'other@x.com', codex: 'me@x.com' },
  };
  rm.applyStatus(status);
  assert.equal(rm.currentIndexFor('anthropic'), 1);
  assert.equal(rm.currentIndexFor('codex'), 2);

  // A server too old to send currentAccounts has one cursor, for its own pool only.
  rm.applyStatus({ ...status, currentAccounts: undefined });
  assert.equal(rm.currentIndexFor('anthropic'), 1);
  assert.equal(rm.currentIndexFor('codex'), null);
});
