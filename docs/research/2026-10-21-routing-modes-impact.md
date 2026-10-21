# Routing modes: offline impact

Research date: 21 October 2026. Branch `feature/routing-modes`, before v0.16.0.
Catalog scenario, not a billing or quality measurement.

## Method

- Tier mix and token counts: the two aggregate traces in
  [`usage-data.json`](../assets/usage-data.json) (Claude trace: 1,623
  responses; Pi trace: 1,967 responses). Only the tier of each group and its
  token counters are used. The models in the traces are not used.
- Each tier is routed through `prepareRouterRequest` with a classifier that
  returns that tier, once per mode, for the user's two profile shapes:
  - `claude`: high `opus-5-5/high`, medium `sonnet-5-5/medium`,
    low `sonnet-5-5/low`, micro `haiku-4-5/off`.
  - `openai`: high `gpt-6.1-sol/xhigh`, medium `gpt-6.1-sol/medium`,
    low `gpt-6-luna/medium`, micro `gpt-6-luna/off`.
- Prices: Pi 1.3.0 catalog (same as the golden decision matrix). Each tier's
  fresh input, cache read, cache write and output tokens are priced at the
  routed model. Tokens stay equal across modes, and observed cache reads stay
  as they are.

## Results

Estimated catalog cost, USD, and change against `balanced`:

| Profile | Trace  | cost   | balanced | quality | cost Δ | quality Δ |
| ------- | ------ | -----: | -------: | ------: | -----: | --------: |
| claude  | Claude |  76.92 |    86.35 |   86.35 | −10.9% |      0.0% |
| claude  | Pi     |  87.32 |   167.55 |  167.55 | −47.9% |      0.0% |
| openai  | Claude |  14.72 |    22.51 |   22.51 | −34.6% |      0.0% |
| openai  | Pi     |  80.66 |    87.32 |   87.32 |  −7.6% |      0.0% |

Route mix, share of responses (Claude trace):

| Profile | cost | balanced | quality |
| ------- | ---- | -------- | ------- |
| claude | sonnet/low 80.8%, haiku/off 9.5%, sonnet/medium 9.7% | sonnet/low 76.3%, haiku/off 9.5%, sonnet/medium 4.5%, opus/high 9.7% | sonnet/medium 76.3%, haiku/off 9.5%, sonnet/high 4.5%, opus/xhigh 9.7% |
| openai | luna/low 76.3%, luna/off 9.5%, luna/medium 4.5%, sol/high 9.7% | luna/medium 76.3%, luna/off 9.5%, sol/medium 4.5%, sol/xhigh 9.7% | luna/high 76.3%, luna/off 9.5%, sol/high 4.5%, sol/max 9.7% |

Route mix, share of responses (Pi trace: 83.6% high, 16.4% medium):

| Profile | cost | balanced | quality |
| ------- | ---- | -------- | ------- |
| claude | sonnet/medium 83.6%, sonnet/low 16.4% | opus/high 83.6%, sonnet/medium 16.4% | opus/xhigh 83.6%, sonnet/high 16.4% |
| openai | sol/high 83.6%, luna/medium 16.4% | sol/xhigh 83.6%, sol/medium 16.4% | sol/max 83.6%, sol/high 16.4% |

No-classifier baseline (every request at `medium`):

| Profile | cost | balanced | quality | cost Δ | quality Δ |
| ------- | ---- | -------- | ------- | -----: | --------: |
| claude | sonnet/low | sonnet/medium | sonnet/high | 0.0% | 0.0% |
| openai | luna/medium | sol/medium | sol/high | −95.0% | 0.0% |

The −95.0% is the catalog price ratio: every `gpt-6-luna` price is 1/20 of
the `gpt-6.1-sol` price.

## Findings

1. **`quality` shows no catalog cost difference in any case.** In the user's
   profiles, every tier can still raise effort, so `quality` never uses its
   model lever. An effort change keeps the model and its price. Its real cost
   comes from more thinking and output tokens, which this replay holds equal.
   The live run (L11) must measure it.
2. **`cost` with the effort lever only shows 0.0%.** The `claude`
   no-classifier baseline and the `claude` medium tier change only effort.
   The savings in the table come only from the model lever, so they are a
   lower bound for `cost`.
3. **The model lever dominates.** `cost` moves `claude` high to
   `sonnet/medium` and `openai` medium to `luna/medium`. The size of the
   saving depends on the trace's tier mix: −7.6% to −47.9%.
4. **Subscription profiles.** All routed models have non-zero catalog
   prices, so the cost model lever fires on subscription-billed profiles too.
   For those profiles the estimate is catalog cost, not money. The saving is
   real only where the provider meters quota by catalog price or tokens.

## Limits

- Equal tokens across modes. A cheaper model can need more turns or output.
- No cache rebuild cost after a model switch is added.
- Cache writes use the catalog `cacheWrite` price for both 5-minute and
  1-hour writes.
- Escalation is not modeled. The aggregate traces have no tool-failure data.
- No answer-quality measurement.
