// `run --codex -- resume <name>`: Codex resolves a name only among sessions
// tagged with the current provider, so the launcher hands it the id instead,
// read from Codex's own session_index.jsonl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexSessionName, resumeNameIndex, translateCodexResume } from '../src/codex-sessions.js';

const ID = '01a06929-e126-78b2-873c-08efff8ce0ca';
const INDEX = [
  { id: ID, thread_name: 'implement proper support for stacks', updated_at: '2026-09-03T21:29:07Z' },
  { id: 'ffffffff-0000-4000-8000-000000000000', thread_name: 'stacks', updated_at: '2026-09-03T21:30:00Z' },
  { id: ID, thread_name: 'stacks', updated_at: '2026-09-03T21:55:40Z' },
].map(e => JSON.stringify(e)).join('\n') + '\nnot json\n';

test('resolveCodexSessionName takes the latest index line naming the session, and null otherwise', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tc-codex-home-'));
  try {
    await writeFile(join(home, 'session_index.jsonl'), INDEX);
    assert.equal(await resolveCodexSessionName('stacks', { home }), ID, 'the later rename wins');
    assert.equal(await resolveCodexSessionName('implement proper support for stacks', { home }), ID);
    assert.equal(await resolveCodexSessionName('nothing', { home }), null);
    assert.equal(await resolveCodexSessionName('stacks', { home: join(home, 'missing') }), null, 'no index, no answer');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('resumeNameIndex only points at a name in resume / exec resume position', () => {
  assert.equal(resumeNameIndex(['resume', 'stacks']), 1);
  assert.equal(resumeNameIndex(['exec', 'resume', 'stacks', 'go on']), 2);
  assert.equal(resumeNameIndex(['resume', ID]), -1, 'an id is left to Codex');
  assert.equal(resumeNameIndex(['resume', '--last']), -1);
  assert.equal(resumeNameIndex(['resume']), -1);
  assert.equal(resumeNameIndex(['exec', 'resume stacks']), -1);
  assert.equal(resumeNameIndex(['--model', 'x', 'resume', 'stacks']), -1, 'not the subcommand position');
});

test('translateCodexResume swaps the name for the id and reports it; unknown names pass through', async () => {
  const resolve = async (name) => (name === 'stacks' ? ID : null);
  assert.deepEqual(await translateCodexResume(['resume', 'stacks'], { resolve }), { args: ['resume', ID], resolved: { name: 'stacks', id: ID } });
  assert.deepEqual(await translateCodexResume(['exec', 'resume', 'stacks', 'continue'], { resolve }), { args: ['exec', 'resume', ID, 'continue'], resolved: { name: 'stacks', id: ID } });
  const same = ['resume', 'unknown'];
  assert.deepEqual(await translateCodexResume(same, { resolve }), { args: same, resolved: null });
  assert.deepEqual(await translateCodexResume(['exec', 'hi'], { resolve }), { args: ['exec', 'hi'], resolved: null });
});
