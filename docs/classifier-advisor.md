# Classifier advisor

The router can use any text-capable classifier model exposed by Pi's model registry. This includes built-in models, classifiers from Pi provider extensions, and configured custom classifier models. The router does not maintain its own provider list or convert provider-specific APIs.

## Configure a model

Configure and authenticate the model in Pi first. The model reference is its exact `provider/model-id` from Pi's classifier catalog. For example, Pi 1.1.0 includes `openai/gpt-6-luna` (OpenAI API key), built-in TypeSafe and Cloudflare classifiers, and llama.cpp decision models when the connected server supports them. New provider classifiers work without router code changes.

Enable the advisor in **user** `~/.pi/agent/model-router.json`, then approve that exact reference per profile:

```json
{
  "advisor": {
    "enabled": true,
    "model": "openai/gpt-6-luna",
    "timeoutMs": 10000,
    "reviewEveryRequests": 4,
    "confidenceThreshold": 0.65,
    "probabilityThreshold": 0.8,
    "maxStateTokens": 3000,
    "maxRetries": 1
  },
  "profiles": {
    "personal": {
      "advisor": {
        "models": ["openai/gpt-6-luna"]
      },
      "high": { "model": "openai/gpt-6-luna" },
      "medium": { "model": "anthropic/claude-haiku-5-5" },
      "low": { "model": "llama.cpp/qwen3-coder" }
    },
    "work": {
      "advisor": { "models": [] },
      "high": { "model": "anthropic/claude-sonnet-4-5" },
      "medium": { "model": "anthropic/claude-haiku-5-5" }
    }
  }
}
```

Replace the generation model references with models available in your Pi setup. `advisor.models` accepts canonical references only; aliases are not accepted. Approval applies only to the exact provider and model ID. Changing the advisor model does not grant profile approval. Project configuration cannot enable the advisor, change its model, or add profile approvals.

Set `advisor.enabled` to `false` to disable classification. If the reference is not registered, has no text input, is not approved by the active profile, or Pi cannot authenticate it, the router uses the local baseline. It does not invoke a second classifier.

Pi resolves credentials and executes the classifier API. This supports Pi classifiers whose implementations use multiple HTTP requests, local services, custom APIs, or provider-specific authentication. It does not treat a catalog entry as proof that authentication will succeed; Pi reports that at request time.

## Bounds and selection

The default deadline is 10 seconds and covers local context preparation plus classification. Caller cancellation aborts the operation and does not start generation. Pi retries according to `advisor.maxRetries` (default 1 retry), within the same total router deadline.

An initial user request makes one approved `modelRegistry.classify()` operation and awaits it. On valid tool continuations, the router can make a separate background review every `advisor.reviewEveryRequests` requests (default 4; 0 disables). It never waits for that review before generation. A completed review is eligible only on the immediately following request; otherwise it expires. Session/branch/turn/config/policy/matrix changes invalidate it. Failed, uncertain or stale reviews keep the eligible incumbent instead of resetting a running task to the baseline.

Both initial choices and reviews use one approved `modelRegistry.classify()` operation. Normally it
asks the existing typed `route` choice among eligible tier representatives and
`uncertain`. With activity routing on and meaningful eligible specialization
plans, it also asks a separate typed `activity` choice. These are independent
answers in the same operation, not a multiplied joint distribution or a second
advisor call. Pi may implement the operation using several bounded HTTP requests.

Tier selection keeps the existing rule: accept the top candidate at or above
`confidenceThreshold`; otherwise choose the lowest tier whose cumulative
probability reaches `probabilityThreshold`, counting abstention mass at the local
baseline tier. Activity needs a valid choice/distribution and confidence at or
above `confidenceThreshold`; it never uses the cumulative tier rule.

A valid activity resolves the chosen tier's current prevalidated cell, or its
generic plan if there is no eligible specialization. Missing, malformed,
low-confidence or `uncertain` activity keeps valid tier advice but uses that tier's
generic plan; if it is unavailable, use the deterministic eligible baseline.
Invalid tier advice or a whole classifier error goes directly to baseline, never
to another advisor. Representative IDs cannot themselves authorize a physical
target. Generation revalidates each attempt in the selected cell's immutable plan.

One tier with distinct activity plans asks only `activity`. One effective plan
bypasses advice. Off/no meaningful overrides preserve the old route-only request
and selection behavior. An effort override that erases activity differences also
removes the activity question.

A profile pin and soft-budget policy bypass advice. One effective plan bypasses advice. Tool continuations reuse a valid route unless an eligible background review is ready at the next request. The advisor cannot introduce a route or change generation permissions.

## Privacy

A classifier call sends the current user goal plus bounded recent assistant text and permitted text tool results, including the current tool loop, and configured previous dialogue. `advisor.context.currentLoopMessages` bounds current-loop messages (default 8). `toolResults`, history limits and token limits further bound what is sent. The extension excludes system prompts, tool definitions, thinking, tool arguments, image/binary blocks, and raw router configuration. Text filtering is **not redaction**; selected conversation text can contain private information.

Classifier models that accept images are supported by Pi, but the router does not attach transcript images to classification requests. Use explicit user/profile configuration to control whether the router sends text to an external classifier.

The router retains allowlisted local model identity, numeric usage/cost diagnostics, and route-selection results. It discards provider error text and classifier explanations. Pi remains responsible for authentication and model execution.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Classifier unavailable → baseline` | Confirm the exact classifier reference appears in Pi's registry and is approved in the active user's profile. |
| Authentication or API error | Sign in or configure the API key in Pi; do not put credentials in router configuration. |
| Timeout | Raise `advisor.timeoutMs` within the Node timer range, or use a faster configured classifier. |
| Model does not appear in Settings | Configure/register it in Pi first. The router lists registered classifier models only. |
| Image classification was expected | The router intentionally sends text only. |

Pi 1.1.0 classifier model reference: [Use classifier models](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md#use-classifier-models).
