# Accounts

Adding, naming, and managing the accounts TeamClaude rotates between.

## OAuth login (recommended)

```bash
teamclaude login
```

Opens your browser and uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

Run it once per account. You can add accounts while the server is running — press **R** in the TUI to reload.

If the profile cannot be identified, login stops without adding a placeholder
account. Retry after confirming the credential is valid, or pass
`teamclaude login --name <name>` to add it without profile detection.

## Import from Claude Code

If you already have Claude Code set up, import its credentials directly:

```bash
claude /login           # log into an account in Claude Code
teamclaude import       # import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
teamclaude import --from /path/to/credentials.json
```

Automatic naming requires a successful profile lookup. If credentials are
invalid or the profile cannot be identified, the import stops without adding a
placeholder account. Pass `--name <name>` to explicitly import without profile
detection.

## Delegating credentials to a file (`importFrom`)

Instead of storing an OAuth account's tokens in `teamclaude.json`, an account entry can name the file to read them from:

```json
{ "name": "me@example.com", "type": "oauth", "importFrom": "~/.claude/.credentials.json" }
```

The tokens (`accessToken`, `refreshToken`, `expiresAt`) are read from that file at startup and again on every config reload, so a login refreshed by Claude Code itself is picked up without re-running `teamclaude import`. Every other field on the entry (`priority`, `disabled`, `upstream`, `modelMap`, …) is kept as written. A file with no token skips the account with a message rather than sending an empty credential upstream. `teamclaude import` is the alternative: it copies the tokens into the config once.

## API key

For Anthropic API key accounts (billed via Console):

```bash
teamclaude login --api
```

## Multiple organizations

One email can hold multiple accounts across different organizations (e.g. corp + personal). Dedup is keyed on account + org, and names disambiguate as `email (Org)`.

Pass `--org <name|uuid>` to resolve a bare email when it is ambiguous:

```bash
teamclaude remove user@example.com --org Acme
```

## Managing accounts

```bash
teamclaude accounts             # list accounts with tier and token status
teamclaude accounts -v          # also show token expiry times
teamclaude remove <name>        # remove an account (by name or email)
teamclaude disable <name>       # temporarily exclude it from rotation
teamclaude enable <name>        # re-enable it (also clears a stuck error state)
teamclaude priority <name> 1    # rotation preference, lower = preferred
teamclaude priority <name> --first
teamclaude priority <name> --last
```

`login`, `import`, `enable`, `disable` and `priority` notify a running server to reload, so credential, priority and enable/disable changes are picked up live; the same reload (POST `/teamclaude/reload`, or **R** in the TUI) also applies hand edits to an account's `upstream`/`modelMap`. Account **removals** still need a restart.

Accounts can also be added and removed from the TUI settings screen: **`g`** → **Add account** / **Remove account**.

## The `id` field

Every account entry carries an `id`, added the first time the config is read and written back on the next save. It is what ties an entry to the running account built from it: entries without a usable credential are skipped at startup, so an entry's place in the file is not the account's place in the fleet, and a token refreshed for one account would otherwise be recorded against another.

Hand edits are fine. Leave the `id` alone and it keeps working; delete it and a new one is issued on the next read. If you copy an account block to make a second entry, the duplicated `id` is spotted on the next read and the later of the two gets a fresh one.

## Codex accounts (experimental)

An OpenAI Codex subscription can be pooled alongside your Claude accounts.

```bash
teamclaude login --codex     # browser sign-in, repeat per account
teamclaude import --codex    # or copy the Codex CLI's own login (--from <auth.json>)
```

Add `--no-browser` to print the URL instead of opening one, and `--name` to
label the account yourself (it defaults to the email on the login).

To pool a login you already have, or to add one without a browser, point an
account at the Codex CLI's own credentials file instead — it defaults to
`~/.codex/auth.json`:

```json
{ "name": "me@example.com", "type": "oauth", "provider": "codex" }
```

The Codex CLI honours `CODEX_HOME`, so several logins can be kept side by side
and pooled with `importFrom`:

```bash
CODEX_HOME=~/.codex-second codex login
```

```json
{ "name": "second", "type": "oauth", "provider": "codex",
  "importFrom": "~/.codex-second/auth.json" }
```

`import --codex` warns that an OpenAI refresh token is **single-use**: whichever
side refreshes first invalidates the other's copy, so a login copied from the
Codex CLI stops working for the CLI once TeamClaude refreshes it (and vice
versa). `login --codex` gives TeamClaude a login of its own. The `importFrom`
form below keeps the file as the shared source of truth: the server re-reads
it, and when the server itself refreshes the token it **writes the new pair
back** into that file (atomically, mode `0600`, `last_refresh` stamped as the
CLI does), so the Codex CLI keeps working and the next start reads a live
token. Sharing the file cuts both ways, so the server treats it as the newer
side: before spending its refresh token it re-reads the file and **adopts** a
pair the CLI has rotated or re-logged in the meantime (skipping the refresh
when that pair is still fresh; this is also how an entry whose refresh token
was rejected comes back after `codex login`, with no restart), and the write-back is **guarded**: if the file
holds another account, no token pair at all (an API-key login), or a refresh
token that is not the one just spent, or its bytes change between the check
and the final rename, the file is left alone and the server logs why. The
Codex CLI takes no lock on its file, so the swap cannot be made atomic
against it; the unguarded window is the single re-read → rename pair. If
`codex login` is a regular part of your day, `login --codex` gives TeamClaude
a login of its own and sidesteps the sharing entirely. `teamclaude accounts`
never refreshes a delegating Codex entry, since it does not write the file.

Then tell Codex to reach TeamClaude instead of OpenAI. `teamclaude run --codex`
does this per launch with `-c` overrides and needs nothing below; `teamclaude
env --codex` prints the same entry for `~/.codex/config.toml`:

```toml
model_provider = "teamclaude"

[model_providers.teamclaude]
name = "teamclaude"
base_url = "http://127.0.0.1:3456/backend-api/codex"
wire_api = "responses"
supports_websockets = true
```

`supports_websockets = true` keeps Codex on the WebSocket transport it uses
against OpenAI directly (a custom provider defaults to `false`); TeamClaude
relays it with the same rotation as a request — see [Codex over
WebSocket](proxy-modes.md#codex-over-websocket). Leave it out to have Codex
`POST` each response over SSE instead; both work.

`OPENAI_BASE_URL` does **not** work for this — a ChatGPT-authenticated Codex
ignores it. `model_providers` is the supported redirect.

The `/backend-api/codex` suffix matters. A Codex subscription authenticates
against the ChatGPT backend, not the OpenAI API platform — pointed at
`api.openai.com` the same token is refused with `Missing scopes:
api.responses.write`. Codex appends `/responses` and `/models` to `base_url`,
so this suffix makes it emit exactly the paths the ChatGPT backend expects and
TeamClaude forwards them verbatim.

### How it shares the port with Claude

One listener serves both CLIs, because the request path says which pool of
accounts is eligible: Claude Code posts to `/v1/messages`, Codex posts to
`/backend-api/codex/responses`. An Anthropic account is never offered a Codex
request and vice versa, so the two rotate independently on one port, one config
and one TUI.

The TUI draws the two pools as two panes — Claude on the left, Codex on the
right — so the list is as tall as the larger pool rather than both stacked,
and each pane marks its own current account with `►`. A pane drops the type
column (its title already says) and caps its bars a little narrower, so the
name column keeps whole addresses. On a terminal too narrow for two panes the
list is one column again, Claude first, with `codex` in the type column.

### What differs from a Claude account

A Codex account is identified by its **ChatGPT account id**, never by an
Anthropic account/org UUID, and never by name across providers: one person's
Claude and Codex logins share an email and so a display name, and the two
entries are still two accounts — saved quota is restored to each on its own,
`login --codex` never updates the Claude namesake, and a `TC_ACCT` pin by that
name resolves within the provider the request is for (a Codex path gets the
Codex account). Sonnet and Fable buckets are never restored onto or drawn for
a Codex row.


- The credential is injected as `Authorization: Bearer`, plus a
  `ChatGPT-Account-Id` header. That header is OpenAI's counterpart to the
  `account_uuid` TeamClaude patches into an Anthropic request body — so the
  Codex path performs no body rewrite at all.
- Tokens refresh against `auth.openai.com` using the Codex CLI's own client id.
- `teamclaude accounts` shows the plan and email the login carried, and the
  ChatGPT account id as the stable `TC_ACCT` pin identity; no profile is fetched.
- [Keep-warm](quota.md#keep-warm) spawns `codex exec` for a Codex account (with
  `codexWarmupModel` when set, else Codex's default model), pinned through the
  same provider override `run --codex` uses.
- The request body is forwarded untouched. This is a passthrough, not a
  translation layer: TeamClaude never converts between the Anthropic and OpenAI
  protocols.

### Quota

Codex reports its limits on every response, and TeamClaude normalises them into
the same fields the Anthropic path fills — so the switch threshold, reset
countdowns and the TUI's quota bars work for Codex accounts too, and rotation
happens *before* upstream refuses rather than after a 429. The
[quota probe](quota.md#quota-probe) reads Codex accounts from their own
zero-spend endpoint, and a spent window, a 402, or an entitlement 403 each take
the path described under [Codex refusals](routing.md#codex-refusals).

Three details are worth knowing if you read the raw headers:

- Limits arrive in families. The unnamed one is the account-wide limit; a family
  carrying `-limit-name` is model-scoped, the counterpart of Anthropic's Fable
  weekly bucket. Each family gets its own bar, threshold key and cap key
  (`codex:<slug>`) — see [Codex windows](quota.md#codex-windows).
- `primary` and `secondary` are positions, not durations — the account-wide
  family can put its 7-day window in `primary` while a model-scoped family puts
  a 5-hour window there. Windows are classified by their stated
  `window-minutes`, never by position.
- A plan that meters a 30-day window (Go, Free) is gated on it (`unified30d`),
  since such a plan reports no weekly window at all.

## Third-party backend accounts

Any Anthropic-compatible API can be added as an account alongside your Claude accounts. Give it a higher `priority` value (lower = preferred, so use e.g. `100`) and it will be used as a fallback when all Claude accounts are exhausted.

```json
{
  "name": "deepseek",
  "type": "oauth",
  "accessToken": "sk-your-deepseek-api-key",
  "upstream": "https://api.deepseek.com/anthropic",
  "priority": 100,
  "modelMap": {
    "claude-haiku-4-5-20251001": "deepseek-v4-flash",
    "claude-sonnet-4-6": "deepseek-v4-pro[1m]"
  }
}
```

- **`upstream`** — base URL of the target API. Requests are sent to `upstream + /v1/messages` (etc.) for this account only.
- **`modelMap`** — when a Claude model name arrives in the request body, it is rewritten to the mapped name before forwarding.

Reserve the backend for sessions that explicitly ask for its models with a [route](routing.md#model-routes):

```json
{ "name": "deepseek", "match": ["deepseek-*"], "accounts": ["deepseek"] }
```

Then pick the model at launch, or with `/model` inside a session:

```bash
# This session routes to DeepSeek; all other sessions still use Claude accounts.
claude --model 'deepseek-v4-pro[1m]'
```

Model names with brackets (e.g. `deepseek-v4-pro[1m]`) must be quoted in the shell.

### `accounts[].models` is deprecated

The older per-account `models` list still works, but use a [route](routing.md#model-routes) instead. Routes are more flexible (glob matching, multiple accounts, bucket override) and less surprising: a `models` list changes eligibility across the *whole fleet* — once any account claims a model, every account that doesn't claim it is skipped for that model. The server prints a deprecation notice at startup naming the route to replace it with, and the field may be removed in a future version.
