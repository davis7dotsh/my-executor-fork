/** Mounted dashboard queues revalidate without interrupting an existing read. */
import { Effect } from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";

/** Quiet queues back off to thirty seconds; mutations still refresh the source immediately. */
export const pollingQuery = <A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  milliseconds = 5000,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> => {
  const polling = Atom.readable((get) => {
    let delay = milliseconds;
    let previous: string | undefined;
    get.subscribe(
      source,
      (result) => {
        if (result.waiting) return;
        if (AsyncResult.isSuccess(result)) {
          const value = JSON.stringify(result.value);
          delay = value === previous ? Math.min(delay * 2, 30_000) : milliseconds;
          previous = value;
        } else if (AsyncResult.isFailure(result)) {
          delay = Math.min(delay * 2, 30_000);
        }
      },
      { immediate: true },
    );
    get.addFinalizer(
      Effect.runCallback(
        Effect.forever(
          Effect.suspend(() => Effect.sleep(delay)).pipe(
            Effect.andThen(() =>
              Effect.sync(() => {
                if (typeof document === "undefined" || document.visibilityState !== "visible")
                  return;
                if (get.once(source).waiting) return;
                get.refresh(source);
              }),
            ),
          ),
        ),
      ),
    );
    return undefined;
  });
  return Atom.readable(
    (get) => {
      get(polling);
      return get(source);
    },
    (refresh) => refresh(source),
  );
};
