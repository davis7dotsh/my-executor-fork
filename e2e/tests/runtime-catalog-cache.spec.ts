import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud catalog caching", (it) => {
  it.effect(scenarios.runtimeCatalogCache.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const evidence = yield* Evidence;
        const telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Catalog ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `
          import { defineApp, query, workflow, object } from "apps";
          export default defineApp({accounts:{}}, {
            queries:{inspect:query({input:object({}),description:"Inspect"},async()=>"live")},
            workflows:{inspect:workflow({input:object({}),description:"Inspect"},async()=>"live")}
          });
        `,
            },
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        const path = `${prefix}/${app.id}`;
        let removed = false;
        yield* Effect.addFinalizer(() =>
          removed ? Effect.void : api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);

        for (const operation of ["tools", "workflows"] as const) {
          const first = yield* api.request(actors.member, "GET", `${path}/${operation}`);
          expect(first.status).toBe(200);
          const second = yield* api.request(actors.member, "GET", `${path}/${operation}`);
          expect(second.status).toBe(200);
          expect(second.body).toEqual(first.body);
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined) return yield* Effect.die("Catalog request evidence missing");
          const trace = yield* telemetry.query(request.traceId).pipe(
            Effect.flatMap((trace) =>
              trace.data.some((row) => row.span.operationName === "runtime.cloud.catalog.cached")
                ? Effect.succeed(trace)
                : Effect.fail("Catalog trace has not reached the collector"),
            ),
            Effect.retry({ schedule: Schedule.spaced(200), times: 25 }),
          );
          yield* evidence.json(`${operation}-cache-hit-trace.json`, trace);
          expect(trace.data).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                span: expect.objectContaining({
                  operationName: "runtime.cloud.catalog.cached",
                  tags: expect.objectContaining({ "executor.catalog.cache": "hit" }),
                }),
              }),
            ]),
          );
          expect(
            trace.data.some((row) => row.span.operationName === "runtime.cloud.rpc.start"),
          ).toBe(false);
        }
        expect((yield* api.request(actors.owner, "DELETE", path)).status).toBe(200);
        removed = true;
        expect((yield* api.request(actors.member, "GET", `${path}/tools`)).status).toBe(403);
        expect((yield* api.request(actors.member, "GET", `${path}/workflows`)).status).toBe(403);
      }),
    ),
  );
});
