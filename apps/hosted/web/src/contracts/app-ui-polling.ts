import { Effect, Schedule, Schema } from "effect";

/** Domain provisioning gets six retries with bounded spacing, then an explicit user retry. */
export const appUiReadinessSchedule = Schedule.recurs(6).pipe(
  Schedule.addDelay(({ attempt }) => Effect.succeed(Math.min(3000 * 2 ** (attempt - 1), 30_000))),
);

export class AppUiReadinessPending extends Schema.TaggedError<AppUiReadinessPending>()(
  "AppUiReadinessPending",
  {},
) {}
