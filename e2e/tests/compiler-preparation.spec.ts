import { expect, layer } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { saveAndDeploy } from "../support/app-authoring.ts";

layer(HostedLive, { excludeTestServices: true })("Cloud compiler preparation", (it) => {
  it.effect(scenarios.compilerPreparation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const evidence = yield* Evidence;
        const telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const files = [
          {
            path: "index.ts",
            content:
              "throw new Error('Authored source must not run during compiler preparation'); export default {};",
          },
        ];
        const created = yield* api.request(actors.owner, "POST", `${prefix}/drafts`, {
          name: `Preparation ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(created.status).toBe(200);
        const app = yield* body(App, created);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        expect((yield* api.request(actors.member, "GET", `${path}/workspace`)).status).toBe(403);
        expect((yield* api.request(actors.owner, "GET", `${path}/workspace`)).status).toBe(200);
        const request = (yield* evidence.requests).at(-1);
        if (request === undefined) return yield* Effect.die("Workspace request evidence missing");
        const trace = yield* telemetry.query(request.traceId).pipe(
          Effect.flatMap((trace) =>
            trace.data.some((row) => row.span.operationName === "compiler.prepare")
              ? Effect.succeed(trace)
              : Effect.fail("Compiler preparation has not reached the collector"),
          ),
          Effect.retry({ schedule: Schedule.spaced(200), times: 25 }),
        );
        yield* evidence.json("compiler-preparation-trace.json", trace);
        expect(trace.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              span: expect.objectContaining({
                operationName: "compiler.prepare",
                tags: expect.objectContaining({ "executor.compiler.preparation": "started" }),
              }),
            }),
          ]),
        );
        expect(trace.data.some((row) => row.span.operationName === "runtime.cloud.rpc.start")).toBe(
          false,
        );
        const deployed = yield* saveAndDeploy(actors.owner, path, {
          files: [
            {
              path: "index.ts",
              content: `import {defineApp,query,object} from "apps";
        export default defineApp({accounts:{}},{queries:{inspect:query({input:object({})},async()=>"prepared")}});`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        expect((yield* api.request(actors.owner, "GET", `${path}/tools`)).status).toBe(200);
      }),
    ),
  );
});
