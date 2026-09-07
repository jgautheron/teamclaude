// The activity log tells a Codex row from a Claude row: a mark in the
// provider column, and the session id Codex printed rather than the proxy's
// `codex:` namespace, which a fixed-width slice used to show as the whole tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const acct = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });

function paint(tui, width) {
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
  return strip(buf).split('\r\n');
}

test('Codex rows carry a provider mark and the short id Codex printed; Claude rows neither', () => {
  const am = new AccountManager([acct('a@x.com'), acct('k@x.com', { provider: 'codex', accountId: 'acct-k' })], 0.98);
  const tui = new TUI({
    accountManager: am, config: { proxy: { port: 1 }, accounts: [], routes: [] }, sx: null,
    saveConfig: async () => {}, syncAccounts: async () => 0, onQuit: () => {}, probeQuota: () => {},
  });
  try {
    tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionId: '7476aeb1-0000-4000-8000-000000000000', model: 'claude-opus-5' });
    tui.onRequestRouted(1, { account: 'a@x.com' });
    tui.onRequestStart('ws-1', { method: 'WS', path: '/backend-api/codex/responses', sessionId: 'codex:01a06929-e126-78b2-873c-08efff8ce0ca', model: 'gpt-5.6-sol' });
    tui.onRequestRouted('ws-1', { account: 'k@x.com' });
    tui.onRequestEnd(1, { method: 'POST', path: '/v1/messages', account: 'a@x.com', status: 200, model: 'claude-opus-5', sessionId: '7476aeb1-0000-4000-8000-000000000000' });
    tui.onRequestEnd('ws-1', { method: 'WS', path: '/backend-api/codex/responses', account: 'k@x.com', status: 200, model: 'gpt-5.6-sol', sessionId: 'codex:01a06929-e126-78b2-873c-08efff8ce0ca' });
    tui.onRequestStart('ws-2', { method: 'WS', path: '/backend-api/codex/responses', sessionId: 'codex:01a06929-e126-78b2-873c-08efff8ce0ca', model: 'gpt-5.6-sol' });
    const lines = paint(tui, 160);
    const codexDone = lines.find(l => /WS \/backend-api\/codex\/responses .*\(200,/.test(l));
    const claudeDone = lines.find(l => /POST \/v1\/messages .*\(200,/.test(l));
    const codexActive = lines.find(l => /WS \/backend-api\/codex\/responses .*s\.\.\.\)/.test(l));
    assert.ok(codexDone && claudeDone && codexActive, lines.join('\n'));
    assert.match(codexDone, /◆ 01a069 WS/, 'the mark, then the id Codex printed');
    assert.match(codexActive, /◆ 01a069 WS/);
    assert.doesNotMatch(codexDone, /codex:/, 'the proxy namespace is not shown');
    assert.match(claudeDone, /  7476ae POST/, 'a Claude row has a blank mark column and its own short id');
    assert.doesNotMatch(claudeDone, /◆/);
  } finally {
    tui.running = false;
    if (tui.timer) clearTimeout(tui.timer);
  }
});
