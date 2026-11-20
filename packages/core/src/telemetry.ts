import {
  type Attributes,
  logs,
  metrics,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

/**
 * draft's telemetry: traces, metrics and logs through the OpenTelemetry API. Providers and
 * exporters are set up by the host (the desktop main process); without them every call is a no-op.
 *
 * Rule: telemetry carries IDs and numbers, never content. Attribute values here are addresses,
 * event ids, tool names, decisions, outcomes, counts, tokens and durations. Message text, tool
 * inputs and results stay in the log.
 */

export const INSTRUMENTATION = "@nikovirtala/draft-core";

export const tracer = () => trace.getTracer(INSTRUMENTATION);
export const logger = () => logs.getLogger(INSTRUMENTATION);

export interface DraftMetrics {
  turns: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  toolCalls: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  stepDuration: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
  turnTokens: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]>;
  resolverPolls: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  resolverFailures: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  invalidViews: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
}

let cached: { meter: unknown; m: DraftMetrics } | null = null;

/** The instruments, created on the current global meter provider. */
export function draftMetrics(): DraftMetrics {
  const meter = metrics.getMeter(INSTRUMENTATION);
  if (cached !== null && cached.meter === meter) return cached.m;
  const m: DraftMetrics = {
    turns: meter.createCounter("draft.turns", { description: "Conversation turns" }),
    toolCalls: meter.createCounter("draft.tool_calls", { description: "Agent tool calls" }),
    stepDuration: meter.createHistogram("draft.step.duration", {
      description: "Latency of one step of a turn or poll",
      unit: "ms",
    }),
    turnTokens: meter.createHistogram("draft.turn.tokens", {
      description: "Model tokens per turn, from the Agent SDK's usage",
      unit: "{token}",
    }),
    resolverPolls: meter.createCounter("draft.resolver.polls", { description: "Resolver polls" }),
    resolverFailures: meter.createCounter("draft.resolver.failures", {
      description: "Failed resolver polls",
    }),
    invalidViews: meter.createCounter("draft.view.invalid", {
      description: "View descriptions that failed validation and fell back to plain text",
    }),
  };
  cached = { meter, m };
  return m;
}

/** Ends a span with an error status, recording only the error's class, never its message. */
export function failSpan(span: Span, err: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute("error.type", err instanceof Error ? err.name : typeof err);
}

/** Emits a log record whose body is a fixed event name and whose attributes are IDs and numbers. */
export function logEvent(name: string, attributes: Attributes): void {
  logger().emit({ eventName: name, body: name, attributes });
}
