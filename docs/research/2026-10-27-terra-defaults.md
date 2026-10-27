# Terra default policy evidence

Date: 2026-10-27. This records the basis and limits of the 0.18 OpenAI defaults,
not a production savings or quality guarantee.

## Policy

Terra fills balanced/medium, cost/high and quality/low.
Luna remains the bounded cheap worker; Sol handles difficult, quality and recovery routes.
Code/debug use Terra/xhigh where other Terra activities use medium.
The exact mappings and ownership rules live in [routing modes](../routing-modes.md#openai-default-preferences);
the [generated activity table](../activity-presets.md) covers balanced declarations.

This is a derived operator-selected policy. Vendor guidance does not prescribe
this router table, and equal effort names do not mean equal compute.

## Sources

- [Terra model](https://developers.openai.com/api/docs/models/gpt-6.1-terra),
  [Sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
  [Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna):
  model identity and controls, checked against canonical model-card records on this date.
- [OpenAI model selection](https://developers.openai.com/api/docs/guides/model-selection):
  compare effort and model on representative work.
- [Artificial Analysis Terra frontier](https://artificialanalysis.ai/articles/gpt-6-1-terra-pushes-the-cost-efficiency-frontier):
  general low/medium and coding low/xhigh cost-efficiency frontier.
  Reported maximum coding indices Luna 31, Terra 48 and Sol 54 are indices, not percentages.
- [Codex pricing](https://developers.openai.com/codex/pricing): subscription credit
  billing is not API per-token billing and has no separate cache-write charge.

A preceding local Codex experiment recorded 36 isolated-thread requests through
a shared daemon: two repetitions, three bounded fixtures and six selected
model/effort settings. One capacity retry passed.
**These labels are selected settings, not backend-verified model comparisons.**
The experiment lacked server attestation. Later validation showed that the shared
daemon could ignore per-call provider/base-URL overrides; which other overrides
it honored was not established for these historical requests.

Mean reported fixture charges by selected setting were Terra/xhigh code 0.1339
versus Sol/medium 0.2177; Terra/medium review 0.0649 versus Sol/medium 0.1648;
docs 0.0225 versus 0.0493. Selected Luna/high passed bounded code/review at lower
reported charge, but one Luna-labelled docs result had an arithmetic error;
one Terra/low-labelled result kept a stale test.
This limited historical experiment does not establish backend quality, ROI,
production failure rates or session savings. It is not measured Pi API cost.
Independent Artificial Analysis evidence supports the derived policy rationale.
The [current Pi SDK acceptance](../testing/terra-018-acceptance.md#real-openai-generation)
separately verifies actual routing against outgoing requests and server responses,
not comparative answer quality or savings.

## Runtime and price limits

The router reads provider-scoped input, context, effort and price metadata from
Pi's live registry. Public API maxima and a model's registration under another
provider do not establish this provider's limits or account entitlement.

Standard API input/cached-input/output USD per million tokens:
Luna 0.10/0.01/0.50, Terra 1/0.05/5, Sol 2/0.10/10.
Terra's 30-minute API cache-write rate is 1.25; above 272K input, the full
request uses doubled input/cache rates and 1.5× output rates. Fast service is 2×.
These source rates are not hardcoded router metadata. Catalog scenarios are not
invoices and do not model every service tier, cache duration or subscription charge.
Missing prices do not establish a cheaper model.

Terra supports none/low/medium/high/xhigh/max in the API; Sol does not support none.
Tool use requires Responses. Pi owns API dispatch and effort mapping.
No fake thinking-level ceilings, new max/ultra policy, credential inspection,
provider-name inference or account attestation is introduced.
