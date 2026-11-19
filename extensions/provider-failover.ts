import type { Api, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { RouterConfig } from './types';

const MINUTE = 60_000;
const MAX_HOLDS = 128;

type Failure =
  | { kind: 'request' | 'unknown' }
  | {
      kind: 'capacity' | 'quota' | 'billing';
      retryAt?: number | undefined;
      shared?: boolean;
      modelRetryAt?: number | undefined;
    };

interface Evidence {
  status: number;
  retryAt: number | undefined;
  planRejected: boolean;
  sharedWindow: boolean;
  modelReset: number | undefined;
  planReset: number | undefined;
}

interface Hold {
  scope: string;
  kind: 'capacity' | 'quota' | 'billing';
  until: number;
  resetKnown: boolean;
  streak: number;
}

const future = (time: number, now: number): number | undefined =>
  Number.isSafeInteger(time) &&
  time > now &&
  time <= now + 366 * 24 * 60 * MINUTE
    ? time
    : undefined;

const retryAfter = (value: string | null, now: number) => {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return future(now + Number(value) * 1000, now);
  return /^[A-Za-z]{3}, /.test(value)
    ? future(Date.parse(value), now)
    : undefined;
};

const anthropicReset = (value: string | null, now: number) =>
  value && /^\d{10}$/.test(value)
    ? future(Number(value) * 1000, now)
    : undefined;

const capture = (
  api: Api,
  status: number,
  get: (name: string) => string | null,
): Evidence => {
  const now = Date.now();
  const retryAt = retryAfter(get('retry-after'), now);
  const prefix = 'anthropic-ratelimit-unified-';
  const planRejected =
    api === 'anthropic-messages' &&
    status === 429 &&
    get(`${prefix}status`) === 'rejected' &&
    get(`${prefix}overage-status`) !== 'allowed';
  if (!planRejected)
    return {
      status,
      retryAt,
      planRejected,
      sharedWindow: false,
      modelReset: undefined,
      planReset: undefined,
    };

  const claim = get(`${prefix}representative-claim`);
  const sharedClaim = claim === 'five_hour' || claim === 'seven_day';
  const windows = ['5h', '7d'].filter(
    (window) => get(`${prefix}${window}-status`) === 'rejected',
  );
  const resets = windows.flatMap(
    (window) => anthropicReset(get(`${prefix}${window}-reset`), now) ?? [],
  );
  const sharedWindow = sharedClaim || windows.length > 0;
  const reset = anthropicReset(get(`${prefix}reset`), now);
  if ((sharedClaim || !sharedWindow) && reset !== undefined) resets.push(reset);
  return {
    status,
    retryAt,
    planRejected,
    sharedWindow,
    modelReset:
      sharedWindow && claim?.startsWith('seven_day_')
        ? (reset ?? retryAt)
        : undefined,
    planReset: Math.max(0, ...resets) || undefined,
  };
};

const fetchCapable = (api: Api) =>
  api === 'anthropic-messages' ||
  api === 'openai-responses' ||
  api === 'openai-completions' ||
  api === 'openai-codex-responses';

const classify = (evidence: Evidence | undefined, error: unknown): Failure => {
  const message = (
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  ).slice(0, 2048);
  const textStatus = /^(?:[\w -]+ API error\s+\()?([45]\d\d)(?:[): ]|$)/i.exec(
    message,
  )?.[1];
  const status =
    evidence && evidence.status >= 400 ? evidence.status : Number(textStatus);
  const retryAt = evidence?.retryAt;
  if (evidence?.planRejected) {
    const { planReset, modelReset, sharedWindow } = evidence;
    return {
      kind: 'quota',
      shared: sharedWindow,
      retryAt:
        Math.max(planReset ?? 0, modelReset ? 0 : (retryAt ?? 0)) || undefined,
      // Keep the longer model-specific deadline without extending the group hold.
      ...(modelReset
        ? { modelRetryAt: Math.max(modelReset, retryAt ?? 0) }
        : {}),
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    status === 400 ||
    status === 422 ||
    /"type"\s*:\s*"(?:authentication_error|permission_error|invalid_request_error)"/.test(
      message,
    )
  )
    return { kind: 'request' };
  if (
    (status === 429 || status === 402) &&
    /"(?:code|type)"\s*:\s*"(?:billing_hard_limit_reached|credit_balance_too_low)"/.test(
      message,
    )
  )
    return { kind: 'billing', shared: true };
  if (
    status === 429 &&
    /"(?:code|type)"\s*:\s*"(?:subscription_sharing_usage_limit_exceeded|subscription_sharing_workplace_individual_usage_limit_exceeded)"/.test(
      message,
    )
  )
    return { kind: 'quota', retryAt, shared: true };
  if (
    status === 429 ||
    (status >= 500 && status <= 599) ||
    /"type"\s*:\s*"(?:rate_limit_error|overloaded_error|api_error)"/.test(
      message,
    )
  )
    return { kind: 'capacity', retryAt };
  return { kind: 'unknown' };
};

export const observeDelegateFailure = (
  api: Api,
  options: SimpleStreamOptions,
) => {
  let evidence: Evidence | undefined;
  return {
    options: {
      ...options,
      onResponse: (response, model) => {
        evidence = capture(
          api,
          response.status,
          (name) =>
            Object.entries(response.headers).find(
              ([header]) => header.toLowerCase() === name,
            )?.[1] ?? null,
        );
        return options.onResponse?.(response, model);
      },
      // Some SDK adapters throw on HTTP errors before invoking onResponse.
      ...(fetchCapable(api)
        ? {
            fetch: async (resource, init) => {
              const response = await (options.fetch ?? globalThis.fetch)(
                resource,
                init,
              );
              evidence = capture(api, response.status, (name) =>
                response.headers.get(name),
              );
              return response;
            },
          }
        : {}),
    } satisfies SimpleStreamOptions,
    classify: (error: unknown) => classify(evidence, error),
  };
};

const quotaGroupFor = (config: RouterConfig, model: string) => {
  const groups = new Set(
    Object.values(config.models ?? {}).flatMap((entry) =>
      entry.model === model && entry.quotaGroup ? [entry.quotaGroup] : [],
    ),
  );
  return groups.size === 1 ? groups.values().next().value : undefined;
};

export const describeHold = (hold: Hold): string => {
  if (hold.kind === 'billing')
    return 'billing blocked; reload after resolving it';
  const time = new Date(hold.until).toISOString();
  if (hold.kind === 'capacity') return `cooling down until ${time}`;
  return hold.resetKnown
    ? `plan limit until ${time}`
    : `reset unknown; recheck after ${time}`;
};

const modelKey = (ref: string) => `model:${ref}`;
const groupKey = (group: string) => `quota:${group}`;
const later = (first: Hold | undefined, second: Hold | undefined) =>
  first && (!second || first.until >= second.until) ? first : second;

export const createProviderHolds = (now = Date.now) => {
  const holds = new Map<string, Hold>();
  const active = (key: string) => {
    const hold = holds.get(key);
    return hold && hold.until > now() ? hold : undefined;
  };
  const write = (key: string, hold: Hold, time: number) => {
    const running = holds.get(key);
    if (running && running.until > time && running.until >= hold.until)
      return running;
    holds.delete(key);
    holds.set(key, hold);
    const oldest = holds.keys().next().value;
    if (holds.size > MAX_HOLDS && oldest !== undefined) holds.delete(oldest);
    return hold;
  };
  return {
    lookup: (config: RouterConfig, ref: string) => {
      const group = quotaGroupFor(config, ref);
      return later(
        active(modelKey(ref)),
        group ? active(groupKey(group)) : undefined,
      );
    },
    success: (ref: string, startedAt: number) => {
      const key = modelKey(ref);
      const hold = holds.get(key);
      if (hold && hold.until <= startedAt) holds.delete(key);
    },
    record: (config: RouterConfig, ref: string, failure: Failure) => {
      const { kind } = failure;
      if (kind === 'request' || kind === 'unknown') return undefined;
      const group =
        'shared' in failure && failure.shared
          ? quotaGroupFor(config, ref)
          : undefined;
      const key = group ? groupKey(group) : modelKey(ref);
      const running = holds.get(key);
      const time = now();
      const streak =
        kind === 'capacity' && running?.kind === kind
          ? Math.min(running.streak + Number(running.until <= time), 5)
          : 1;
      const retryAt = 'retryAt' in failure ? failure.retryAt : undefined;
      const delay =
        kind === 'capacity'
          ? Math.min(15_000 * 2 ** (streak - 1), 3 * MINUTE)
          : 15 * MINUTE;
      const until = kind === 'billing' ? Infinity : (retryAt ?? time + delay);
      const hold = write(
        key,
        {
          scope: group ?? ref,
          kind,
          until,
          resetKnown: retryAt !== undefined,
          streak,
        },
        time,
      );
      const modelRetryAt =
        'modelRetryAt' in failure ? failure.modelRetryAt : undefined;
      if (modelRetryAt !== undefined && modelRetryAt > time)
        write(
          modelKey(ref),
          { scope: ref, kind, until: modelRetryAt, resetKnown: true, streak },
          time,
        );
      return hold;
    },
  };
};

export type ProviderHolds = ReturnType<typeof createProviderHolds>;
