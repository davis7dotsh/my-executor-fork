/** Preparation diagnostics contain only closed classifications, never error messages or payloads. */
import { RuntimeBuildFailed } from "@executor-js/sdk/core";
import { Cause, Effect, Option, Schema } from "effect";

const knownTag = Schema.decodeUnknownOption(
  Schema.Struct({
    _tag: Schema.Literals(["RpcCallError", "TimeoutError", "ScopeClosedError", "PlatformError"]),
  }),
);
const knownName = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.Literals([
      "Error",
      "TypeError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "AbortError",
    ]),
  }),
);

const classify = (value: unknown) => {
  if (Schema.is(RuntimeBuildFailed)(value))
    return {
      error_type: "RuntimeBuildFailed",
      failure_code: "build",
      build_stage: value.stage,
    };
  const tag = knownTag(value);
  if (Option.isSome(tag))
    return {
      error_type: tag.value._tag,
      failure_code: (
        {
          RpcCallError: "rpc_call",
          TimeoutError: "timeout",
          ScopeClosedError: "scope_closed",
          PlatformError: "platform",
        } as const
      )[tag.value._tag],
    };
  const name = knownName(value);
  return {
    error_type: Option.isSome(name) ? name.value.name : "UnhandledFailure",
    failure_code: Option.isSome(name) ? "defect" : "unclassified",
  };
};

const diagnostic = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterrupts(cause))
    return {
      outcome: "cancelled",
      error_type: "Interrupted",
      failure_code: "interrupted",
    };
  const reason = cause.reasons.find(
    (reason) => Cause.isFailReason(reason) || Cause.isDieReason(reason),
  );
  const value =
    reason === undefined ? undefined : Cause.isFailReason(reason) ? reason.error : reason.defect;
  return { outcome: "failure", ...classify(value) };
};

/** Observe failures before a preparation span ends; the successful read and its trace stay intact. */
export const observeCompilerPreparation =
  (phase: "prepare" | "schedule") =>
  <E, R>(work: Effect.Effect<void, E, R>) =>
    work.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const details = diagnostic(cause);
          const fields = Object.fromEntries(
            Object.entries({ phase, ...details }).map(([key, value]) => [
              `executor.compiler.preparation.${key}`,
              value,
            ]),
          );
          yield* Effect.annotateCurrentSpan(fields);
          const span = yield* Effect.currentSpan.pipe(Effect.option);
          yield* Effect.logWarning(
            phase === "prepare"
              ? "Compiler preparation failed"
              : "Compiler preparation scheduling failed",
          ).pipe(
            Effect.annotateLogs({
              ...fields,
              ...(Option.isNone(span)
                ? {}
                : {
                    "executor.trace_id": span.value.traceId,
                    "executor.span_id": span.value.spanId,
                  }),
            }),
          );
        }),
      ),
    );
