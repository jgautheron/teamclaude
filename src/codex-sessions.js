// Resolve a Codex session name to its id, for `run --codex -- resume <name>`.
//
// Codex tags every session with the model provider it ran under and resolves
// `resume <name>`, `resume --last` and its picker only among sessions carrying
// the CURRENT provider's tag. Through the proxy the provider is `teamclaude`,
// so a session started with plain `codex` (tagged `openai`) is invisible to a
// name lookup, and vice versa — "No saved session found with ID <name>". The
// id path has no such filter, and Codex keeps a name → id index of its own
// (`$CODEX_HOME/session_index.jsonl`, one `{ id, thread_name, updated_at }`
// per line, appended on every rename). Reading that index and handing Codex
// the id gives the user back the name form; nothing about the session itself
// is provider-specific once the proxy is the one holding the credential.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultCodexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

/**
 * The id of the session most recently named `name` in Codex's index, or null
 * when the index is missing, unreadable, or names nothing by that name. Later
 * lines win: a session renamed twice appears twice, and the latest name is the
 * one Codex would show.
 */
export async function resolveCodexSessionName(name, { home = defaultCodexHome() } = {}) {
  let text;
  try {
    text = await readFile(join(home, 'session_index.jsonl'), 'utf8');
  } catch {
    return null;
  }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry && entry.thread_name === name && typeof entry.id === 'string') found = entry.id;
  }
  return found;
}

/**
 * Where a `resume <name>` sits in a codex argv: the index of the name for
 * `resume <name>` or `exec resume <name>`, or -1 when there is nothing to
 * translate (no resume, an id already, a flag, or a bare `resume`).
 */
export function resumeNameIndex(args) {
  const i = args.indexOf('resume');
  if (i < 0 || !(i === 0 || (i === 1 && args[0] === 'exec'))) return -1;
  const target = args[i + 1];
  if (typeof target !== 'string' || target.startsWith('-') || UUID_RE.test(target)) return -1;
  return i + 1;
}

/**
 * `args` with a `resume <name>` rewritten to `resume <id>` when the index
 * knows the name; untouched otherwise. Returns `{ args, resolved }` so the
 * caller can say what it did.
 */
export async function translateCodexResume(args, { home = defaultCodexHome(), resolve = resolveCodexSessionName } = {}) {
  const at = resumeNameIndex(args);
  if (at < 0) return { args, resolved: null };
  const id = await resolve(args[at], { home });
  if (!id) return { args, resolved: null };
  const out = args.slice();
  out[at] = id;
  return { args: out, resolved: { name: args[at], id } };
}
