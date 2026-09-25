import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { RpcCallError } from "alchemy/Rpc";
import { RuntimeBuildFailed } from "@executor-js/sdk/core";
import { collectTelemetry } from "@executor-js/telemetry";
import { observeCompilerPreparation } from "../src/implementation/compiler-preparation-observation.ts";

const privateValue = "private-env-source-credential-sentinel";
const attributes = Schema.Array(
  Schema.Struct({ key: Schema.String, value: Schema.Record(Schema.String, Schema.Json) }),
);
const Trace = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.Array(
      Schema.Struct({
        scopeSpans: Schema.Array(
          Schema.Struct({
            spans: Schema.Array(
              Schema.Struct({
                name: Schema.String,
                traceId: Schema.String,
                spanId: Schema.String,
                attributes,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
const Logs = Schema.fromJsonString(
  Schema.Struct({
    resourceLogs: Schema.Array(
      Schema.Struct({
        scopeLogs: Schema.Array(
          Schema.Struct({ logRecords: Schema.Array(Schema.Struct({ attributes })) }),
        ),
      }),
    ),
  }),
);

const cases = [
  {
    name: "untrusted name and tag",
    phase: "schedule" as const,
    work: Effect.fail({ _tag: privateValue, name: privateValue, message: privateValue }),
    errorType: "UnhandledFailure",
    code: "unclassified",
    outcome: "failure",
    stage: undefined,
  },
  {
    name: "RPC",
    phase: "prepare" as const,
    work: Effect.fail(
      new RpcCallError({ method: privateValue, cause: new TypeError(privateValue) }),
    ),
    errorType: "RpcCallError",
    code: "rpc_call",
    outcome: "failure",
    stage: undefined,
  },
  {
    name: "build",
    phase: "prepare" as const,
    work: Effect.fail(new RuntimeBuildFailed({ stage: "dependencies", dependency: privateValue })),
    errorType: "RuntimeBuildFailed",
    code: "build",
    outcome: "failure",
    stage: "dependencies",
  },
  {
    name: "scheduler",
    phase: "schedule" as const,
    work: Effect.die(new TypeError(privateValue)),
    errorType: "TypeError",
    code: "defect",
    outcome: "failure",
    stage: undefined,
  },
  {
    name: "interruption",
    phase: "prepare" as const,
    work: Effect.interrupt,
    errorType: "Interrupted",
    code: "interrupted",
    outcome: "cancelled",
    stage: undefined,
  },
];

for (const example of cases) {
  it.effect(
    `${example.name} preparation diagnostics preserve reads and export only safe classifications`,
    () =>
      Effect.gen(function* () {
        const work: Effect.Effect<void, unknown> = example.work;
        const observed = work.pipe(observeCompilerPreparation(example.phase));
        const result = yield* collectTelemetry(
          Effect.gen(function* () {
            if (example.phase === "prepare")
              yield* observed.pipe(Effect.withSpan("runtime.cloud.compiler.prepare"));
            else yield* observed;
            return "owner-read-completed";
          }).pipe(Effect.withSpan("owner-request")),
        );
        expect(result.value).toBe("owner-read-completed");
        const exported = [...result.telemetry.traces, ...result.telemetry.logs].join("\n");
        expect(exported).not.toContain(privateValue);
        const spans = result.telemetry.traces.flatMap((body) =>
          Schema.decodeUnknownSync(Trace)(body).resourceSpans.flatMap((resource) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
          ),
        );
        const logs = result.telemetry.logs.flatMap((body) =>
          Schema.decodeUnknownSync(Logs)(body).resourceLogs.flatMap((resource) =>
            resource.scopeLogs.flatMap((scope) => scope.logRecords),
          ),
        );
        const target = spans.find(
          (span) =>
            span.name ===
            (example.phase === "prepare" ? "runtime.cloud.compiler.prepare" : "owner-request"),
        );
        expect(target).toBeDefined();
        const fields = Object.fromEntries(
          target!.attributes.map(({ key, value }) => [key, value.stringValue]),
        );
        expect(fields["executor.compiler.preparation.phase"]).toBe(example.phase);
        expect(fields["executor.compiler.preparation.error_type"]).toBe(example.errorType);
        expect(fields["executor.compiler.preparation.failure_code"]).toBe(example.code);
        expect(fields["executor.compiler.preparation.outcome"]).toBe(example.outcome);
        expect(fields["executor.compiler.preparation.build_stage"]).toBe(example.stage);
        expect(logs).toHaveLength(1);
        const logged = Object.fromEntries(
          logs[0]!.attributes.map(({ key, value }) => [key, value.stringValue]),
        );
        expect(logged["executor.trace_id"]).toBe(target!.traceId);
        expect(logged["executor.span_id"]).toBe(target!.spanId);
        expect(logged["executor.compiler.preparation.failure_code"]).toBe(example.code);
        expect(spans.filter((span) => span.name === "runtime.cloud.compiler.prepare")).toHaveLength(
          example.phase === "prepare" ? 1 : 0,
        );
      }),
  );
}
