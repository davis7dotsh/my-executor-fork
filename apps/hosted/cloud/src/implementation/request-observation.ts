/** Request-entry signals for one isolate; no request services or authority are retained. */
import { Clock, Effect } from "effect";

/** Construct at module scope, but read the clock and generate randomness only in a request. */
export const makeRequestObservation = () => {
  let id: string | undefined;
  let firstSeenAt = 0;
  let sequence = 0;
  return <A, E, R>(handler: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const attributes = yield* Effect.sync(() => {
        if (id === undefined) {
          id = crypto.randomUUID();
          firstSeenAt = startedAt;
        }
        sequence += 1;
        return {
          "executor.isolate.id": id,
          "executor.isolate.request_seq": sequence,
          "executor.isolate.age_ms": Math.max(0, startedAt - firstSeenAt),
          "executor.handler.started_at_ms": startedAt,
        };
      });
      yield* Effect.annotateCurrentSpan(attributes);
      yield* Effect.logInfo("executor.request.lifecycle").pipe(Effect.annotateLogs(attributes));
      return yield* handler;
    });
};
