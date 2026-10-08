import { MAX_TURN_CACHE_ENTRIES } from './constants';
import type {
  AdvisorConfig,
  ClassifierRequest,
  ClassifierResult,
  RouteCandidate,
  RoutePair,
  RouterConfig,
  RoutingDecision,
} from './types';

interface ContinuationRecord {
  turn: string;
  policy: string;
  branch: string[];
  decision: RoutingDecision;
  toolCalls: Set<string>;
  config: RouterConfig;
}

interface AdvisedTurnRecord {
  policy: string;
  config: RouterConfig;
  decision: RoutingDecision;
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
  ) => void;
  reusableAdvisedDecision: (
    turn: string,
    policy: string,
    config: RouterConfig,
    pairs: readonly RoutePair[],
  ) => RoutingDecision | undefined;
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
    rememberAdvisedDecision: (turn, decision, policy, config) =>
      rememberBounded(advisedTurns, turn, { policy, config, decision }),
    reusableAdvisedDecision: (turn, policy, config, pairs) => {
      const record = advisedTurns.get(turn);
      if (!record) return undefined;
      const available = pairs.some(
        (pair) =>
          pair.tier === record.decision.tier &&
          pair.model === record.decision.targetLabel &&
          pair.thinking === record.decision.thinking,
      );
      if (record.policy !== policy || record.config !== config || !available) {
        advisedTurns.delete(turn);
        return undefined;
      }
      return { ...record.decision, reuse: 'same-turn', timestamp: Date.now() };
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
