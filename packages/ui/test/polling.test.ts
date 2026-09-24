import { afterEach, expect, it, vi } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { pollingQuery } from "../src/contracts/polling.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.effect("hidden pages skip polling and unchanged results back off", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    const document = { visibilityState: "hidden" };
    vi.stubGlobal("document", document);
    const registry = yield* Effect.acquireRelease(
      Effect.sync(() => AtomRegistry.make()),
      (registry) => Effect.sync(() => registry.dispose()),
    );
    let reads = 0;
    const source = Atom.readable(() => {
      reads++;
      return AsyncResult.success({ revision: 1 });
    });
    const release = registry.mount(pollingQuery(source));
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
    expect(reads).toBe(1);
    document.visibilityState = "visible";
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(2);
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(2);
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(3);
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
    expect(reads).toBe(4);
    release();
    registry.dispose();
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(60_000));
    expect(reads).toBe(4);
  }),
);

it.effect("a held request is never interrupted by a polling tick", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    const registry = yield* Effect.acquireRelease(
      Effect.sync(() => AtomRegistry.make()),
      (registry) => Effect.sync(() => registry.dispose()),
    );
    let reads = 0;
    let result = AsyncResult.waiting(AsyncResult.success({ revision: 1 }));
    const source = Atom.readable(() => {
      reads++;
      return result;
    });
    registry.mount(pollingQuery(source));
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
    expect(reads).toBe(1);
    result = AsyncResult.success({ revision: 2 });
    registry.refresh(source);
    yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5000));
    expect(reads).toBe(3);
    registry.dispose();
  }),
);

it.effect(
  "polling caps quiet intervals at thirty seconds and writes still refresh immediately",
  () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      vi.stubGlobal("document", { visibilityState: "visible" });
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      let reads = 0;
      let revision = 1;
      const source = Atom.readable(() => {
        reads++;
        return AsyncResult.success({ revision });
      });
      const query = pollingQuery(source);
      registry.mount(query);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(66_000));
      expect(reads).toBe(5);
      revision = 2;
      registry.refresh(query);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(0));
      expect(reads).toBe(6);
      expect(Option.getOrUndefined(AsyncResult.value(registry.get(query)))).toEqual({
        revision: 2,
      });
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_000));
      expect(reads).toBe(7);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(10_000));
      expect(reads).toBe(8);
      registry.dispose();
    }),
);
