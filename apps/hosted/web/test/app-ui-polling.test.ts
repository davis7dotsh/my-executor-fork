import { expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Schedule } from "effect";
import { appUiReadinessSchedule } from "../src/contracts/app-ui-polling.ts";

it.effect("domain readiness retries back off and end after six scheduled reads", () =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(appUiReadinessSchedule);
    const delays: number[] = [];
    for (let index = 0; index < 6; index++) {
      const [, delay] = yield* step(index, undefined);
      delays.push(Duration.toMillis(delay));
    }
    expect(delays).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
    const exhausted = yield* Effect.exit(step(6, undefined));
    expect(Exit.isFailure(exhausted)).toBe(true);
  }),
);
