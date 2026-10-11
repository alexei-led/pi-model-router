import { MAX_TURN_CACHE_ENTRIES } from './constants';
import type {
  AdvisorConfig,
  ClassifierRequest,
  ClassifierResult,
  RouteCandidate,
  RoutePlan,
  RouterConfig,
  RoutingDecision,
} from './types';

interface ContinuationRecord {
  plan: RoutePlan;
  turn: string;
  policy: string;
  branch: string[];
  decision: RoutingDecision;
  toolCalls: Set<string>;
  config: RouterConfig;
}

interface AdvisedTurnRecord {
  plan: RoutePlan;
  policy: string;
  config: RouterConfig;
  decision: RoutingDecision;
}

export interface ReviewStamp {
  identity: string;
  branch: readonly string[];
  requestCount: number;
  signal?: AbortSignal | undefined;
}

interface BackgroundReview {
  identity: string;
  branch: readonly string[];
  startedAtRequest: number;
  controller: AbortController;
  result?: ClassifierResult;
}

interface ClassifierFlight {
  config: AdvisorConfig;
  promise: Promise<ClassifierResult>;
  controller: AbortController;
  waiters: number;
}

export interface ClassifierFlightLease {
  promise: Promise<ClassifierResult>;
  shared: boolean;
  release: () => void;
}

export interface ProviderTurnCache {
  continuationFor: (turn: string) => ContinuationRecord | undefined;
  deleteContinuation: (turn: string) => void;
  rememberContinuation: (record: ContinuationRecord) => void;
  hasAdvisedDecision: (turn: string) => boolean;
  deleteAdvisedDecision: (turn: string) => void;
  rememberAdvisedDecision: (
    turn: string,
    decision: RoutingDecision,
    policy: string,
    config: RouterConfig,
    plan: RoutePlan,
  ) => void;
  reusableAdvisedDecision: (
    turn: string,
    policy: string,
    config: RouterConfig,
    plans: readonly RoutePlan[],
  ) => { decision: RoutingDecision; plan: RoutePlan } | undefined;
  requestCount: (turn: string) => number;
  takeReview: (
    turn: string,
    stamp: ReviewStamp,
  ) => ClassifierResult | undefined;
  clearReviewsExcept: (turn: string | undefined) => void;
  startReview: (
    turn: string,
    stamp: ReviewStamp,
    run: (signal: AbortSignal) => Promise<ClassifierResult>,
  ) => void;
  dispose: () => void;
  startClassifier: (
    key: string,
    config: AdvisorConfig,
    request: ClassifierRequest,
    run: (request: ClassifierRequest) => Promise<ClassifierResult>,
  ) => ClassifierFlightLease;
}

export const createClassifierFlightKey = (
  turn: string,
  profile: string,
  candidates: readonly RouteCandidate[],
  config: AdvisorConfig,
  policy: string,
): string =>
  JSON.stringify({
    turn,
    profile,
    policy,
    candidates: candidates.map((candidate) => candidate.id),
    model: config.model,
    timeoutMs: config.timeoutMs,
    confidenceThreshold: config.confidenceThreshold,
    probabilityThreshold: config.probabilityThreshold,
    maxStateTokens: config.maxStateTokens,
    context: config.context,
    maxRetries: config.maxRetries,
    temperature: config.temperature,
  });

export const waitForAbortable = async <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<T>((_, reject) => {
    onAbort = () =>
      reject(
        signal.reason ??
          new DOMException('The operation was aborted.', 'AbortError'),
      );
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
};

const startClassifierFlight = (
  pending: Map<string, ClassifierFlight>,
  key: string,
  config: AdvisorConfig,
  request: ClassifierRequest,
  run: (request: ClassifierRequest) => Promise<ClassifierResult>,
): ClassifierFlightLease => {
  const existing = pending.get(key);
  const shared = existing?.config === config;
  const controller = shared ? existing.controller : new AbortController();
  const flight: ClassifierFlight = shared
    ? existing
    : {
        config,
        controller,
        waiters: 0,
        promise: run({
          ...request,
          signal: controller.signal,
        }),
      };
  flight.waiters += 1;
  pending.set(key, flight);
  const cleanup = () => {
    if (pending.get(key) === flight) pending.delete(key);
  };
  if (!shared) void flight.promise.then(cleanup, cleanup);
  return {
    promise: flight.promise,
    shared,
    release: () => {
      flight.waiters -= 1;
      if (flight.waiters === 0) {
        cleanup();
        controller.abort();
      }
    },
  };
};

export const createProviderTurnCache = (): ProviderTurnCache => {
  const continuations = new Map<string, ContinuationRecord>();
  const advisedTurns = new Map<string, AdvisedTurnRecord>();
  const pendingClassifierFlights = new Map<string, ClassifierFlight>();
  const turnRequests = new Map<string, number>();
  const reviews = new Map<string, BackgroundReview>();
  const rememberBounded = <T>(map: Map<string, T>, key: string, value: T) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > MAX_TURN_CACHE_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  return {
    continuationFor: (turn) => continuations.get(turn),
    deleteContinuation: (turn) => continuations.delete(turn),
    rememberContinuation: (record) =>
      rememberBounded(continuations, record.turn, record),
    hasAdvisedDecision: (turn) => advisedTurns.has(turn),
    deleteAdvisedDecision: (turn) => advisedTurns.delete(turn),
    rememberAdvisedDecision: (turn, decision, policy, config, plan) =>
      rememberBounded(advisedTurns, turn, { policy, config, decision, plan }),
    reusableAdvisedDecision: (turn, policy, config, plans) => {
      const record = advisedTurns.get(turn);
      if (!record) return undefined;
      const available = plans.some(
        (plan) =>
          plan.id === record.plan.id &&
          plan.attempts.some(
            (pair) =>
              pair.tier === record.decision.tier &&
              pair.model === record.decision.targetLabel &&
              pair.thinking === record.decision.thinking,
          ),
      );
      if (record.policy !== policy || record.config !== config || !available) {
        advisedTurns.delete(turn);
        return undefined;
      }
      return {
        decision: {
          ...record.decision,
          reuse: 'same-turn',
          timestamp: Date.now(),
        },
        plan: record.plan,
      };
    },
    requestCount: (turn) => {
      const count = (turnRequests.get(turn) ?? 0) + 1;
      rememberBounded(turnRequests, turn, count);
      return count;
    },
    takeReview: (turn, stamp) => {
      const review = reviews.get(turn);
      if (!review) return undefined;
      if (
        review.identity !== stamp.identity ||
        stamp.requestCount - review.startedAtRequest !== 1 ||
        review.controller.signal.aborted ||
        stamp.signal?.aborted ||
        !review.branch.length ||
        !review.branch.every((id, index) => stamp.branch[index] === id)
      ) {
        review.controller.abort();
        reviews.delete(turn);
        return undefined;
      }
      if (!review.result) return undefined;
      reviews.delete(turn);
      return review.result;
    },
    clearReviewsExcept: (turn) => {
      for (const [key, review] of reviews)
        if (key !== turn) {
          review.controller.abort();
          reviews.delete(key);
        }
    },
    startReview: (turn, stamp, run) => {
      if (stamp.signal?.aborted) return;
      const existing = reviews.get(turn);
      if (
        existing?.identity === stamp.identity &&
        existing.startedAtRequest === stamp.requestCount
      )
        return;
      existing?.controller.abort();
      const review: BackgroundReview = {
        identity: stamp.identity,
        branch: [...stamp.branch],
        startedAtRequest: stamp.requestCount,
        controller: new AbortController(),
      };
      reviews.delete(turn);
      reviews.set(turn, review);
      while (reviews.size > MAX_TURN_CACHE_ENTRIES) {
        const oldest = reviews.keys().next().value;
        if (oldest === undefined) break;
        reviews.get(oldest)?.controller.abort();
        reviews.delete(oldest);
      }
      const signal = stamp.signal
        ? AbortSignal.any([review.controller.signal, stamp.signal])
        : review.controller.signal;
      void run(signal).then(
        (result) => {
          if (reviews.get(turn) === review && !signal.aborted)
            review.result = result;
        },
        () => {
          if (reviews.get(turn) === review) reviews.delete(turn);
        },
      );
    },
    dispose: () => {
      for (const flight of pendingClassifierFlights.values())
        flight.controller.abort();
      for (const review of reviews.values()) review.controller.abort();
      pendingClassifierFlights.clear();
      reviews.clear();
      continuations.clear();
      advisedTurns.clear();
      turnRequests.clear();
    },
    startClassifier: (key, config, request, run) =>
      startClassifierFlight(
        pendingClassifierFlights,
        key,
        config,
        request,
        run,
      ),
  };
};
