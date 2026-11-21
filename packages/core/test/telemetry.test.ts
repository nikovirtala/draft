import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context, logs, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
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
import { knownEvents } from "../src/events.ts";
import { provenanceAttributes } from "../src/telemetry.ts";
import { fakeKiro, openService, RUNNING, SCRIPT } from "./fixtures.ts";

const spans = new InMemorySpanExporter();
const logRecords = new InMemoryLogRecordExporter();
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});

const PROVENANCE = {
  version: "0.0.0",
  revision: "0123456789abcdef0123456789abcdef01234567",
  repository: "https://github.com/nikovirtala/draft",
  environment: "e2e",
} as const;

beforeAll(() => {
  // The resource as the desktop app builds it: service.name plus draft's deploy provenance.
  const resource = resourceFromAttributes({
    "service.name": "draft-desktop",
    ...provenanceAttributes(PROVENANCE),
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new TracerProvider({
      resource,
      spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
    }),
  );
  logs.setGlobalLoggerProvider(
    new LoggerProvider({
      resource,
      processors: [new SimpleLogRecordProcessor({ exporter: logRecords })],
    }),
  );
  metrics.setGlobalMeterProvider(new MeterProvider({ resource, readers: [reader] }));
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
    service.onChange((c) => {
      if (c.type !== "state") return;
      for (const p of c.state.prompts) queueMicrotask(() => service.answerPrompt(p.id, true));
    });
    await service.submit(`Which sessions are open? ${SECRET_WORDS}`);
    const firstTurn = knownEvents(log.events()).slice(2);
    // A step too: its input and result must stay in the log.
    await service.submit("Please launch one");
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
    expect(firstTurn.length).toBeGreaterThan(0);
    expect(firstTurn.every((e) => e.traceId === traceId)).toBe(true);
    // The step's events carry the second turn's trace, and the step spans are in it.
    const stepEvents = knownEvents(log.events()).filter((e) => e.type.startsWith("step."));
    expect(stepEvents.map((e) => e.type)).toEqual(["step.started", "step.completed"]);
    const stepTrace = stepEvents[0]?.traceId;
    expect(
      finished
        .filter((s) => s.spanContext().traceId === stepTrace)
        .map((s) => s.attributes["draft.log.step"]),
    ).toEqual(expect.arrayContaining(["step.started", "step.completed"]));

    // No message text, tool input or result anywhere in spans, span events, logs or metrics.
    const forbidden = [
      SECRET_WORDS,
      "Which sessions are open",
      "Let me look",
      "Fix the build",
      "Write the docs",
      "limit",
      // The step's input: the prompt and repository of the launched session.
      "Fix the flaky test",
      `["nikovirtala/draft"]`,
    ];
    const texts: string[] = [];
    // Every signal carries the build's provenance, and the resource carries no content either.
    const expected = {
      "service.name": "draft-desktop",
      "service.version": "0.0.0",
      "vcs.ref.head.revision": PROVENANCE.revision,
      "vcs.repository.url.full": PROVENANCE.repository,
      "deployment.environment.name": "e2e",
    };
    for (const s of finished) expect(s.resource.attributes).toMatchObject(expected);
    for (const s of finished) texts.push(canonicalJson(s.resource.attributes));
    for (const s of finished) {
      texts.push(s.name, canonicalJson(s.attributes));
      for (const ev of s.events) texts.push(ev.name, canonicalJson(ev.attributes ?? {}));
    }
    const records = logRecords.getFinishedLogRecords();
    expect(records.some((r) => r.eventName === "draft.turn.completed")).toBe(true);
    for (const r of records) {
      expect(r.resource.attributes).toMatchObject(expected);
      texts.push(String(r.body), canonicalJson(r.attributes));
    }
    const exported = metricExporter.getMetrics();
    const names2: string[] = [];
    for (const rm of exported) expect(rm.resource.attributes).toMatchObject(expected);
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
