import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, logs, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.ts";
import { fakeKiro, openService, RUNNING, SCRIPT } from "./fixtures.ts";

const spans = new InMemorySpanExporter();
const logRecords = new InMemoryLogRecordExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: spans })] }),
  );
  logs.setGlobalLoggerProvider(
    new LoggerProvider({ processors: [new SimpleLogRecordProcessor({ exporter: logRecords })] }),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});

afterAll(() => {
  trace.disable();
  logs.disable();
  metrics.disable();
  context.disable();
});

const SECRET_WORDS = "pineapple-umbrella-9431";

describe("telemetry", () => {
  it("traces one turn from submit to the log append, and carries no content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "draft-otel-"));
    const script = structuredClone(SCRIPT);
    (script.turns[0]?.steps[2] as { text: string }).text += ` Also: ${SECRET_WORDS}-reply.`;
    const { service, log, close } = await openService(dir, fakeKiro(), script);
    await service.submit(`Which sessions are open? ${SECRET_WORDS}`);
    service.reportInvalidView("schema");
    await reader.forceFlush();

    const finished = spans.getFinishedSpans();
    const turn = finished.find((s) => s.name === "draft.turn");
    expect(turn).toBeDefined();
    const traceId = turn?.spanContext().traceId;
    // One trace per turn: submit, agent, model calls, tool calls and log appends share it.
    const names = new Set(
      finished.filter((s) => s.spanContext().traceId === traceId).map((s) => s.name),
    );
    for (const n of [
      "draft.turn",
      "draft.agent.turn",
      "draft.model.call",
      "draft.tool.call",
      "draft.log.append",
    ]) {
      expect(names).toContain(n);
    }
    // The trace ID is stamped on the turn's events.
    const turnEvents = log
      .events()
      .filter((e) => e.type !== "context.created" && e.type !== "conversation.created");
    expect(turnEvents.every((e) => e.traceId === traceId)).toBe(true);

    // No message text, tool input or result anywhere in spans, span events, logs or metrics.
    const forbidden = [
      SECRET_WORDS,
      "Which sessions are open",
      "Let me look",
      "Fix the build",
      "Write the docs",
      "limit",
    ];
    const texts: string[] = [];
    for (const s of finished) {
      texts.push(s.name, canonicalJson(s.attributes));
      for (const ev of s.events) texts.push(ev.name, canonicalJson(ev.attributes ?? {}));
    }
    const records = logRecords.getFinishedLogRecords();
    expect(records.some((r) => r.eventName === "draft.turn.completed")).toBe(true);
    for (const r of records) texts.push(String(r.body), canonicalJson(r.attributes));
    const exported = metricExporter.getMetrics();
    const names2: string[] = [];
    for (const rm of exported)
      for (const sm of rm.scopeMetrics)
        for (const m of sm.metrics) {
          names2.push(m.descriptor.name);
          for (const dp of m.dataPoints) texts.push(canonicalJson(dp.attributes));
        }
    for (const t of texts) for (const f of forbidden) expect(t).not.toContain(f);

    for (const n of [
      "draft.turns",
      "draft.tool_calls",
      "draft.step.duration",
      "draft.turn.tokens",
      "draft.resolver.polls",
      "draft.view.invalid",
    ]) {
      expect(names2).toContain(n);
    }
    // Session ids are IDs, not content, but they still shouldn't leak: references aren't attributes.
    for (const t of texts) expect(t).not.toContain(RUNNING);
    close();
  });
});
