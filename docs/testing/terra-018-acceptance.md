# Terra routing 0.18 acceptance

Date: 2026-10-27. Node.js 24.15.0, installed Pi 1.4.0, agterm 0.38.1.
The new worktree extension was loaded explicitly. The installed router package,
operator sessions, user settings and trust policy were not changed.

## Deterministic tests

The independent acceptance fixture contains 96 cells: three modes × four tiers
× seven activities plus generic. Tests compare exact model **and effort** through:

- Normalized default declarations and prevalidated immutable plans.
- The shared inspector preview.
- Actual registered-provider delegation, across five exact provider IDs.

Additional regressions cover old generic declarations, explicit sparse/null
activity cells, aliases and target capability metadata, arbitrary models,
opt-outs, pins, manual effort, missing models/prices, context/image eligibility,
mapped effort, logical-medium Sol over budget with no advisor, same-turn mode
changes, classifier failure, and queued/session edits stripping stale defaults.
Existing cancellation, owner/session, background-review, fallback and thought-signature tests remain active.

Terra recovery tests cover all seven activities, repeated failure/edit/failure,
immutable continuation reuse, non-renewing hold expiry and precedence/fence changes.
Native host tests use the actual built-in write tool, not a mocked tool result.

Commands:

```sh
npm test -- extensions/terra-defaults.test.ts extensions/mode-recovery.test.ts
npm test -- extensions/mode-recovery-host.test.ts
npm run check
npm run test:coverage
npm run check:unused
npm run pack:dry
npm audit
npm publish --dry-run --access public
```

The publication dry-run reran all four prepublish gates successfully: 35 test
files, 932 tests; coverage 93.03% statements, 87.14% branches, 94.77% functions
and 94.39% lines, with existing per-file floors unchanged. TypeScript/Biome and
Knip passed; npm audit reported zero vulnerabilities. The 32-file package manifest
excluded tests, fixtures and credential artifacts. Documentation checks found
99 working local links, rendered/inspected five unchanged diagrams, and reported
68 advisory prose findings. No package or tag was published.

## Native agterm checks: synthetic boundaries

Fresh public SDK sessions used isolated agent/config/session directories and
source-aware SettingsManager/DefaultResourceLoader configuration.
The active default tools were read, bash, edit and write. Recovery added only
its deterministic failing-check tool. No credentials or network were needed.

| Check              | Native Pi session                      | Result                                                                                                              |
| ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Complete matrix    | `01a17cb0-43d1-7196-8696-6887adbcfe34` | All 96 actual provider model/effort pairs matched the independent oracle; session mode commands changed generation. |
| Cost/high recovery | `01a17cb0-43cb-75f3-90bb-e99b3c65a49f` | Terra/medium ×3, Sol/high after failure/write/failure, held Sol/high next task, Terra/medium after expiry.          |

The recovery fixture wrote only its proof file in the temporary working directory.
Classification and generation boundaries were synthetic; Pi's extension, native
session, commands, tool execution and routing controller were real.

A preceding matrix attempt used an old synthetic catalog that disabled off for
Luna. Pi correctly mapped micro/off to low, failing the configured oracle.
That attempt stopped at the first assertion. Its artifacts were retained;
the corrected fixture exposes supported Luna/Terra off and the new run passed.
This was a fixture capability mismatch, not an API retry or model failover.

## Real OpenAI generation

This was a **separately authorized builtin `openai-codex` provider** test.
The public auth readiness command did not resolve the extension-owned
`openai-codex-personal` alias. No alias credentials were inspected or copied.
The normal public ModelRuntime resolved existing builtin OAuth before the
isolated router configuration loaded. A deterministic local classifier chose
tier/activity; it made no external classification calls.

Native session: `01a17cb4-9f4b-7237-9154-5398e9191780`.

| Mode / logical cell      | Real requests | Outgoing and server-reported model / effort       | Input / output tokens |
| ------------------------ | ------------: | ------------------------------------------------- | --------------------: |
| balanced / medium code   |             2 | Terra / xhigh, including a bash tool continuation |             2603 / 40 |
| quality / low generic    |             1 | Terra / medium                                    |             1356 / 10 |
| quality / medium generic |             1 | Sol / medium                                      |             1387 / 10 |
| cost / medium generic    |             1 | Luna / high                                       |             1418 / 20 |

The bash call ran only `printf 'TERRA_018_TOOL_OK'`.
Each request's public outgoing payload and server response.created/completed
reported the expected model and reasoning effort. There were no provider errors,
capacity retries, fallback providers or generation fallbacks.

Total observed usage was 6764 input and 80 output tokens. Pi's reported catalog
cost totaled 0.0072348 USD. This is not a subscription invoice or a savings
measurement. Runtime context windows and effort maps were saved as observed
catalog metadata, not promoted to global constants.

Pi's legacy custom-provider assistant-message `thinkingLevel` can retain the
logical request's earlier selected level. Pi 1.4's public agent-core
`dist/agent-loop.js:282–283` explicitly stamps the requested level after the
stream result with `Object.assign(..., { thinkingLevel: config.reasoning ?? "off" })`;
a provider-supplied message field would be overwritten. See
[the public agent-loop source](https://github.com/earendil-works/pi/blob/v1.4.0/packages/agent/src/agent-loop.ts).
It was not used as physical-effort evidence: router decisions, outgoing payloads
and server reasoning fields agreed. A regression passes a differently stamped
host message through actual delegation and checks router Now, strip, inspector
formatting and recorded decision against the delegated effort.
This test does not establish account identity behind an alias, every provider's
availability, broad answer quality, native pi-subagents inheritance or production ROI.

## Artifacts and cleanup

The external artifact bundle is named `terra-pi-018-qA8xEz`.
It contains isolated native session files, per-check evidence.json, a minimal
public usage.json, terminal captures and agterm tree snapshots.
No credential, authorization header or raw provider payload was captured.

| Created agterm session                 | Purpose                            | Final tree |
| -------------------------------------- | ---------------------------------- | ---------- |
| `817D6A2F-7697-45D9-A3E4-FCF8F17DE722` | Failed off-mapping fixture attempt | Absent     |
| `24C9A433-7331-4EB7-954F-62C8EE782A16` | Corrected 96-cell matrix           | Absent     |
| `B8BDF5BB-AB1B-4736-AB70-0339C7389525` | Native recovery                    | Absent     |
| `980C0155-0409-450D-B6B4-0574A27BEDEF` | Real builtin OpenAI                | Absent     |

All four task-created sessions were closed after artifacts were saved and their
absence was checked against the final agterm tree. Unrelated sessions were not closed.
No global package installation, tag, publication or release workflow was performed.
