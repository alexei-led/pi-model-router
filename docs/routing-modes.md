# Routing modes

**Activity says what the work is. Tier says how demanding it is. Mode adjusts the preferred model and effort.**

Keep `balanced` for normal use. Choose `cost` when you accept a cheaper starting route.
Choose `quality` when you want more reasoning before execution.
These names describe policy, not measured quality or a spending guarantee.

| Mode | Preferred route |
| --- | --- |
| `cost` | Use the next lower tier's model when its input price is lower and its context fits. Otherwise lower effort one step, not below `low`. |
| `balanced` | Keep the configured activity pair. This is the default. |
| `quality` | Raise effort one step. If no higher supported effort exists, try the next tier's route. Do not reach `high` over budget. |

`micro` is unchanged by modes. A pin uses its generic configured tier and bypasses the mode.
A tier-wide effort override also bypasses that tier's mode transform.
Missing or zero prices do not prove that another model is cheaper.

For example, with the built-in OpenAI preset, `medium + debug` prefers:

```text
cost      → gpt-6-luna / high
balanced  → gpt-6.1-sol / high
quality   → gpt-6.1-sol / xhigh
```

This example requires a configured lower tier, available targets and fitting context.
A partial profile without that lower tier uses the effort step instead.
The [complete generated mode table](mode-preferences.md) covers all 56 preset cells.
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
For example, `high + ops` can prefer Haiku/high instead of its balanced Opus/high pair.
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

| Mode | `costSensitivity` | `escalationHoldTurns` |
| --- | ---: | ---: |
| `cost` | 0.8 | 1 |
| `balanced` | configured | configured |
| `quality` | 0.2 | 4 |

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

The [mode acceptance record](testing/routing-modes-017-acceptance.md) separates real model-backed runs from local fixtures.
The [earlier offline estimate](research/2026-10-21-routing-modes-impact.md) predates the new activity presets.
It does not validate their savings or answer quality.
