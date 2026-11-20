import { appendFileSync } from "node:fs";
import { DRAFT_VERSION } from "@nikovirtala/draft-core";
import { context, logs, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  type LogRecordExporter,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
  TracerProvider,
} from "@opentelemetry/sdk-trace";

/** Writes finished spans as JSON lines; DRAFT_SPAN_FILE turns it on (used for test evidence). */
export class JsonFileSpanExporter implements SpanExporter {
  constructor(private readonly path: string) {}
  export(
    spans: Parameters<SpanExporter["export"]>[0],
    done: Parameters<SpanExporter["export"]>[1],
  ): void {
    const lines = spans.map((s) =>
      JSON.stringify({
        name: s.name,
        traceId: s.spanContext().traceId,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId ?? null,
        durationMs: Math.round((s.duration[0] * 1e9 + s.duration[1]) / 1e5) / 10,
        attributes: s.attributes,
      }),
    );
    appendFileSync(this.path, lines.map((l) => `${l}\n`).join(""));
    done({ code: 0 });
  }
  async shutdown(): Promise<void> {}
}

export interface TelemetryOptions {
  env?: NodeJS.ProcessEnv;
  /** Extra exporters, e.g. a file exporter for the end-to-end evidence. */
  spanExporters?: SpanExporter[];
}

/**
 * OpenTelemetry in the main process: OTLP over HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (the exporters read the standard OTEL_* variables), the console otherwise.
 */
export function startTelemetry(o: TelemetryOptions = {}): {
  shutdown(): Promise<void>;
  mode: "otlp" | "console" | "off";
} {
  const env = o.env ?? process.env;
  if (env.OTEL_SDK_DISABLED === "true") return { shutdown: async () => {}, mode: "off" };
  const otlp = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "") !== "";
  const resource = resourceFromAttributes({
    "service.name": env.OTEL_SERVICE_NAME ?? "draft-desktop",
    "service.version": DRAFT_VERSION,
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const spanExporter: SpanExporter = otlp ? new OTLPTraceExporter() : new ConsoleSpanExporter();
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      otlp
        ? new BatchSpanProcessor({ exporter: spanExporter })
        : new SimpleSpanProcessor({ exporter: spanExporter }),
      ...(o.spanExporters ?? []).map((exporter) => new SimpleSpanProcessor({ exporter })),
    ],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const metricExporter: PushMetricExporter = otlp
    ? new OTLPMetricExporter()
    : new ConsoleMetricExporter();
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: otlp ? 15_000 : 60_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  const logExporter: LogRecordExporter = otlp
    ? new OTLPLogExporter()
    : new ConsoleLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      otlp
        ? new BatchLogRecordProcessor({ exporter: logExporter })
        : new SimpleLogRecordProcessor({ exporter: logExporter }),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  return {
    mode: otlp ? "otlp" : "console",
    async shutdown() {
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
}
