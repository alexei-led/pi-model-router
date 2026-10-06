# Cloudflare advisors

Clef and Clef Flash are optional structured choice advisors. They choose among
the same eligible model/effort candidates as Jev. They do not generate the final
answer, grant tool permissions, or change the local routing policy.

## Configure

Run `/login cloudflare-workers-ai` in your normal Pi session. Alternatively,
use `/login` → **Sign in with an API key** → **Cloudflare Workers AI**.
Pi asks for the API token and Account ID. This provider is not in the OAuth/account list.
You can instead supply `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID`
before starting Pi. No router-extension update is needed for authentication.
The router does not store these credentials or inspect Pi's authentication files.

Add the following fields to your **user** `model-router.json`. Merge the
profile flag into an existing profile with at least two eligible tiers:

```json
{
  "advisor": "clef-flash",
  "cloudflare": {
    "enabled": true,
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
    "auto": { "cloudflare": { "enabled": true } }
  }
}
```

This is a partial configuration, not a standalone profile. Then run
`/router reload` and select that profile.

| Selection | Pi classifier model |
| --- | --- |
| `jev` (default) | TypeSafe via Pi; preserves the configured Jev model pin |
| `clef` | `cloudflare-workers-ai/@cf/cloudflare/clef` |
| `clef-flash` | `cloudflare-workers-ai/@cf/cloudflare/clef-flash` |

The current chat-based `classifierModel` remains a compatibility path when the
default Jev path is selected and Jev is inactive. It is not a way to configure
Clef. Explicit Cloudflare selection never falls through to that chat classifier
or to Jev.

## Privacy

Selection, user enablement and profile approval are separate.
Existing Jev approval does **not** approve Cloudflare.
The inspector may change selection, but never enables consent or edits a key.

All project-level `advisor`, `cloudflare`, and profile `cloudflare` settings
are ignored. A project-added profile cannot inherit approval from another one.

Bounded recent text can include private dialogue and tool output. The adapter
excludes system prompts, raw config, thinking, tool arguments and binary blocks.
This filtering is not redaction. The router sends no images to Clef.

## Bounds and failure behavior

- One candidate per eligible tier, with strict candidate/confidence/distribution
  validation and the existing [acceptance policy](jev-advisor.md#acceptance-policy).
- One absolute deadline covers preparation, authentication, HTTP and response
  reading. `timeoutMs` defaults to 1500 and must be positive, finite and within
  Node's timer range. No product-level timeout cap.
- Success responses are limited to 65,536 bytes. Remote error bodies are discarded.
- `retry.maxAttempts` is 1 or 2 total attempts. Native Pi retries are disabled.
  Only the adapter's transient HTTP statuses (408, 429 and 5xx) qualify;
  backoff and Retry-After must fit the same deadline.
- Timeout, missing approval/authentication, abstention or invalid advice selects
  the eligible baseline. No second advisor is called.
- Caller cancellation stops the request without baseline generation.
- Validated same-turn tool routes are reused without another advisor call.
- Reported generation costs and the soft generation budget exclude advisor fees.
  An absent/zero catalog price does not prove a free request.

## Diagnostics

Use `/router`, `/router log`, or `/router-ui classifier`.
The route and status use Clef/Clef Flash labels, not Jev labels.
The inspector displays authorization facts but does not claim backend-login
attestation; authentication can remain unknown until dispatch.

| Outcome | Check |
| --- | --- |
| `unavailable` | User enablement, active-profile approval and the Pi classifier catalog |
| HTTP 401 / auth failure | Pi Cloudflare login or environment, without copying keys into router config |
| `deadline` | Total advisory deadline; increase only if the added latency is acceptable |
| `invalid-response` | Strict response validation and provider compatibility |
| Baseline every turn | Pin, budget, one eligible tier, missing consent, or a failed advisor |

Pi 1.0.2 contains both native classifier transports. Jev and Cloudflare share
the router's bounded transport and strict validation in `choice.ts`.
The router supplies the
required inner model selector through its public payload hook and bounds the
public fetch path. Request/response contracts are covered by synthetic fixtures.

A bounded live smoke test on 6 October 2026 used this adapter through actual
Pi's normal registry/authentication: one request each to Clef and Clef Flash.
Both returned HTTP 200 and passed strict candidate/distribution validation.
The smoke used a 10-second deadline with retries disabled; production's default
remains 1500 ms. Two requests establish sampled wire compatibility, not routing
quality or a latency guarantee. See [acceptance evidence](testing/router-ui-agterm-acceptance.md).

Provider references: [Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
and [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/).
