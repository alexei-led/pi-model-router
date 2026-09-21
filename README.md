# pi-model-router

[![CI](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![npm downloads](https://img.shields.io/npm/dm/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![Latest release](https://img.shields.io/github/v/release/alexei-led/pi-model-router?display_name=tag&sort=semver)](https://github.com/alexei-led/pi-model-router/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](package.json)

Per-turn model router for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Selects high, medium, low or micro-tier models using optional semantic advice, a configured baseline and a soft budget policy, while keeping the selected `router/<profile>` model stable.

> **Independent fork:** This project is an independently maintained fork of [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router), originally created by Ye Liu. It is not an official upstream release. The original MIT license and copyright notice are preserved.

## Fork status

This fork is maintained at [alexei-led/pi-model-router](https://github.com/alexei-led/pi-model-router). It publishes independent releases as `@alexeiled/pi-model-router` and accepts fixes for current Pi versions and provider integrations. See [CHANGELOG.md](CHANGELOG.md) for fork-specific changes.

## What it does

- **Logical Router Provider**: Registers a `router` provider that exposes stable profiles (e.g., `router/balanced`) as models.
- **Four Configured Tiers**: `high`, `medium`, `low`, and `micro` describe model/effort choices, not tool permissions or security levels.
- **Deterministic Baseline**: Without advice, select an eligible configured baseline regardless of prompt words, language, punctuation or length. No keyword routing or phase inference.
- **Advanced Controls**:
  - **Jev Advisor**: Optionally select a validated primary model/thinking pair within the active profile using bounded recent conversation text.
  - **LLM Intent Classifier**: Optional Pi-based semantic tier advice when Jev is not active. Jev failure goes directly to baseline, never to a second advisor.
  - **Cost Budgeting**: Prefer eligible medium-or-lower tiers above a soft generation-cost threshold; explicit pins take precedence.
  - **Fallback Chains**: Retry only explicit configured alternatives, before visible content.
- **Stable Tool Continuations**: Reuse a validated per-turn route without asking advisors again.
- **Thinking Control**: Full control over reasoning/thinking levels per tier and profile. Changing pi's thinking level (e.g. via `shift+tab`) automatically applies as an all-tier override for the active router profile. Overrides that leave no eligible route are rejected atomically (including Pi's selection); otherwise unsupported tiers are skipped.
- **Persistent State**: Pins, costs, and debug history are remembered across agent restarts and conversation branches. When Pi starts on the router provider, new sessions use the last selected router profile if it is still configured. An explicit `--model` selection takes precedence.

## Installation

### Requirements

- Pi `0.86.0` or newer.
- Node.js `22.19.0` or newer.

Install from npm:

```bash
pi install npm:@alexeiled/pi-model-router
```

### Migrating from the upstream package

Do not load both packages at the same time: both register the `router` provider. Replace the upstream package with this package and keep your existing `model-router.json` configuration:

```bash
pi remove npm:@yeliu84/pi-model-router
pi install npm:@alexeiled/pi-model-router
```

If the upstream package was installed through another manifest, remove that entry there instead. Existing profiles and router commands remain supported. Legacy `rules` and `phaseBias` still load but have no routing effect; see the migration notes below.

### For development

Use Node.js 22.19+ and npm. Install and validate with:

```bash
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` runs Biome lint, formatting, import-order and async-safety checks, then
TypeScript 7 with strict indexing, optional-property and unused-code checks. Warnings fail
the check. CI and releases use the same gate.

- `npm run format` formats TypeScript and root JSON files.
- `npm run lint` checks lint rules; `npm run lint:fix` applies safe lint fixes.
- `npx biome check --write .` also fixes formatting and import order.
- `npm run tsc` runs only the type checker.
- `npm test` uses Vitest worker threads; this keeps the small suite fast without weakening assertions.

[Biome](https://biomejs.dev/) replaces Prettier and supplies linting in one pinned
direct tooling dependency, without ESLint or formatter plugins. Type checking stays with
TypeScript 7. Markdown and YAML are not formatted by this setup; validate
workflow YAML with `actionlint .github/workflows/*.yml`. The generated lockfile
is excluded from formatting.

Install from source:

```bash
pi install .
```

Or load directly for one run:

```bash
pi -e ./extensions/index.ts
```

## Reliability

- Generation and classification use Pi's provider registry, including native/custom providers and credential-specific URLs. Only the optional Jev advisor uses separate HTTPS transport.
- Fallbacks run only before content is emitted; cancellation does not retry. Every target must support the requested input and exact thinking level; explicit unsupported effort is not silently reduced. Omitted thinking defaults to `off` for non-reasoning targets, including fallbacks.
- Jev gets a configurable total advisory budget via `jev.timeoutMs`: 1500 ms by default, with no additional routing cap or retry. The separate classifier-only compatibility path retains its 10-second bound and 256-token output limit. Failure or uncertainty means eligible baseline; caller cancellation stops generation.
- Valid same-turn tool continuations reuse the actual prior route before either advisor. Pins, budget policy and a single eligible primary candidate also bypass advisors. Invalid continuations choose a compatible local route without advice; incompatible Google thought-signature replay fails plainly.
- Pi owns tool execution permissions and per-request authentication. The router checks configured provider/profile identity, not which backend login is currently behind a provider. No private authentication storage is read.
- Context trimming preserves system instructions and whole active tool turns. It is a text estimate, not a guarantee that images or a large active turn fit.

See [architecture](https://github.com/alexei-led/pi-model-router/blob/main/docs/ARCHITECTURE.md) and [release procedure](https://github.com/alexei-led/pi-model-router/blob/main/docs/RELEASING.md).

## Configuration

Copy the example config to one of:

- `~/.pi/agent/model-router.json` (Global)
- `.pi/model-router.json` (Project-specific)

The example's model IDs and thinking levels are illustrative: verify them against
your Pi registry and account. Remove the top-level and per-profile `jev` sections
when copying to project config; they are user-only and otherwise produce a warning.

The extension stores the last selected profile in `~/.pi/agent/model-router-state.json`. It restores this preference only when Pi starts on the router provider without an explicit `--model` selection. Branch-specific state remains in Pi session entries and takes precedence when a session is resumed.

### Basic Config Shape

```json
{
  "classifierModel": "google/gemini-flash-latest",
  "maxSessionBudget": 1.0,
  "profiles": {
    "auto": {
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "off" },
      "micro": { "model": "openai/gpt-5.4-nano", "thinking": "off" }
    }
  }
}
```

### Configuration Fields

| Field                   | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `classifierModel`       | (Optional) Pi model used for four-tier semantic advice only when Jev is not active (disabled, not opted in or missing a key). Supports model aliases. Failure means baseline. |
| `jev`                   | (Optional, user config only) External advisor settings; requires global enablement, a key and an explicit `profiles.<name>.jev.enabled` opt-in. Disabled by default. |
| `ui.statusLine`        | `compact` (default) or `detailed`. Display only; project config may override it. Widget/debug always include full diagnostics. |
| `maxSessionBudget`      | (Optional) Soft generation-cost threshold in USD. Unpinned requests prefer eligible medium-or-lower tiers and skip advisors. Not a spending cap; classifier and Jev costs are excluded. |
| `phaseBias`, `rules`    | Deprecated and ignored, with a fixed value-free warning. Remove these fields; there is no legacy keyword mode. |
| `profiles.<name>.baselineTier` | (Optional) Preferred configured tier; otherwise use `medium`, `high`, `low`, `micro` in that order, filtered by availability/input/effort. |
| `models`                | (Optional) Map of model aliases to definitions with `model`, `contextWindow`, `maxTokens`. |
| `profiles`              | Map of profile definitions, each containing optional `high`, `medium`, `low`, and `micro` tiers (at least one required). Tier models can reference aliases from `models`. |

### Baselines, pins and migration

The tier order is `micro < low < medium < high`; there is no automatic price
ranking or prompt-derived minimum tier. `micro` defaults to `off` thinking;
explicit thinking overrides still apply. Both semantic advisors may select all
four tiers. Partial profiles, including low-only profiles, work for any text when
the configured route supports the request's inputs and effort.

Set `profiles.<name>.baselineTier` to a configured tier to prefer it. Without that
setting, the order is `medium`, `high`, `low`, `micro`. At request time, filter by
live availability, input support and exact effort first, then prefer the baseline
and that same fixed order. Missing default `medium` is fine; no eligible route
produces an actionable configuration/capability error.

A manual pin skips advice and selects only its configured tier (including its
explicit eligible fallbacks). Words never raise or lower a pin; an ineligible pin
fails plainly. Above `maxSessionBudget`, unpinned requests skip advisors and use
the baseline preference within eligible medium-or-lower tiers if any. Otherwise
they keep an eligible configured baseline and report `budget`. This is not a hard
billing limit; advisor costs are not included.

Remove old `rules` and `phaseBias` settings: they remain loadable but are ignored
with a value-free deprecation warning. Use an explicit pin, a configured baseline
or semantic advice instead. Saved pins/cost/settings remain readable; obsolete
routing reasons become non-rendered `legacy` metadata. No keyword safety guarantee
remains, and model tier never grants or restricts tool permissions.

### Optional Jev advisor: user config only

Jev makes one bounded TypeSafe System One Choice request per eligible new user
turn, without retries. It chooses only among the active profile's eligible
primary tier/model/thinking pairs. Fallback models are not extra Jev choices.
Pins, budget policy, a single eligible primary candidate and tool continuations
skip Jev and the classifier.

Malformed responses, `uncertain`, low confidence, timeout and HTTP errors go
directly to the eligible baseline, without a classifier cascade. When Jev is not
active (including a missing key), the optional Pi classifier is a separate
compatibility path; without it, the router uses baseline directly. Jev cannot select another profile or an arbitrary model,
provider account or thinking level. Explicit generation fallback chains may
still cross providers, as configured by you.

Configure Jev **only** in `~/.pi/agent/model-router.json` (or the agent directory
selected by Pi). Both global enablement and an explicit user-level profile opt-in
are required. Work profiles remain disabled unless you explicitly approve sending
their bounded recent conversation text externally. All project-level `jev` settings, including
profile opt-ins, are ignored with a warning, before merging user credentials.

```json
{
  "jev": {
    "enabled": true,
    "apiKey": "<rendered by chezmoi/1Password>",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "model": "jev-1.13.0",
    "timeoutMs": 1500,
    "confidenceThreshold": 0.65,
    "maxStateChars": 12000,
    "mode": "advisory"
  },
  "profiles": {
    "personal": {
      "jev": { "enabled": true },
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "off" },
      "micro": { "model": "openai/gpt-5.4-nano", "thinking": "off" }
    }
  }
}
```

The endpoint, model, timeout, confidence threshold, state limit and mode shown
above are defaults. Only HTTPS endpoints without embedded credentials, query
parameters or fragments are accepted. `timeoutMs` defaults to 1500 ms and must
be a positive finite number within Node's timer range (at most 2147483647 ms).
There is no product-level cap: 4000 or 5000 ms are valid if you prefer waiting
longer before falling back. It sets the total Jev advisory budget, including
request and response-body time; there is no separate 750 ms cap. Confidence must
be 0–1, and the context limit must be 1–12000 characters. The separate classifier-only
path keeps a 10-second bound. Neither path retries or starts generation after
caller cancellation.

If Jev frequently falls back because requests time out, try `"timeoutMs": 3000`
in your user config. Existing explicit values such as 750 remain unchanged;
remove the field or set it to 1500 to use the new default. Increasing the timeout
does not lower the confidence threshold or guarantee a different route. After
upgrading, start a new Pi session; use `/router thinking auto` to clear any
unwanted effort override in an existing session.

**External data:** Jev receives bounded, role-labelled recent user/assistant/tool
text, prioritizing the latest user request within `maxStateChars`, plus candidate
tier/model/thinking identifiers. Truncation is deterministic, with no keyword
scoring or summarizer call. System prompts, raw config, credentials from config,
thinking blocks, tool-call arguments and image/binary blocks are not extracted.
This is not a redaction service: text itself may contain secrets or private data,
including tool output. Approve this external-data handling before enabling a
profile, especially work. Short replies, other languages and imperfect sentences
are advisor input, not local intent branches. Semantic classification and confidence
are probabilistic, not a security sandbox; Pi owns tool permissions.

Jev classifies the **latest user request**, using earlier messages only as
context. Criteria describe the reasoning each tier supports, not just its name.
Do not increase the context limit or lower the threshold just to raise confidence.
Confidence measures decisiveness across choices, **not** the chance that the
selected generation model will succeed. It is distinct from the selected option's
probability. See [Jev Choice](https://docs.typesafe.ai/primitives/choice).

Concurrent calls for the same turn share one Jev request and its original deadline.
A repeated same-turn call reuses the validated decision rather than reverting to
baseline. Cancelling one waiter does not cancel another; the transport is aborted
when no waiters remain. Each new user turn can choose a different backend and
thinking level. Tool continuations keep their validated route. The logical
`router/<profile>` stays selected throughout; this is not conversation-wide pinning.

### Routing diagnostics and display

```json
{
  "ui": { "statusLine": "compact" }
}
```

- **`compact` (default):** profile, tier, model/thinking, advisor outcome, confidence
  and latency. Omits the repeated provider prefix to fit split panes.
  Example: `🧭 Jev high↪base c35%<65% 764ms` means high was advised but its
  confidence was below the threshold; the displayed generation route is baseline.
- **`detailed`:** also shows the advised tier, selected probability, threshold and
  local request-start time. Example:
  `🧭 Jev ↪ base: low-confidence [high c35% p48%] t65% 764ms @18:34:49`.
  Use this on wide terminals; long model/profile names can truncate a footer.
- **Widget / status:** `/router widget on` or `/router status` shows full metrics,
  including the Jev model label, HTTP status, candidate count and context characters.
- **History:** `/router debug on`, then `/router debug show`. The last 50 decisions
  are saved in branch-safe `router-state` session entries and restored on resume.
  Debug off stops collecting history; the latest decision still persists.

`c` is confidence, `p` is the selected option's probability, `t` is the acceptance
threshold. `ms` is local request-to-validated-result time, not pure model inference
time. `@` is the original request's local start time. `reuse` / `tool route` means
no new Jev request: the displayed metrics belong to the original routing attempt.
`base` means deterministic local baseline, not necessarily the medium tier.
`local baseline` / `advice bypassed` distinguishes no advisor from a rejected answer.

Failures are distinguished as `low-confidence`, `uncertain`, `invalid-response`,
`http-error`, `network-error`, `deadline`, `cancelled` or `unavailable`. A quick
low-confidence rejection is **not a timeout**; increasing timeout will not fix it.
Only validated choices and numeric diagnostics are retained. State/debug never
retain the Jev key, endpoint, request text, raw response or remote explanations.
Older explanations are discarded as non-rendered `legacy` metadata; Pi's own
conversation transcript is separate from router state.

For chezmoi, use a **private template**, for example
`private_model-router.json.tmpl` under your agent-directory source path. Render
only the `apiKey` value using a reference such as
`{{ onepasswordRead "op://Personal/TypeSafe/apiKey" | toJson }}` (unquoted in the
JSON template). Adapt the vault/item reference locally. Keep the rendered file
out of Git and restrict permissions to `0600` (`chmod 600` on Unix); verify the
mode without printing the file. Never commit rendered credentials or 1Password
output. No environment variable is required, and the extension never executes a
secret-lookup command. The repository example contains only a placeholder and
keeps Jev disabled.

## Commands

| Command                     | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `/router`                   | Show detailed status, current profile, spend, and settings.                     |
| `/router status`            | Alias for `/router` (show current status).                                      |
| `/router profile [name]`    | Switch to a profile or list available ones (enables router if off).             |
| `/router pin <t\|a>`        | Pin a tier (high/medium/low/micro/auto) for the active profile.                      |
| `/router fix <tier>`        | Correct the _last_ decision and pin that tier for the current profile.          |
| `/router thinking <level>`  | Override thinking level for all tiers (e.g. `/router thinking max`). Unsupported tiers are skipped; an override that leaves no eligible route is rejected without changing any tier. |
| `/router thinking <tier> <level>` | Override thinking level for a specific tier (e.g. `/router thinking low off`). |
| `/router disable`           | Disable the router and switch back to the last non-router model.                |
| `/router widget <on\|off>`  | Toggle the persistent state widget (supports `toggle`).                         |
| `/router debug <on\|off>`   | Toggle router debug state; use `show` or `clear` for local decision history. |
| `/router reload`            | Hot-reload the configuration JSON.                                              |
| `/router help`              | Show usage help for all subcommands.                                            |

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Profile examples (`auto`, `cheap`, `deep`, `anthropic`).
