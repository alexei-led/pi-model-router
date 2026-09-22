# Jev advisor

User guide for the optional TypeSafe Jev advisor: what it sends, how it chooses,
how to configure it and how to read its diagnostics. Mechanism and code
boundaries are in [architecture.md](architecture.md); the evidence behind the
defaults is in [research/](research/).

## What it does

Jev makes one bounded TypeSafe System One Choice request per eligible new user
turn and picks one of the active profile's eligible primary tier/model/thinking
pairs. It never selects another profile, an arbitrary model, a provider account
or a thinking level that the profile does not configure. Explicit generation
fallback chains stay as you configured them and are not extra Jev choices.

Jev is skipped, and the local baseline used, when:

- a tier is pinned;
- the session is above `maxSessionBudget`;
- only one primary candidate is eligible (nothing to choose);
- the turn is a tool continuation with a reusable validated route.

Malformed responses, `uncertain`, timeout and HTTP errors go directly to the
eligible baseline. There is no classifier cascade after Jev. When Jev is not
active (disabled, not opted in or missing a key), the optional Pi classifier is
a separate compatibility path; without it, the router uses the baseline.

## Enabling and privacy

Configure Jev **only** in `~/.pi/agent/model-router.json` (or the agent
directory selected by Pi). Both global `jev.enabled` and an explicit per-profile
`profiles.<name>.jev.enabled` opt-in are required. All project-level `jev`
settings, including profile opt-ins, are ignored with a warning before user
credentials are merged. Work profiles stay off unless you explicitly approve
sending their bounded recent conversation text externally.

Jev receives bounded text in three named JSON fields, `currentRequest`,
`recentDialogue` and `recentToolEvidence`, plus candidate tier/model/thinking
identifiers. System prompts, raw config, credentials from config, thinking
blocks, tool-call arguments and image/binary blocks are never extracted.

This is not a redaction service: the selected text, including tool output, may
contain secrets or private data. Enabling a profile is approval to send that
text. TypeSafe states that Jev is not trained on customer requests; zero data
retention is an enterprise option, not a default. See
[TypeSafe legal](https://docs.typesafe.ai/legal).

Semantic classification and confidence are probabilistic, not a security
boundary. Tiers describe model/effort choices; Pi owns tool permissions.

## Configuration

```json
{
  "jev": {
    "enabled": true,
    "apiKey": "<rendered by chezmoi/1Password>",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "model": "jev-1.13.0",
    "timeoutMs": 1500,
    "confidenceThreshold": 0.65,
    "probabilityThreshold": 0.8,
    "maxStateTokens": 3000,
    "context": {
      "previousTurns": 2,
      "maxHistoryTokens": 500,
      "toolResults": "last-error",
      "maxToolTokens": 250
    },
    "retry": { "maxAttempts": 2, "backoffMs": 400 },
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

All values except `enabled`, `apiKey` and the profile opt-in are defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `endpoint` | TypeSafe System One | HTTPS only; no embedded credentials, query or fragment. |
| `model` | `jev-1.13.0` | Pin a versioned ID. `jev-latest` moves on new releases, which can change answers behind tuned thresholds. |
| `timeoutMs` | `1500` | Total advisory budget: request, response body and the single transient retry. Positive, finite, at most 2147483647. No product cap; 3000–5000 is valid if you prefer waiting over falling back. |
| `confidenceThreshold` | `0.65` | 0–1. Choice confidence at or above this is acted on directly. |
| `probabilityThreshold` | `0.8` | Above 0, at most 1. Used below the confidence threshold; see [Acceptance policy](#acceptance-policy). |
| `maxStateTokens` | `3000` | Estimated token budget for the selected state, 1–24000. |
| `context.previousTurns` | `2` | Prior user turns, each with its last non-empty assistant text reply. 0–20. |
| `context.maxHistoryTokens` | `500` | Shared estimated-token ceiling for prior dialogue, 0–24000. |
| `context.toolResults` | `"last-error"` | `"none"`, `"last"` or `"last-error"` (last result only when Pi marks it `isError`). |
| `context.maxToolTokens` | `250` | Estimated-token ceiling for that one tool result, 0–24000. |
| `retry.maxAttempts` | `2` | HTTP attempts in total, 1–5. `1` disables retries. |
| `retry.backoffMs` | `400` | First backoff delay, 0–60000; doubled per attempt and raised to `Retry-After` when the server sends one. |
| `mode` | `"advisory"` | The only supported value. |

Invalid values or unknown `context`/`retry` keys reject the whole Jev config
with a value-free warning. Partial `context` and `retry` objects inherit
defaults.

Only a documented transient status (`408`, `429`, `5xx`) is retried, and only
when a full round trip still fits inside `timeoutMs`. Permanent statuses,
malformed responses and caller cancellation are never retried. The status list
and the minimum retry window are TypeSafe's contract and stay in code.

### Storing the key

Use a private chezmoi template such as `private_model-router.json.tmpl` under
your agent-directory source path and render only `apiKey`, for example
`{{ onepasswordRead "op://Personal/TypeSafe/apiKey" | toJson }}` (unquoted in
the JSON template). Keep the rendered file out of Git with mode `0600`. No
environment variable is required; the extension never executes a secret-lookup
command. The repository example keeps Jev disabled with a placeholder key.

## Context selection

Priority is current request → recent dialogue → tool evidence. Individual
ceilings never expand `maxStateTokens`. The full current request wins when it
fits; otherwise its beginning and end are kept and `truncated: true` is set.
Prior turns use the same head/tail excerpts when needed.

Only the last tool result of the immediately previous user turn is eligible.
`last-error` uses Pi's native `isError` flag; it does not parse output for words
such as `ERROR`, search backwards for an old failure, or resurrect a failure
after a later successful result. A tool can report a real failure as ordinary
text with `isError: false`; choose `"last"` when that matters. Empty,
thinking-only and tool-call-only assistant messages cannot consume dialogue
slots.

Suggested overrides (merge into `jev.context`):

- Independent tasks: `{"previousTurns": 0, "toolResults": "none"}`
- Dialogue only: `{"previousTurns": 2, "toolResults": "none"}`
- Tool-heavy diagnosis: `{"toolResults": "last", "maxToolTokens": 500}`
- Longer follow-ups: `{"previousTurns": 4, "maxHistoryTokens": 1000}`

Larger windows did not consistently help in the recorded experiments; the one
clear gain was keeping a request that sits at the end of long text. See
[research/jev-context-selection.md](research/jev-context-selection.md).

Token counts are estimates. TypeSafe publishes no tokenizer; the router uses a
conservative local estimate and rejects a serialized request above 28000
estimated tokens, below Jev's 32k state-plus-question limit. Widget/debug show
the estimate next to Jev's reported `usage.input_tokens`. This affects Jev only:
generation still receives Pi's normal context.

## How Jev is asked

Jev classifies the **latest user request**; earlier messages are context only.
Each tier is a structured Choice option with `covers`, `notFor` and `examples`
(`high` also lists `useWhen`) plus its concrete route, following TypeSafe's
guidance for easily confused adjacent options. An `uncertain` option lets Jev
abstain.

The objective is quality-first: prefer frontier reasoning when it can materially
improve correctness or completeness or reduce rework, even if a smaller model
could probably complete the task. Direct retrieval and mechanical work still
favor micro/low. This is semantic advice, not a keyword or length heuristic.

Confidence measures how decisively the probability mass sits on one option. It
is **not** the chance that the selected generation model will succeed, and it is
distinct from the top option's probability. See
[Jev Choice](https://docs.typesafe.ai/primitives/choice).

## Acceptance policy

1. Top option `uncertain` → no advice; the baseline is used.
2. Confidence ≥ `confidenceThreshold` → act on the top option (`basis=choice`).
3. Otherwise read the full validated distribution and act on the **lowest tier
   whose cumulative probability, counted from micro upward, reaches
   `probabilityThreshold`** (`basis=probability`). Abstention mass counts for the
   profile's baseline tier.

This is deliberately asymmetric: a split between adjacent low tiers stays low,
while material mass on high moves the route up, because the cumulative sum
reaches the threshold only at the top. Raise `probabilityThreshold` toward 1 for
a more conservative fallback, or lower it toward 0.5 to follow the plain argmax.
Do not lower `confidenceThreshold` just to raise the acceptance rate. The
thresholds were checked against the published task corpus and live sessions in
[research/jev-routing-policy.md](research/jev-routing-policy.md).

Concurrent calls for the same turn share one request and its deadline. A
repeated same-turn call reuses the validated decision. Each new user turn can
choose a different backend and thinking level; tool continuations keep their
validated route. The logical `router/<profile>` model stays selected.

### Quality-first fallback

If avoiding underpowered answers matters more than cost or latency, set
`"baselineTier": "high"` on a profile that configures a high tier:

```json
{ "profiles": { "personal": { "baselineTier": "high" } } }
```

Uncertain, failed or timed-out advice then prefers the eligible high route, and
abstention mass counts for high. Confident micro/low advice still wins. Pins,
live capabilities, explicit fallback order and the soft budget still apply.

## Diagnostics

```json
{ "ui": { "statusLine": "compact" } }
```

- **compact** (default): profile, tier, model/thinking, advisor outcome,
  confidence and latency. Examples:
  `🧭 Jev → high c91% · 807ms`,
  `🧭 Jev medium c35% <65% → high · 764ms` (probability-based selection),
  `🧭 Jev: no tier chosen → baseline · 860ms`,
  `🧭 Jev: invalid response (distribution-sum) → baseline · 500ms`,
  `🧭 Jev: timeout → baseline · 5.0s`.
- **detailed**: adds the top option's probability and the request start time:
  `🧭 Jev medium c35% <65% → high · 764ms · p48% @18:34:49`.
- **Widget / `/router`**: full metrics, including the Jev model label,
  HTTP status, attempt count, candidate count, `selected`, `basis`, `route-p`
  (cumulative probability of the selected tier and every lower tier),
  `route-threshold`, estimated context/request tokens and actual server input
  usage.
- **Log**: `/router log on`, then `/router log`. The last 50 decisions are
  saved in branch-safe `router-state` session entries and shown with unique
  request counts, advised tiers, outcome rates and median latency for the
  retained window only. Locally generated request IDs deduplicate shared
  requests, cached routes and tool continuations. `/router log clear` forgets
  them.

Reading the footer:

- `c` is confidence, `p` is the top option's probability, `<65%` means the
  Choice was below `confidenceThreshold` and the arrow shows the tier selected
  from the distribution.
- `ms`/`s` is local request-to-validated-result time. `@` is the request start.
- `reuse` / `tool route`: no new request; the metrics belong to the original
  routing attempt.
- `baseline` means the deterministic local baseline, not necessarily medium.
- `no tier chosen` means Jev abstained. Compact mode omits abstention scores;
  widget/debug label them `abstention-confidence` and `abstention-p`.
- `local baseline` means no advisor is configured. `advice skipped: …` means
  an advisor is configured but was not asked, and says why: `pinned <tier>`,
  `over budget`, `only <tier> eligible` (one primary route survived the
  capability, input or thinking-override filter), `tool turn`, `no user turn`
  or `turn already advised`. Widget/debug keep the raw `bypassReason` code.

Outcomes: `selected`, `uncertain`, `invalid-response`, `http-error`,
`network-error`, `deadline`, `cancelled`, `unavailable`, `input-too-large`.
A quick rejection is not a timeout; increasing `timeoutMs` will not change it.

An `invalid-response` names the local check that failed: `unreadable-body`,
`missing-answer`, `unexpected-answer-type`, `unknown-choice`,
`invalid-confidence`, `distribution-keys` (unknown option key),
`distribution-sum` (outside two-decimal rounding tolerance) or
`distribution-argmax` (`choice` is not the top option). Omitted zero-mass
options are accepted. `http-error` keeps only the status and attempt count; the
widget adds a fixed hint for `401` (check the user-config key), `422` (request
shape rejected) and `429`/`529` (transient limit, retried once).

State, debug and UI retain only validated choices, numeric diagnostics, local
validation codes, recognized model labels and locally generated request IDs.
They never retain the key, endpoint, request text, raw response or remote
explanations.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `advice skipped: only high eligible` on every turn | A thinking override (for example Pi's `xhigh`) or a capability filter leaves one primary route | `/router thinking auto`, or give other tiers a model that supports that level |
| `advice skipped: pinned …` / `over budget` | Manual pin or `maxSessionBudget` reached | `/router pin auto`; raise or remove the budget |
| No `🧭 Jev` in the footer after upgrading | Pi loaded the previous extension version at session start | Start a new Pi session |
| `Jev disabled: missing user-config API key` | Key absent or blank in the user config | Render the key; project config cannot supply it |
| `timeout → baseline` often | Budget too small for your network | `"timeoutMs": 3000` in user config |
| `HTTP 401` | Wrong or revoked key | Check the rendered user config |
| `HTTP 422` | Request shape rejected by TypeSafe | Report with `/router log` output; no request text is stored |
| `HTTP 429` / `529` after retry | Rate limit or overload | Transient; the router already retried once |
| `invalid response (…)` | A local validation named in parentheses | Report the code; raw responses are not stored by design |
| Uses the configured baseline on ambiguous follow-ups | Jev abstained | Expected; add the referent to the request or set `baselineTier` |
