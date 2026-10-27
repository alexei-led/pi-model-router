# Routing modes

**Activity says what the work is. Tier says how demanding it is. Mode adjusts the preferred model and effort.**

Keep `balanced` for normal use. Choose `cost` for a cheaper starting route,
or `quality` for a stronger preferred model/effort pair.
These names describe policy, not measured quality or a spending guarantee.

## OpenAI default preferences

With the new example ladder, the generic preferences are:

| Tier   | cost           | balanced       | quality        |
| ------ | -------------- | -------------- | -------------- |
| micro  | Luna / off     | Luna / off     | Luna / off     |
| low    | Luna / medium  | Luna / high    | Terra / medium |
| medium | Luna / high    | Terra / medium | Sol / medium   |
| high   | Terra / medium | Sol / high     | Sol / xhigh    |

Luna is `gpt-6-luna`, Terra is `gpt-6.1-terra`, and Sol is `gpt-6.1-sol`.
The exact configured provider ID is preserved. Availability under one provider
does not establish availability under another.

Built-in activities use the same low row. At medium/balanced and high/cost,
code/debug use Terra/xhigh; other activities use Terra/medium.
Medium/quality uses Sol/high for code/debug/plan/review, otherwise Sol/medium.
High/balanced uses Sol/xhigh for debug/plan/review, otherwise Sol/high.
High/quality is Sol/xhigh. Existing micro activity pairs stay unchanged.
The [generated mode table](mode-preferences.md) lists every activity cell.

These are **model-first, mode-aware defaults**, not the old effort-first quality
transform. They apply only to default-owned cells:

- Recognized OpenAI built-in activity cells receive the new preferences on reload.
- Generic cells receive them only with `activityPreset: "auto"` and a homogeneous
  profile whose entire configured generic ladder matches the balanced example
  above, after alias resolution. Partial matching ladders are supported; they
  can introduce a preferred model not named in another tier.
- Generic declarations are not rewritten. An old/custom ladder keeps its
  generic mode transform. Explicit activity cells, including thinking-only
  cells, never receive built-in mode alternatives. `null` uses the generic cell.
  Session cell edits remove built-in alternatives from that cell.
- `activityPreset: "off"` disables all automatic activity/mode defaults,
  including generic alternatives. `activityRouting: "off"` excludes activity
  cells only; a matching generic ladder can still use its mode defaults.

A preferred primary must support the input, fit the request and have a supported
mapped effort. Cost model changes also require positive catalog prices proving
a cheaper input rate. The configured primary's registry price can supply that
comparison even when the primary cannot serve the input; only the preferred
target must be input-eligible. Missing/zero prices are not evidence of a cheaper model.
If a preference is ineligible, use the eligible legacy transform below, then
the configured pair. This selection adds no implicit generation fallback or retry.

### Custom and non-OpenAI cells

| Mode       | Legacy transform                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cost`     | Use the next lower tier's model when its input price is lower and its context fits. Otherwise lower effort one step, not below `low`.    |
| `balanced` | Keep the configured pair.                                                                                                                |
| `quality`  | Raise effort one step. If no higher supported effort exists, try the next tier's route. Do not use a high-source tier lever over budget. |

Anthropic presets and arbitrary/custom/mixed providers retain this behavior;
the router never inserts Terra into them. Quality does not intentionally lower
an eligible balanced route's effort on the same model.

The soft budget filters logical tiers and skips advisors, not physical models
or prices. A normalized medium Sol cell can remain eligible over budget even
when high also names Sol. This is not a physical-model price ceiling.

`micro` is unchanged by modes. A pin uses its generic configured tier and bypasses the mode.
A tier-wide effort override also bypasses that tier's mode transform.
Missing or zero prices do not prove that another model is cheaper.

For example, with the built-in OpenAI preset, `medium + debug` prefers:

```text
cost      → gpt-6-luna / high
balanced  → gpt-6.1-terra / xhigh
quality   → gpt-6.1-sol / high
```

This example requires available targets, usable prices for cost and fitting context.
Defaults and custom transforms follow the ownership rules above.
The [decision matrix](decision-matrix.md) also covers pins, budgets, escalation and explicit overrides.

## Change this session

Use the command for the **next request**, including a subsequent tool-loop request:

```text
/router mode cost
/router mode balanced
/router mode quality
/router mode default
```

`default` removes the session override. It does not force balanced.
Run `/router mode` or `/router status` to see the effective mode and its source.
A resumed session retains an activated override. `/new` starts without one.

### Use Settings instead

1. Open `/router settings`.
2. Move to **Session mode**, beside **Pin tier**.
3. Choose `cost`, `balanced`, `quality` or `inherit (project/profile)`.
4. Choose **Apply**.
5. Close the inspector and send a new user message.

**Settings changes queue for the next user message. They do not interrupt the current tool loop.**
Consumed steering and queued follow-up user messages also activate pending settings.
Queued-but-unconsumed input and ordinary tool results do not.
Use `/router mode` when you want next-request activation instead.
**Undo** reverses unchanged editor-owned controls. A concurrent command change rejects a stale queued mode.
Only the activated session override is persisted. Drafts and queued changes are not saved.
Nothing writes configuration files or changes provider credentials.

## Set a durable default

For one user-level profile, merge this fragment into `~/.pi/agent/model-router.json`:

```json
{
  "profiles": {
    "auto": {
      "mode": "quality"
    }
  }
}
```

Replace `auto` with your profile name. Keep its existing tier declarations.
Run `/router reload` after editing that file.

For a project, put this in `.pi/model-router.json`:

```json
{ "mode": "cost" }
```

The first configured layer wins:

1. Activated session override.
2. Project top-level `mode`.
3. User profile `mode`.
4. `balanced`.

A top-level `mode` in the user file is ignored with a warning.
Project files cannot set mode policy, budgets or classifier consent.
Use only project route files you trust.

## Read configured, preferred and actual separately

Open `/router routes` and choose **Edit cell**.

- **Current configuration:** the file-backed or activated session cell.
- **Mapped configured effort:** that cell's effort after capability mapping and any tier-wide override.
- **Current preferred:** the mode-adjusted text route, with its source and model/effort lever.
- **Queued preferred:** the route after queued mode or cell changes activate.
- **Actual:** the model and effort that generated, shown in Now and the route strip.

The Routes list also shows preferred pairs alongside configured activity cells.
A pin, effort override, disabled activity routing or declared fallback has an explicit preview label.
Unapplied drafts do not replace the current preference.

**Preferred is not a prediction of actual generation.**
The preview assumes text input and does not know the next request's context size or account entitlement.
Generation revalidates input, context and authentication.
Advice, a switch-cost hold or temporary recovery can also change the result.

## Recover from a failing cost route

Cost mode can keep the logical tier `high` while using a cheaper physical model.
For example, OpenAI `high + ops` prefers Terra/medium instead of its balanced Sol/high pair.
Ordinary one-tier escalation cannot move above high.

The router now restores the **balanced high cell** after the existing failure trigger:

1. A tool fails.
2. A successful Pi `edit` or `write` occurs.
3. The same tool fails again with the same normalized output, in the same user turn.

Recovery requires a validated same-turn native continuation on a cost-transformed high route.
It uses only the current prevalidated matrix. It adds no fallback model or retry.
Recovery arms only when a balanced high plan is eligible. Otherwise, the eligible cost incumbent remains.
The logical mode remains `cost`. The strip reports **Cost recovery · balanced high route**.
Following tool requests can reuse that immutable recovery plan. Fresh eligible reviews can still change activity.

The recovery lasts through the failing turn and the cost mode's configured `escalationHoldTurns` further user turns.
Its branch, configuration and policy scope must still match.
It does not renew indefinitely from the same failure in the same turn.
A new turn can trigger recovery again after another failure/edit/failure sequence.

Pins, explicit effort overrides, budget policy and Google thought-signature constraints retain precedence.
A changed configuration or sibling branch cannot inherit the recovery.
Reload, shutdown and a fresh provider runtime clear the hold. Resuming does not restore it.
Other modes keep their ordinary one-tier failure escalation.
See [failure detection limits](user-guide.md#repeated-tool-failures).

## Tune switching policy

Mode patches adjust the existing Pi switch controller. They do not copy Claude Code's vote/dwell controller.

| Mode       | `costSensitivity` | `escalationHoldTurns` |
| ---------- | ----------------: | --------------------: |
| `cost`     |               0.8 |                     1 |
| `balanced` |        configured |            configured |
| `quality`  |               0.2 |                     4 |

These values are untuned starting points.
A base `switchPolicy` value loses to the mode patch. An explicit Settings edit wins over both for the session.
Override a mode patch in the user file, for example:

```json
{
  "modes": {
    "cost": {
      "policy": {
        "costSensitivity": 0.7,
        "escalationHoldTurns": 0
      }
    }
  }
}
```

This example limits a cost-mode escalation or recovery hold to the failing turn.
It does not disable the failure response.
An effort-only change can increase thinking and output tokens even when the catalog price per token stays unchanged.
See [cache and cost limits](user-guide.md#read-costs-and-cache-data).

## Verification and limits

The [Terra acceptance record](testing/terra-018-acceptance.md) separates real model-backed runs from local fixtures.
The [policy evidence](research/2026-10-27-terra-defaults.md) explains the derived defaults.
The [0.17 mode acceptance record](testing/routing-modes-017-acceptance.md) describes the earlier policy.
The [earlier offline estimate](research/2026-10-21-routing-modes-impact.md) predates the new activity presets.
It does not validate their savings or answer quality.
