import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeRequestObservation } from "../src/implementation/request-observation.ts";
import { invocationSummary } from "../src/implementation/invocation-summary.ts";

it.effect("one isolate records distinct request entries without retaining request state", () =>
  Effect.gen(function* () {
    const observe = makeRequestObservation();
    const first = yield* observe(Effect.currentSpan).pipe(Effect.withSpan("http.server GET"));
    yield* TestClock.adjust("25 millis");
    const second = yield* observe(Effect.currentSpan).pipe(Effect.withSpan("http.server POST"));
    expect(first.attributes.get("executor.isolate.id")).toBe(
      second.attributes.get("executor.isolate.id"),
    );
    expect(first.attributes.get("executor.isolate.request_seq")).toBe(1);
    expect(second.attributes.get("executor.isolate.request_seq")).toBe(2);
    expect(first.attributes.get("executor.isolate.age_ms")).toBe(0);
    expect(second.attributes.get("executor.isolate.age_ms")).toBe(25);
    const other = yield* makeRequestObservation()(Effect.currentSpan).pipe(
      Effect.withSpan("http.server GET"),
    );
    expect(other.attributes.get("executor.isolate.id")).not.toBe(
      first.attributes.get("executor.isolate.id"),
    );
    expect(other.attributes.get("executor.isolate.request_seq")).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

const id = "11111111-1111-4111-8111-111111111111";
const event = (startedAt?: number, eventTimestamp: number | null = 1000) => ({
  scriptName: "fixture-api",
  eventTimestamp,
  cpuTime: 20,
  wallTime: 180,
  outcome: "ok",
  truncated: false,
  event: {},
  logs: [
    {
      message: [
        {
          type: "alchemy.phase",
          name: "alchemy.runtime.initialize",
          durationMs: 100,
        },
        { type: "alchemy.phase", name: "alchemy.handler", durationMs: 30 },
        {
          message: "executor.request.lifecycle",
          annotations: {
            "executor.isolate.id": id,
            "executor.isolate.request_seq": 1,
            "executor.isolate.age_ms": 0,
            ...(startedAt === undefined ? {} : { "executor.handler.started_at_ms": startedAt }),
            cookie: "private-fixture-cookie",
          },
        },
      ],
    },
  ],
});

it.effect("tail summaries separate pre-handler time from CPU, handler and initialization", () =>
  Effect.gen(function* () {
    const summary = yield* invocationSummary(event(1120));
    expect(summary["executor.pre_handler_ms"]).toBe(120);
    expect(summary["executor.initialize_ms"]).toBe(100);
    expect(summary["executor.bridge_handler_ms"]).toBe(30);
    expect(summary["cloudflare.cpu_time_ms"]).toBe(20);
    expect(summary["executor.isolate.id"]).toBe(id);
    expect(summary["executor.isolate.request_seq"]).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("private-fixture-cookie");
    expect((yield* invocationSummary(event())).hasOwnProperty("executor.pre_handler_ms")).toBe(
      false,
    );
    expect(
      (yield* invocationSummary(event(1120, null))).hasOwnProperty("executor.pre_handler_ms"),
    ).toBe(false);
    expect((yield* invocationSummary(event(999))).hasOwnProperty("executor.pre_handler_ms")).toBe(
      false,
    );
  }),
);
