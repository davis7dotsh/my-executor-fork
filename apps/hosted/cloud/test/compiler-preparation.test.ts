import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Result } from "effect";
import { RuntimeBuildFailed } from "@executor-js/sdk/core";
import { makeCompilerPreparation } from "../src/implementation/compiler-preparation.ts";

it.effect("preparation runs once and overlapping callers retain no shared request", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const prepare = makeCompilerPreparation(
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
      }),
    );
    const first = yield* Effect.forkChild(prepare);
    yield* Deferred.await(entered);
    yield* prepare;
    expect(calls).toBe(1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* prepare;
    expect(calls).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("failed preparation is retried and never prevents later compiler use", () =>
  Effect.gen(function* () {
    let calls = 0;
    const prepare = makeCompilerPreparation(
      Effect.suspend(() =>
        ++calls === 1 ? Effect.fail(new RuntimeBuildFailed({ stage: "compile" })) : Effect.void,
      ),
    );
    const failed = yield* prepare.pipe(Effect.result);
    expect(Result.isFailure(failed)).toBe(true);
    yield* prepare;
    yield* prepare;
    expect(calls).toBe(2);
  }),
);

it.effect("interrupted preparation releases its slot for the next editor", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const secondEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const prepare = makeCompilerPreparation(
      Effect.gen(function* () {
        yield* Deferred.succeed(++calls === 1 ? firstEntered : secondEntered, undefined);
        yield* Deferred.await(release);
      }),
    );
    const first = yield* Effect.forkChild(prepare);
    yield* Deferred.await(firstEntered);
    yield* Fiber.interrupt(first);
    const second = yield* Effect.forkChild(prepare);
    yield* Deferred.await(secondEntered);
    expect(calls).toBe(2);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(second);
  }).pipe(Effect.scoped),
);
