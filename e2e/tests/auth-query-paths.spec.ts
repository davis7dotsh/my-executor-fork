import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud auth query paths", (it) => {
  it.effect(scenarios.authQueryPaths.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const app = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `Auth paths ${randomUUID().slice(0, 8)}`,
            files: [
              {
                path: "index.ts",
                content:
                  'import { defineApp } from "apps"; export default defineApp({accounts:{}},{});',
              },
              {
                path: "ui/index.html",
                content: "<!doctype html><html><body><h1>Auth fixture</h1></body></html>",
              },
            ],
          }),
        );
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const trace = Effect.gen(function* () {
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined) return yield* Effect.die("Missing request evidence");
          return yield* telemetry.query(request.traceId).pipe(
            Effect.flatMap((result) =>
              result.data.some(({ span }) => span.tags["http.response.status_code"] === "200") &&
              result.data.some(({ span }) => span.operationName === "auth.sql.timing")
                ? Effect.succeed(result)
                : Effect.fail("Completed auth trace has not reached the collector"),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 50 }),
          );
        });
        expect((yield* api.request(actors.owner, "GET", `${prefix}/inventory`)).status).toBe(200);
        const inventory = yield* trace;
        expect(
          inventory.data.some(({ span }) => span.operationName === "auth.app_sessions.initialize"),
        ).toBe(false);
        const authQueries = inventory.data.filter(
          ({ span }) => span.operationName === "auth.sql.timing",
        );
        expect(authQueries.every(({ span }) => span.tags["db.query.driver"] === "effect-pg")).toBe(
          true,
        );
        expect(
          (yield* api.request(actors.owner, "GET", `${prefix}/apps/${app.id}/ui`)).status,
        ).toBe(200);
        const ui = yield* trace;
        expect(
          ui.data.some(({ span }) => span.operationName === "auth.app_sessions.initialize"),
        ).toBe(true);
        yield* evidence.json("auth-query-paths.json", { inventory, ui });
      }),
    ),
  );
});
