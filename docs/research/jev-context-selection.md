# Jev context study

Date: September 22, 2026. Release: 0.6.5.
This study compares bounded context choices, not model quality.
It used the earlier flat criteria and confidence-only policy. The [policy study](jev-routing-policy.md) covers their replacement.

## Why context selection changed

The earlier selector took five messages before it removed empty text blocks.
In a 27-turn transcript, tool-call-only messages occupied context slots in six windows.
One window lost the previous user request. Tool output supplied 19,000 of 29,089 text characters.

The replacement selects the current request, recent dialogue, and optional tool evidence separately.
TypeSafe recommends [relevant state](https://docs.typesafe.ai/concepts/state) and documents
[limits from unnecessary context](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
The [Jev guide](../jev-advisor.md#context-selection) defines current configuration.

## Live comparison

Six variants ran the same [eight prompts](../../extensions/test/fixtures/jev-context-tasks.json) in isolated Pi sessions.
The prompts included English and Russian follow-ups, tool results, long text, and ambiguous references.
Each run used `jev-latest`, resolved as `jev-1.13.0`, with a 5000 ms budget and 0.65 confidence threshold.

| Variant | Character cap | Prior turns / history cap | Tool policy / cap | Accepted advice | Preferred tier | Median text characters |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| Current only | 2000 | 0 / 0 | none | 4/8 | 7/8 | 146 |
| Dialogue | 6000 | 2 / 5000 | none | 4/8 | 7/8 | 710 |
| Dialogue plus last result | 12000 | 2 / 6000 | last / 1000 | 4/8 | 7/8 | 1244 |
| Deep | 12000 | 6 / 9000 | last / 2000 | 4/8 | 7/8 | 2728 |
| Focused candidate | 12000 | 1 / 2000 | last-error / 1000 | 5/8 | 6/8 | — |
| Selected character-budget precursor | 12000 | 2 / 2000 | last-error / 1000 | 4/8 | 7/8 | 735 |

These caps count UTF-16 characters. Current configuration uses token estimates instead.
Assistant metadata matched the routed target in all 48 turns, with tool continuations included.
The selected variant had a median advisor latency of 755 ms.
Network, cache, and run order were not controlled, so latency does not establish a faster representation.

Every variant sent one short error-explanation task to the high baseline after uncertain or low-confidence advice.
The focused candidate also accepted low for a task labeled high.
A completed generation was not counted as evidence of a correct routing choice.

## Controlled replay

Sixty-eight additional Choice requests reused captured or synthetic context. They made no generation calls.

| Observation | Result |
| --- | --- |
| The actual request followed a long reference block. | Head-only text caused abstention. Beginning-and-end excerpts selected micro at 99–100% confidence. |
| The request referred to a tool failure. | Dialogue alone selected high at 39% confidence. Error evidence raised confidence to 83–87%. |
| An unrelated successful result followed a useful error. | Confidence decreased from 70–72% to 55–57%. |
| Older context repeated irrelevant material. | More history did not resolve the ambiguity. |
| Micro and low were both plausible. | More context and fewer duplicate candidates did not reach the 0.65 threshold. |

Two responses failed validation in the first replay batch. Their exact cause is unknown because raw responses were not retained.
These cases do not establish that one context shape caused invalid responses.

## Token estimate

TypeSafe documents 32000 tokens for state plus the longest question and 64000 for a full request.
It publishes no Jev tokenizer or token-count endpoint.
OpenAI tokenizers underestimated Jev input by 26–49% on five synthetic requests. They also added 22–27 MB of package data.

The local estimate uses ASCII characters divided by four and other UTF-8 bytes divided by two, with a 10% margin.
The serialized request adds fixed headroom. That headroom was 200 tokens during this study and became 400 in version 0.7.0.

| Synthetic request | Reported input | Local estimate | Ratio |
| --- | ---: | ---: | ---: |
| Short English | 957 | 1010 | 1.06 |
| Longer English | 1191 | 1348 | 1.13 |
| Russian | 1811 | 2041 | 1.13 |
| TypeScript | 1250 | 1320 | 1.06 |
| Emoji and mixed text | 1276 | 1467 | 1.15 |
| Long reference with beginning-and-end excerpts | 2884 | 4006 | 1.39 |

This estimate is not a tokenizer or a proven error bound.
Reported server usage supports observation, not automatic changes to the estimator.
A moving Jev model version can change tokenization.

## Result and limits

The selected defaults keep two prior turns, a 500-token dialogue estimate, and a 250-token error-only tool estimate.
They limit routine text transfer while preserving a small amount of reference context.
The clearest gain was retention of a request at the end of long text. Larger windows did not improve every case.

Six later authenticated requests respected the 3000-token state budget. Their estimate-to-actual ratios were 1.06–1.39.
Two Pi turns then persisted routing metrics before generation failed on provider usage limits.
Those two turns establish the advisor boundary, not successful generation. The later [policy study](jev-routing-policy.md#live-pi-results) covers successful generation.

The sample is small and coding-focused. Selected text can still contain private data.
For sensitive profiles, less context does not replace explicit approval for external transfer.
