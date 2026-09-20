# pi-model-router

[![CI](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/alexei-led/pi-model-router/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![npm downloads](https://img.shields.io/npm/dm/%40alexeiled%2Fpi-model-router?logo=npm)](https://www.npmjs.com/package/@alexeiled/pi-model-router)
[![Latest release](https://img.shields.io/github/v/release/alexei-led/pi-model-router?display_name=tag&sort=semver)](https://github.com/alexei-led/pi-model-router/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.19](https://img.shields.io/badge/node-%3E%3D22.19-339933?logo=node.js&logoColor=white)](package.json)

Per-turn model router for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). Selects high, medium or low-tier models using task intent, a soft budget policy and custom rules, while keeping the selected `router/<profile>` model stable.

> **Independent fork:** This project is an independently maintained fork of [yeliu84/pi-model-router](https://github.com/yeliu84/pi-model-router), originally created by Ye Liu. It is not an official upstream release. The original MIT license and copyright notice are preserved.

## Fork status

This fork is maintained at [alexei-led/pi-model-router](https://github.com/alexei-led/pi-model-router). It publishes independent releases as `@alexeiled/pi-model-router` and accepts fixes for current Pi versions and provider integrations. See [CHANGELOG.md](CHANGELOG.md) for fork-specific changes.

## What it does

- **Logical Router Provider**: Registers a `router` provider that exposes stable profiles (e.g., `router/balanced`) as models.
- **Per-Turn Routing**: Intelligently chooses between `high`, `medium`, and `low` tiers for every turn based on task intent and complexity.
- **Task-Aware Heuristics**: Detects planning vs. implementation vs. lightweight tasks using keyword analysis, word count, and conversation history.
- **Advanced Controls**: Includes built-in support for:
  - **LLM Intent Classifier**: Optionally use a fast model to categorize intent (overrides heuristics).
  - **Custom Rules**: Define keyword-based tier overrides for specific patterns (e.g., `deploy` → `high`).
  - **Cost Budgeting**: Set a session spend limit; high tier downgrades to medium once exceeded.
  - **Fallback Chains**: Automatic retry with alternative models if the primary choice fails.
- **Phase Memory**: Biased stickiness to keep you in the same tier during multi-turn planning or implementation work.
- **Thinking Control**: Full control over reasoning/thinking levels per tier and profile. Changing pi's thinking level (e.g. via `shift+tab`) automatically applies as an all-tier override for the active router profile.
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

If the upstream package was installed through another manifest, remove that entry there instead. The configuration file and router commands remain compatible for this release.

### For development

Use Node.js 22.19+ and npm. Install and validate with:

```bash
npm ci --ignore-scripts
npm run check
npm test
```

`npm run check` runs Biome lint, formatting and import-order checks, then the
TypeScript compiler. Warnings fail the check. CI and releases use the same gate.

- `npm run format` formats TypeScript and root JSON files.
- `npm run lint` checks lint rules; `npm run lint:fix` applies safe lint fixes.
- `npx biome check --write .` also fixes formatting and import order.
- `npm run tsc` runs only the type checker.

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

- Both generation and classification use Pi's provider registry, including native/custom providers and credential-specific URLs.
- Fallbacks run only before content is emitted; cancellation does not retry.
- Classifier requests use isolated context, a 10-second cancellation deadline and a 256-token output limit. Failures retain local routing.
- Context trimming preserves system instructions and whole active tool turns. It is a text estimate, not a guarantee that images or a large active turn fit.

See [architecture](https://github.com/alexei-led/pi-model-router/blob/main/docs/ARCHITECTURE.md) and [release procedure](https://github.com/alexei-led/pi-model-router/blob/main/docs/RELEASING.md).

## Configuration

Copy the example config to one of:

- `~/.pi/agent/model-router.json` (Global)
- `.pi/model-router.json` (Project-specific)

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
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "low" }
    }
  }
}
```

### Configuration Fields

| Field                   | Description                                                                       |
| ----------------------- | --------------------------------------------------------------------------------- |
| `classifierModel`       | (Optional) Model used to categorize intent. Supports model aliases. If omitted, fast heuristics are used. |
| `maxSessionBudget`      | (Optional) Soft generation-cost threshold in USD. Downgrades high to medium, or low if medium is absent. Not a spending cap; classifier cost is excluded. |
| `phaseBias`             | (0.0 - 1.0) Stickiness of the current phase. Higher = more stable. Default `0.5`. |
| `rules`                 | List of custom keyword rules (e.g. `{ "matches": "deploy", "tier": "high" }`).    |
| `models`                | (Optional) Map of model aliases to definitions with `model`, `contextWindow`, `maxTokens`. |
| `profiles`              | Map of profile definitions, each containing optional `high`, `medium`, and `low` tiers (at least one required). Tier models can reference aliases from `models`. |

## Commands

| Command                     | Description                                                                     |
| --------------------------- | ------------------------------------------------------------------------------- |
| `/router`                   | Show detailed status, current profile, spend, and settings.                     |
| `/router status`            | Alias for `/router` (show current status).                                      |
| `/router profile [name]`    | Switch to a profile or list available ones (enables router if off).             |
| `/router pin <t\|a>`        | Pin a tier (high/medium/low/auto) for the active profile.                      |
| `/router fix <tier>`        | Correct the _last_ decision and pin that tier for the current profile.          |
| `/router thinking <level>`  | Override thinking level for all tiers (e.g. `/router thinking max`). Not all tier models may support every level. |
| `/router thinking <tier> <level>` | Override thinking level for a specific tier (e.g. `/router thinking low off`). |
| `/router disable`           | Disable the router and switch back to the last non-router model.                |
| `/router widget <on\|off>`  | Toggle the persistent state widget (supports `toggle`).                         |
| `/router debug <on\|off>`   | Toggle turn-by-turn routing notifications (supports `toggle`, `clear`, `show`). |
| `/router reload`            | Hot-reload the configuration JSON.                                              |
| `/router help`              | Show usage help for all subcommands.                                            |

## Documentation

- [Architecture Guide](docs/ARCHITECTURE.md): Deep dive into the routing logic and modular design.
- [Sample Configuration](model-router.example.json): Diverse profile examples (`cheap`, `deep`, `balanced`).
