# Jev routing policy study

Date: September 22, 2026. Model: `jev-1.13.0`. Release: 0.7.0.
This study compares routing choices on a small predefined coding corpus. It does not measure answer quality.
The [Jev guide](../jev-advisor.md#acceptance-policy) defines current behavior.

## Questions

- Do structured Choice criteria improve route selection?
- Do two parallel Noul questions add useful information?
- Does cumulative probability selection improve low-confidence decisions?
- Does the same policy operate inside Pi?

## Direct API results

The [24-task corpus](../../extensions/test/fixtures/jev-quality-tasks.json) used current-request text only.
Micro, low, and medium used Luna with different effort. High used Astra with high effort.
Each variant ran once. The structured variants then ran three more times.

| Variant | Accepted | Preferred tier | High matches | Micro matches | Median latency | Median input tokens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Flat criteria, version 0.6.5 | 22/24 | 21/24 | 8/10 | 11/12 | 369 ms | 985 |
| Structured Choice | 22/24 | 22/24 | 9/10 | 10/12 | 322 ms | 1300 |
| Structured Choice plus two Nouls | 22/24 | 22/24 | 9/10 | 10/12 | 316 ms | 1488 |

Structured criteria moved the cancellation task from medium to the preferred high tier.
Two intentionally ambiguous cases remained uncertain in every variant.
Across repeated runs, the structured Choice kept the same top option for every task. Confidence varied slightly.

Parallel `frontierBenefit` and `mechanical` questions changed no route in 72 requests.
They added about 190 input tokens per request and did not resolve ambiguous follow-ups.
The release uses one structured Choice, without the extra signals.

## Probability selection

The comparison rescored 96 structured-Choice answers offline.
Nine had confidence less than 0.65, all with probability divided between micro and low. Eight answers were abstentions.

| Policy | Preferred matches | High routes | Remaining error pattern |
| --- | ---: | ---: | --- |
| Confidence 0.65, otherwise baseline high | 83/96 | 53 | Four low-tier tasks went to high. |
| Confidence 0.65, otherwise baseline medium | 80/96 | 36 | Four tasks included an ambiguous request sent to medium. |
| Quantile 0.7–0.9, baseline medium | 88/96 | 36 | Two abstentions went to medium. |
| Quantile 0.7–0.9, baseline high | 92/96 | 44 | One ambiguous lookup went to high. |

All thresholds from 0.7 through 0.9 gave identical results on this corpus.
The default 0.8 is a midpoint, not a fitted optimum.
Cumulative probability kept low-tier splits from falling back to the high baseline.
A material high-tier probability still moved selection upward.

## Live Pi results

Three isolated Pi sessions used a 5000 ms advisor budget and short prompts in a read-only sample project.
Native session entries supplied routing metrics. Assistant metadata supplied the actual generation targets.

| Session | Provider family | Variant | Prompts | Preferred range | Probability selections | Abstentions | Invalid responses |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | Claude | Shipped path before validator correction | 9 | 9/9 | 2 | 1 | 0 |
| B | Claude | Two extra Nouls | 10 | 9/10 | 1 | 1 | 1 |
| C | OpenAI | Final shipped path | 10 | 10/10 | 1 | 1 | 0 |

An explanation after a missing-file error selected low through cumulative probability.
A cancellation-protocol request selected high through the same rule.
An ambiguous reference caused abstention in all three sessions.

Session B produced one invalid response. Twelve direct replays did not reproduce it.
The validator now accepts omitted zero-mass options and two-decimal rounding tolerance. Local error codes distinguish the remaining schema failures.
Raw responses were not retained, so the original cause remains unproven.

Actual input exceeded the earlier token estimate by 110–135 tokens in session A.
Fixed request headroom increased from 200 to 400 tokens.
Session C then measured estimate-to-actual ratios from 1.03 through 1.08.

Median advisor latency was 740–770 ms in each session. No live retries occurred.
Unit tests cover retry behavior.

## Limits

- One engineer wrote both the corpus and preferred-tier labels. Adjacent tiers can both be acceptable.
- Short prompts limited provider quota use. They do not represent full production sessions.
- Real medium/high probability splits were rare. Threshold sensitivity remains uncertain for those splits.
- A selected route does not prove that its generated answer is correct.

The [context study](jev-context-selection.md) explains the earlier context and token-budget decisions.
