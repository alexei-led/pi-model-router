import { randomUUID } from 'node:crypto';
import {
  buildChoicePayload,
  parseAdvice,
  selectRoute,
  validCandidates,
} from './choice';
import { normalizeAdvisorConfig } from './config';
import { MAX_CLASSIFIER_ESTIMATED_REQUEST_TOKENS } from './constants';
import {
  buildClassifierContext,
  estimateClassifierRequestTokens,
} from './context';
import { parseCanonicalModelRef } from './domain';
import type {
  AdvisorConfig,
  ClassifierDependencies,
  ClassifierDiagnostics,
  ClassifierOutcome,
  ClassifierRegistry,
  ClassifierRequest,
  ClassifierResult,
} from './types';

const MAX_RESPONSE_BYTES = 65536;

const readResponse = async (
  response: Response,
  signal: AbortSignal,
): Promise<unknown> => {
  if (!response.body) return undefined;
  signal.throwIfAborted();
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return undefined;
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
};

/** Pi resolves classifier implementations and auth; the router bounds and validates advice. */
export const runClassifierDetailed = async (
  rawConfig: AdvisorConfig | undefined,
  request: ClassifierRequest,
  registry: ClassifierRegistry,
  dependencies: ClassifierDependencies = {},
): Promise<ClassifierResult> => {
  const now = dependencies.now ?? (() => performance.now());
  const start = now();
  let metrics: Omit<ClassifierDiagnostics, 'outcome' | 'latencyMs'> = {
    startedAt: Date.now(),
  };
  const result = (
    outcome: ClassifierOutcome,
    advice?: ClassifierResult['advice'],
  ): ClassifierResult => ({
    ...(advice ? { advice } : {}),
    diagnostics: { ...metrics, outcome, latencyMs: Math.max(0, now() - start) },
  });
  const controller = new AbortController();
  let failure: ClassifierOutcome = 'network-error';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    failure = 'cancelled';
    controller.abort();
  };
  try {
    if (request.signal?.aborted) return result('cancelled');
    const config = normalizeAdvisorConfig(rawConfig, []);
    if (
      !config?.enabled ||
      !request.profile?.models.includes(config.model) ||
      !request.context ||
      !Array.isArray(request.context.messages) ||
      !validCandidates(request.candidates)
    )
      return result('unavailable');
    const deadline = Math.min(
      request.routingDeadline,
      start + config.timeoutMs,
    );
    if (!Number.isFinite(deadline) || deadline <= now())
      return result('deadline');
    const { provider, modelId } = parseCanonicalModelRef(config.model);
    const model = registry.findOfType('classifier', provider, modelId);
    if (
      model?.type !== 'classifier' ||
      model.provider !== provider ||
      model.id !== modelId ||
      !model.input.includes('text')
    )
      return result('unavailable');
    const selectedContext = buildClassifierContext(
      request.context,
      config.maxStateTokens,
      config.context,
    );
    const context = buildChoicePayload(
      selectedContext.state,
      request.candidates,
    );
    metrics = {
      ...metrics,
      model: config.model,
      timeoutMs: config.timeoutMs,
      threshold: config.confidenceThreshold,
      probabilityThreshold: config.probabilityThreshold,
      candidateCount: request.candidates.length,
      context: selectedContext.metrics,
      estimatedInputTokens: estimateClassifierRequestTokens(
        JSON.stringify(context),
      ),
    };
    if (
      (metrics.estimatedInputTokens ?? 0) >
        MAX_CLASSIFIER_ESTIMATED_REQUEST_TOKENS ||
      (model.contextWindow > 0 &&
        (metrics.estimatedInputTokens ?? 0) > model.contextWindow)
    )
      return result('input-too-large');
    const remaining = deadline - now();
    if (remaining <= 0) return result('deadline');
    const stopped = new Promise<ClassifierResult>((resolve) =>
      controller.signal.addEventListener(
        'abort',
        () => resolve(result(failure)),
        { once: true },
      ),
    );
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) abort();
    timer = setTimeout(() => {
      failure = 'deadline';
      controller.abort();
    }, remaining);
    const boundedFetch: typeof fetch = async (input, init) => {
      controller.signal.throwIfAborted();
      metrics.attempts = (metrics.attempts ?? 0) + 1;
      const signal = init?.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal;
      const response = await (dependencies.fetch ?? fetch)(input, {
        ...init,
        signal,
        redirect: 'error',
      });
      metrics.httpStatus = response.status;
      if (!response.ok) {
        // Keep status/retry headers, never pass secret-bearing error bodies into Pi diagnostics.
        void response.body?.cancel().catch(() => undefined);
        failure = 'http-error';
        return new Response(null, {
          status: response.status,
          headers: response.headers,
        });
      }
      failure = 'invalid-response';
      const raw = await readResponse(response, signal);
      controller.signal.throwIfAborted();
      return new Response(JSON.stringify(raw ?? null), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const work = async (): Promise<ClassifierResult> => {
      metrics.requestId = randomUUID();
      metrics.attempts = 0;
      const classified = await registry.classify(model, context, {
        signal: controller.signal,
        maxRetries: config.maxRetries,
        fetch: boundedFetch,
        ...(config.temperature !== undefined
          ? { temperature: config.temperature }
          : {}),
      });
      if (controller.signal.aborted) return result(failure);
      if (now() >= deadline) return result('deadline');
      for (const [field, tokens] of [
        ['actualInputTokens', classified.usage?.input],
        ['actualOutputTokens', classified.usage?.output],
      ] as const)
        if (
          typeof tokens === 'number' &&
          Number.isSafeInteger(tokens) &&
          tokens >= 0
        )
          metrics[field] = tokens;
      const cost = classified.usage?.cost.total;
      if (
        typeof cost === 'number' &&
        Number.isFinite(cost) &&
        cost >= 0 &&
        (cost > 0 || model.cost.input > 0 || model.cost.output > 0)
      )
        metrics.costUsd = cost;
      if (classified.stopReason !== 'stop')
        return result(
          classified.stopReason === 'aborted'
            ? 'cancelled'
            : metrics.attempts
              ? failure
              : 'unavailable',
        );
      const parsed = parseAdvice(classified, request.candidates);
      if (typeof parsed === 'string') {
        metrics.responseIssue = parsed;
        return result('invalid-response');
      }
      metrics.choice = parsed.candidate?.tier ?? 'uncertain';
      metrics.confidence = parsed.confidence;
      metrics.probability = parsed.probability;
      const selected = selectRoute(
        parsed,
        request.candidates,
        request.baselineTier,
        config,
      );
      if (!selected) return result('uncertain');
      metrics.selectedTier = selected.candidate.tier;
      metrics.selectionBasis = selected.basis;
      metrics.routeProbability = selected.routeProbability;
      return result('selected', {
        candidateId: selected.candidate.id,
        confidence: parsed.confidence,
        latencyMs: Math.max(0, now() - start),
      });
    };
    return await Promise.race([work(), stopped]);
  } catch {
    return result(failure);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    controller.abort();
  }
};
