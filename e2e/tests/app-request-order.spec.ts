import { expect, layer } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appBrowserFiles } from "../support/app-browser.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("App request order", (it) => {
  it.effect(scenarios.appRequestOrder.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Concurrent reads ${randomUUID().slice(0, 8)}`,
          files: appBrowserFiles,
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const references = [actors.organization.slug, actors.organization.id];
        const paths = references.map(
          (reference) => `/api/organizations/${reference}/apps/${app.id}`,
        );
        const url = `/org/${actors.organization.slug}/apps/${app.id}`;
        yield* browser.login(actors.owner);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const metadata = yield* holdQuery(paths, "continue", { allRequests: true });
            yield* browser.use("Browse apps before opening their details", (page) =>
              page.goto(`/org/${actors.organization.slug}/apps`),
            );
            yield* browser.use("Hover the app link", (page) =>
              page.getByRole("link", { name: `Open ${app.name}`, exact: true }).hover(),
            );
            const arrived = yield* Effect.exit(
              metadata.requested.pipe(Effect.timeout("5 seconds")),
            );
            expect(
              Exit.isSuccess(arrived),
              "hover starts the detail metadata read before navigation",
            ).toBe(true);
            expect(
              yield* browser.use("Hover leaves the app list mounted", (page) =>
                page.evaluate(() => window.location.pathname),
              ),
            ).toBe(`/org/${actors.organization.slug}/apps`);
            yield* metadata.release;
            yield* browser.checkpoint("App hover warms data in the existing page registry");
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const inventory = yield* holdQuery(
              references.map((reference) => `/api/organizations/${reference}/inventory`),
              "continue",
              { allRequests: true },
            );
            const workspace = yield* holdQuery(
              paths.map((path) => `${path}/workspace`),
              "continue",
              { allRequests: true },
            );
            const bundle = yield* holdQuery(
              paths.map((path) => `${path}/skill-bundle`),
              "continue",
              { allRequests: true },
            );
            yield* browser.use("Open Skills before inventory and workspace arrive", (page) =>
              page.goto(`${url}?view=skills`),
            );
            yield* inventory.requested;
            const bundleArrived = yield* Effect.exit(
              bundle.requested.pipe(Effect.timeout("5 seconds")),
            );
            expect(
              Exit.isSuccess(bundleArrived),
              "the skills bundle starts before inventory and workspace resolve",
            ).toBe(true);
            yield* workspace.requested;
            yield* browser.checkpoint(
              "Skills bundle starts beside the held workspace and inventory",
            );
            yield* bundle.release;
            yield* workspace.release;
            yield* browser.use("Skills become usable while inventory stays pending", (page) =>
              page.getByRole("navigation", { name: "Skill files", exact: true }).waitFor(),
            );
            const tools = yield* holdQuery(
              paths.map((path) => `${path}/tools`),
              "continue",
              { allRequests: true },
            );
            yield* browser.use("Open Tools while inventory stays pending", (page) =>
              page.getByRole("link", { name: "Tools", exact: true }).click(),
            );
            yield* tools.requested.pipe(Effect.timeout("5 seconds"));
            yield* tools.release;
            yield* browser.use("Tool discovery completes without the account directory", (page) =>
              page.getByRole("button", { name: "queries.hello", exact: true }).waitFor(),
            );
            yield* browser.checkpoint("Tools are usable before inventory resolves");
            yield* inventory.release;
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const deployments = yield* holdQuery(
              paths.map((path) => `${path}/deployments`),
              "continue",
              { allRequests: true },
            );
            const source = yield* holdQuery(
              paths.map((path) => `${path}/source/display`),
              "continue",
              { allRequests: true },
            );
            yield* browser.use("Open Deployments before its list arrives", (page) =>
              page.goto(`${url}?view=deployments`),
            );
            yield* deployments.requested;
            yield* source.requested.pipe(Effect.timeout("5 seconds"));
            yield* browser.checkpoint("Deployment files start beside the held deployment list");
            yield* source.release;
            yield* deployments.release;
            yield* browser.use("The active deployment renders", (page) =>
              page.getByRole("region", { name: "App deployments", exact: true }).waitFor(),
            );
          }),
        );
      }),
    ),
  );
});
