# Jev context selection experiments

Date: 2026-09-22. This is a bounded engineering comparison, not a model-quality benchmark.
No summary model, translation model, extra advisor retry, confidence-threshold change
or keyword-based tier selection was introduced.

## Sources and current boundary

Official guidance recommends relevant, structured state rather than indiscriminate
history: [state](https://docs.typesafe.ai/concepts/state),
[decision design](https://docs.typesafe.ai/concepts/how-to-build-with-system-one),
[known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
The latter describes degradation with unnecessary context. Local model cards had
no Jev record, so no unrelated model's prompting rules were substituted.

The old selector took five transport messages before discarding text-empty blocks.
An audit of the previous 27-turn validation transcript found empty tool-call-only
messages occupying slots in six windows; one window lost the previous user request.
Of 29,089 text characters in that transcript, 19,000 came from tools. This is a
specific sample, not a general distribution of Pi conversations.

## Live comparison

48 prompts ran through actual Pi/agterm sessions with the local extension,
`pi-sub-aliases` and provider-compat loaded exactly once. Each variant had a private
isolated Pi config directory, with existing provider resources referenced without
inspecting auth contents. No experiment changed the main user's context settings
until the final configuration was chosen. Only read/search tools were enabled in
`pi-plan-exec`; no project writes were requested.

All runs used `jev-latest` (responses identified `jev-1.13.0`), 5000 ms and 0.65.
The operator's high/Astra baseline remained unchanged. The eight prompts are in
[`jev-context-tasks.json`](../extensions/test/fixtures/jev-context-tasks.json).
The long-tail prompt uses a generated quoted reference block followed by the actual
arithmetic request. Other cases cover RU/EN follow-ups, an intentional missing-file
error, two file reads, a distant referent and simple → complex → simple transitions.

| Variant | Experiment cap (UTF-16 characters) | Prior turns / history cap | Tool policy | Accepted advice | Preferred-tier matches | Median text chars |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| Current only | 2000 | 0 / 0 | none | 4/8 | 7/8 | 146 |
| Dialogue | 6000 | 2 / 5000 | none | 4/8 | 7/8 | 710 |
| Dialogue + last result | 12000 | 2 / 6000 | last / 1000 | 4/8 | 7/8 | 1244 |
| Deep | 12000 | 6 / 9000 | last / 2000 | 4/8 | 7/8 | 2728 |
| Focused candidate | 12000 | 1 / 2000 | last-error / 1000 | 5/8 | 6/8 | — |
| Chosen char-budget precursor | 12000 | 2 / 2000 | last-error / 1000 | 4/8 | 7/8 | 735 |

Assistant model/provider metadata matched the actual routed target in all 48
runs, including tool continuations. The final default's median advisory latency
was 755 ms. Latency across sequential variants was variable (cache/network/order
were not controlled), so it was not used to claim one representation is faster.

The predefined preferred tiers are engineering preferences, not proof that another
model cannot solve a task. Every variant over-routed the short error-explanation
follow-up to the configured high baseline after uncertain/low-confidence advice.
The one-turn candidate also accepted low for a follow-up where high was preferred.
These misses remain visible; successful generation alone was not counted as a
correct routing judgment. No threshold was lowered to make the table pass.

## Controlled replay

68 additional Choice requests reused identical captured/synthetic contexts across
representations and bounds. There were no generation calls in these replays. Two
small candidate-pool probes checked a residual ambiguity without changing product
candidate policy.

Useful observations:

- **Request at the end:** the published head-only selector sent the reference block
  without the actual task and got `uncertain` (confidence 58–62%). Head/tail selection
  retained the arithmetic request and selected micro at 99–100% in these probes.
- **A relevant tool error matters:** with only an instruction to fix the preceding
  concurrency-test failure, dialogue without the actual failure got high/39%
  (rejected). Adding the bounded failure produced high/83–87% (accepted).
- **Successful noise can hurt:** a follow-up accepting a crash-safe protocol selected
  high/70–72% with dialogue and error-only evidence, versus high/55–57% after adding
  an unrelated successful result. This is a small observation, not a universal rule.
- **More history is not automatically better:** retaining an older padded request
  increased context while nearby error-explanation confidence remained poor.
- **Uncertainty can be about adjacent sufficient choices:** one remaining case had
  probabilities micro=42%, low=56%, high=1%. Additional context or removing a
  duplicate model/effort candidate did not make it cross 0.65. Candidate policy was
  not changed as part of this work.

There were two invalid-response fallbacks in the first replay batch. Raw remote
responses were not retained and their exact schema failure was not diagnosed.
This small sample does not establish a representation-specific cause. Several
ambiguous follow-ups remained below threshold with every tested context policy.

## Token budgeting decision

TypeSafe documents 32k tokens for state plus the longest question and 64k for the
full request, but publishes no tokenizer or client-side count endpoint. The
JavaScript SDK 0.6.0 exposes `systemOne()` and post-response `usage.input_tokens`
only. OpenAI tokenizer packages (`cl100k`/`o200k`) are not Jev-compatible: on five
synthetic full requests they underestimated actual Jev input by 26–49%, with the
largest miss on Russian. Those packages also add 22–27 MB unpacked.

A transparent local estimate performed better on this bounded sample: ASCII/4 plus
non-ASCII UTF-8 bytes/2, followed by a 10% margin; the full serialized request adds
200 tokens of fixed measured overhead.

| Synthetic full request | Jev actual input tokens | Local estimate | Ratio |
| --- | ---: | ---: | ---: |
| Short English | 957 | 1010 | 1.06 |
| Longer English | 1191 | 1348 | 1.13 |
| Russian | 1811 | 2041 | 1.13 |
| TypeScript | 1250 | 1320 | 1.06 |
| Emoji/mixed | 1276 | 1467 | 1.15 |
| Repeated long reference, head/tail-truncated | 2884 | 4006 | 1.39 |

`cl100k_base` and `o200k_base` were also measured on the first five requests. They
underestimated actual Jev usage by 26–49%; the worst case was Russian. The candidate
packages were OpenAI-specific and 22–27 MB unpacked, so none was added. TypeSafe's
JavaScript SDK 0.6.0 exposes post-response usage but no count/tokenizer method, and
the official API documents no counting endpoint. This is not an exact tokenizer and
the sample does not establish a universal error bound.
Server-reported input usage is retained for observation, not automatic estimator
adaptation, because `jev-latest` can change model/tokenization.

## Chosen defaults and implementation

Two prior user turns provide a little reference continuity without a large history
window. A 500-estimated-token dialogue ceiling limits old material; a 250-token
error-only tool ceiling preserves an explicit failure without routinely sending
successful stdout, source dumps or tool schemas. These are a conservative
compromise from this sample, not a statistically proven global optimum.

The selector preserves user-turn boundaries and the last non-empty text reply per
turn. Intermediate narration, thinking and tool-call-only messages cannot displace
those anchors. Only the last result of the immediately previous user turn is eligible;
`last-error` uses its native `isError` flag, not words in output, and does not recover
an older failure after a success. Beginning/end excerpts carry truncation flags.

Four user-only knobs remain: `previousTurns`, `maxHistoryTokens`, `toolResults` and
`maxToolTokens`, under the total `maxStateTokens` estimate (default 3000). Head/tail
truncation is fixed, not another speculative tuning switch. Prior turns are limited
to 20 to bound metadata overhead too. The whole serialized request is rejected
locally above 28000 estimated tokens, leaving margin below the 32k state/question
limit. Configuration uses estimated-token budgets only. Generation context and Pi-classifier behavior
are unchanged. Only numeric composition metrics enter router snapshots/debug UI.

## Token-budget live validation

After migration, six authenticated Jev requests covered short/long English, Russian,
TypeScript, emoji and a 20k-character long-tail input. The selected state respected
the 3000-token budget; the long input kept 10,904 UTF-16 characters in a 3000-token
head/tail excerpt and still selected the final arithmetic task. Estimate/actual
ratios were 1.06–1.39, deliberately conservative in this sample.

Two Pi/agterm turns loaded one local router with subscription aliases. Both completed
Jev routing and persisted estimate/actual metrics (1018/962 and 1021/955) before
OpenAI Codex and Claude generation separately failed on account usage limits. The
footer showed the selected micro routes. These attempts verify the live Pi routing
boundary and external advisor metrics, but not successful generation metadata after
the token migration. The earlier 48-turn character-budget run did verify generation
metadata, and provider delegation remains covered by the full integration suite.
No target-project files were modified. Both experiment sessions were closed.

## Verification and remaining limits

Regression tests cover role exclusions, latest-request priority, tail preservation,
turn anchors under tool-heavy history, independent switches, section/global bounds,
stale-error exclusion, invalid knobs, merge purity, ignored project overrides,
numeric-only snapshotting and provider HTTP integration. The full existing routing,
continuation, cancellation, timeout and state tests also remain applicable.

Local user settings and the chezmoi template were synchronized for these knobs and
the existing `openai-personal` high baseline. The API key was unchanged and its
`onepasswordRead` template expression was not replaced with a literal. Redacted
JSON syntax and scoped settings equality were verified. Full template rendering
initially timed out on the existing secret lookup. After the operator unlocked
1Password, full rendering succeeded: context settings, the high baseline and the
credential matched the local file, with only booleans reported. No broad
`chezmoi apply`, auth-store inspection or credential replacement was performed.

Filtering is not redaction: selected original text can still contain private data.
For confidentiality-sensitive profiles use `toolResults: "none"` or leave Jev off.
For references to older discussions, deliberately increase history and measure;
sending the whole session or raising confidence alone is not a success criterion.
