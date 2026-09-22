# Jev acceptance policy, structured criteria and parallel questions

Date: 2026-09-22. Model `jev-1.13.0`. Released in 0.7.0. The shipped behavior is documented in
[../jev-advisor.md](../jev-advisor.md#acceptance-policy); the earlier context
experiments are in [jev-context-selection.md](jev-context-selection.md). This is a bounded engineering comparison
against a small predefined corpus, not a model-quality benchmark. No confidence
threshold was lowered to make a table pass.

## Questions

1. Does a structured Choice (`covers` / `notFor` / `examples`) beat the flat
   one-string criteria on the same tasks?
2. Do parallel Noul questions (`frontierBenefit`, `mechanical`) improve or
   stabilize the route when combined in code?
3. Does reading the full probability distribution below the confidence
   threshold route better than discarding the answer?
4. Does the shipped path behave the same inside a real Pi session?

## Direct API comparison

24 prompts from [`jev-quality-tasks.json`](../../extensions/test/fixtures/jev-quality-tasks.json),
`currentRequest` only, `openai-personal` candidates (micro/low/medium = Luna
off/max/max, high = Astra high). One run per variant, then three repeats of the
two structured variants (72 requests each).

| Variant | Accepted | Preferred-tier matches | High matches | Micro matches | Median latency | Median input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Flat strings (0.6.5) | 22/24 | 21 | 8/10 | 11/12 | 369 ms | 985 |
| Structured Choice | 22/24 | 22 | 9/10 | 10/12 | 322 ms | 1300 |
| Structured + two Nouls | 22/24 | 22 | 9/10 | 10/12 | 316 ms | 1488 |

Observed differences between flat and structured:

- `17-repo-cancellation` (expected high): flat chose medium at 34% confidence
  (high 0.35, medium 0.48); structured chose high at 90%.
- `19-routine-explanation` (expected low/micro): flat chose micro at 68%;
  structured chose low at 97%. Both are acceptable.
- Two abstentions (`05-followup-lookup`, `16-unclear`) stayed `uncertain` in every
  variant. `16-unclear` is intentionally unresolvable.

Across three repeats the structured Choice never changed its top option for any
task; only confidence moved by a few points. Adding the Nouls changed **no**
route in 72 requests. The Noul signals separated the extremes cleanly
(`frontierBenefit` 0.24–0.79 on expected-high tasks versus 0.02–0.16 elsewhere;
`mechanical` 0.30–0.99 on expected-micro tasks versus 0.02–0.14 elsewhere), but
the Choice already agreed with them. They did not help the ambiguous follow-ups:
for `05-followup-lookup` the Nouls said mechanical 0.92 while the Choice abstained,
and for `08`-style requests both Nouls were low. Cost: about +190 input tokens per
request, no latency change.

**Decision:** ship the structured Choice; do not add the parallel questions.
Combining a Noul override in code would have re-routed one abstention to micro
and otherwise reproduced the Choice, which is not enough evidence for a second
signal path with its own thresholds.

## Acceptance policy comparison

The 96 structured-Choice samples above were re-scored offline under several
policies. Nine answers were below the 0.65 confidence threshold, all of them
micro/low splits (`11-small-helper` micro c38–46%, `24-array-helper` micro
c45–47%, `23-config-semantics` low c62%). Eight were abstentions.

| Policy | Preferred matches | High routes | Remaining misses |
| --- | ---: | ---: | --- |
| 0.6.5: threshold 0.65, else baseline high | 83/96 | 53 | four micro/low tasks sent to high |
| 0.6.5: threshold 0.65, else baseline medium | 80/96 | 36 | four tasks, including `16-unclear` to medium |
| Quantile 0.7–0.9, baseline medium | 88/96 | 36 | two abstentions to medium |
| **Quantile 0.7–0.9, baseline high** | **92/96** | 44 | one abstention (`05-followup-lookup`) to high |

The quantile policy acts on the lowest tier whose cumulative probability from
micro upward reaches `probabilityThreshold`; `uncertain` mass counts for the
baseline tier. Results were identical for 0.7, 0.8 and 0.9 on this corpus, so the
default 0.8 is a midpoint, not a fitted value. It keeps a genuine micro/low split
on the lower tiers instead of escalating it to the baseline, while any material
mass on high still moves the route up because the cumulative sum only reaches the
threshold at the top.

## Live Pi/agterm validation

Three isolated Pi sessions (`PI_CODING_AGENT_DIR` under `/tmp`, symlinked
provider resources, `pi-sub-aliases`, `pi-provider-compat`, the local router
checkout, `debug: true`, 5000 ms budget), a read-only sample project, ten short
prompts typed through `agtermctl`, decisions read from the persisted
`router-state` session entries and generation targets from assistant metadata.

| Session | Profile | Extension | Prompts | In preferred range | Probability-based selections | Abstentions | Invalid responses |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | claude-personal | shipped (before the validation fix below) | 9 | 9/9 | 2 | 1 | 0 |
| B | claude-personal | spike + two Nouls | 10 | 9/10 | 1 | 1 | 1 |
| C | openai-work | shipped (final) | 10 | 10/10 | 1 | 1 | 0 |

Probability-based selections that the 0.6.5 policy would have sent to the
baseline (medium/Opus or medium/Luna-max):

- "Explain that failure in one sentence" after a missing-file error: low at
  c31–42%, cumulative 0.80–0.86 → low (Sonnet / Luna-medium). Expected.
- "Justify why that protocol stays correct if cancelled mid-commit": high at
  c55%, cumulative 1.0 → high (Fable). Expected.

"Do the other one instead" abstained in every session (c54–60%) and used the
baseline, which is the intended behavior for an unresolvable referent.

Session B produced one `invalid-response` that the new diagnostics labelled
`invalid-distribution`. Twelve direct replays of the reconstructed state did not
reproduce it, and 228 recorded direct responses always contained every option with
sums within 0.01. The likely remaining causes were an omitted zero-mass option or
a two-decimal rounding sum, both of which the old validator rejected. The
validator now accepts omitted options as zero, allows the per-option rounding
tolerance, and reports `distribution-keys`, `distribution-sum` or
`distribution-argmax` separately so the next occurrence is attributable.

Session A also showed that the structured JSON criteria are punctuation-heavy:
actual `usage.input_tokens` exceeded the estimate by 110–135 tokens on every
request. The fixed request headroom was raised from 200 to 400 tokens; session C
then measured estimate/actual ratios of 1.03–1.08.

Median Jev latency was 740–770 ms in all three sessions, unchanged from 0.6.4.
No retries occurred; retry behavior is covered by unit tests only.

## Limits

- The corpus is small, coding-focused and written by the same engineer who set
  the preferred tiers. Adjacent tiers are often both acceptable.
- Live sessions used short prompts to conserve provider quota. Two provider
  profiles were exercised; one profile hit its usage limit and was not used.
- `probabilityThreshold` was not sensitive on this corpus; it may matter more on
  distributions with real medium/high splits, which this corpus rarely produced.
- The one live invalid response was not captured raw, by design. Attribution now
  depends on the new local codes.
