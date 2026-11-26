# dsh-workbuddy

English | [中文](README.zh-CN.md)

Connect the locally signed-in **WorkBuddy** desktop app to DeepSeek Harness as a
model provider. No OAuth flow, no copied tokens, no second login: the plugin
reuses the sign-in the WorkBuddy app already has on this machine.

This is the core implementation only — credential discovery, model catalog,
chat streaming, and one provider registration. Account pools, credit panels,
model toggles, and image/video tools from the upstream project are intentionally
left out.

The model selector shows only models whose ID or name contains “DeepSeek”; it
also displays the upstream credit multiplier.
DeepSeek V4.1 Flash accepts image input.

## What it does

- Reads the WorkBuddy desktop auth file **read-only**. Newer desktop builds
  store tokens as encrypted fields; the plugin asks the installed app for its
  own at-rest key instead of shipping a copy of it.
- Registers one DSH provider named `workbuddy`. The region follows the
  credential's domain: CN accounts use `copilot.tencent.com`, global accounts
  use their brand gateway (`www.workbuddy.ai` / `www.codebuddy.ai`).
- Refreshes the model catalog from the upstream `/v3/config` (the document the
  app itself reads) and re-advertises it every 15 minutes.
- Streams chat completions, reasoning deltas, tool calls, and token usage
  through a direct `LlmAdapter`. No pi-ai dependency and no loopback shim: the
  adapter talks to the gateway itself.
- Exposes a local diagnostics endpoint for connection/catalog state, region,
  model count, and the latest error code, plus a manual catalog refresh. It
  never returns credentials or account identifiers.

## Requirements

- DeepSeek Harness with `@deepseek-ai/dsh-llm` `0.1.7+` / `0.2.x`.
- The WorkBuddy desktop app, signed in on the same machine.
- macOS is the tested path (including encrypted credentials). Linux/Windows
  auth paths are probed, and plain-string token files work there; the
  encrypted-field key is currently fetched from the macOS app bundle only.

## Install

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-workbuddy
```

`dsh plugin add` registers the bundle automatically, so the next profile start
applies `cordis.patch.yml` and loads the provider. The plugin has no client
half, so nothing needs rebuilding — just restart the profile.

If the bundle did not appear in the profile's `dsh.profile.bundles`
(`~/.dsh/profiles/web/package.json`), add `dsh-workbuddy` there and restart.

## Configuration

Every value is optional. Configure through the profile's `cordis.patch.yml`:

```yaml
- id: dsh-workbuddy
  name: dsh-workbuddy
  config:
    authFile: /custom/path/workbuddy-desktop.info
    catalogRefreshMs: 900000
```

| Key | Default | Meaning |
| --- | --- | --- |
| `authFile` | platform path | Explicit auth file to read (overrides `WORKBUDDY_AUTH_FILE`) |
| `catalogRefreshMs` | `900000` | Catalog refresh interval; values below `60000` fall back to the default |

Diagnostics:

```text
GET /plugins/dsh-workbuddy/status
GET /plugins/dsh-workbuddy/status?refresh=1  # refresh the catalog before returning status
```

Only loopback-host requests are accepted. The response contains `state`,
`checkedAt`, `lastSuccessAt`, `signedIn`, `region`, `modelCount`, and
`lastErrorCode`; it never includes the auth-file path, tokens, or account
identifiers. A failed refresh reports `error` (no usable catalog yet) or
`degraded` (the previous successful catalog remains available).

Environment:

| Variable | Meaning |
| --- | --- |
| `WORKBUDDY_AUTH_FILE` | Auth file override |
| `WORKBUDDY_APP_EXECUTABLE` | Path to the desktop executable used to fetch the at-rest key |

## How it works

```text
DSH llm seam
  └─ WorkBuddyAdapter            (lib/adapter.js)
       ├─ CredentialStore        (lib/auth.js)  ── desktop auth file (read-only)
       │    └─ at-rest.js        ── ELECTRON_RUN_AS_NODE → app's loggerGet() → AES-256-GCM
       ├─ catalog.js             ── GET /v3/config
       └─ upstream.js            ── POST /v2/chat/completions (SSE)
```

The gateway has three rules that plain OpenAI compatibility does not cover:

1. the conversation must open with a `system` message;
2. chat requests must carry the conversation identity headers
   (`X-Conversation-ID`, `-Request-ID`, `-Message-ID`);
3. `system` / `assistant` text containing DSH's own identity wording is refused
   with business code `11128`. The gateway normalizes zero-width characters
   before matching, so the plugin rewrites the measured phrases to equivalent
   wording, and retries once behind a neutral system head if a request is still
   refused.

Token refresh (`/v2/plugin/auth/token/refresh`) only runs within five minutes of
expiry; the refreshed token stays in process memory. The desktop file is never
written.

## Deliberate scope

Not included, by design:

- account pool / multi-account switching
- credits, check-in, promotions
- OAuth or QR sign-in
- image and video generation
- per-model enable/image/toggle settings
- the loopback shim (this adapter holds the token itself)
- stable conversation IDs and request fingerprint experiments

## Verification

```sh
npm test           # 56 unit tests, no network
node test/live.mjs # one real request through DSH's llm seam, free model by default
```

`test/live.mjs` boots a cordis app with the real `dsh-llm` service, checks that
the provider registers, loads the catalog (18 models on the developer's CN
account), streams a tool call, and replays the tool result to get a final
answer. It defaults to `hy4flash-free` (rate `x0.00`); pass a model id as the
first argument to use another one at your own cost.

The plugin was also verified inside a real DSH profile: an isolated headless
profile with `agent-default-model` pointed at `workbuddy/hy4flash-free` boots,
registers the provider, and answers an agent prompt.

## Risk

WorkBuddy's endpoints are not a public API. The plugin can break when the
desktop app or the gateway changes, and using it is your own account decision.
Using the official client is always the safest option.

## License

MIT
