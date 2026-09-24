import { controlledDomainReadiness } from "../support/app-polling.ts";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { scenarios } from "../test-plan.ts";
import { holdQuery, refreshVisiblePage } from "../support/query-transition.ts";

layer(HostedLive, { excludeTestServices: true })("Bounded app polling", (it) => {
  it.effect(scenarios.organizationIdentityRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const browser = yield* Browser;
        const url = `/org/${actors.organization.slug}/apps`;
        yield* browser.login(actors.owner);
        yield* browser.use("Establish the confirmed session display hint", (page) =>
          page.goto(url),
        );
        yield* browser.use("Settle the confirmed session", (page) =>
          page.waitForLoadState("networkidle"),
        );
        let lists = 0;
        yield* browser.use("Count real organization list requests", (page) =>
          page.route("**/api/auth/organization/list", (route) => {
            lists++;
            return route.fallback();
          }),
        );
        const session = yield* holdQuery(["/api/auth/get-session"], "continue", {
          allRequests: true,
        });
        const organizations = yield* holdQuery(["/api/auth/organization/list"], "continue");
        yield* browser.use("Reload with the same user's live session held", (page) =>
          page.reload(),
        );
        yield* session.requested;
        yield* organizations.requested;
        yield* organizations.release;
        yield* session.release;
        yield* browser.use("Settle the same user's live session response", (page) =>
          page.waitForLoadState("networkidle"),
        );
        expect(lists, "the hint and live session share one organization list read").toBe(1);
        yield* refreshVisiblePage;
        yield* browser.use("Settle the focus refresh", (page) =>
          page.waitForLoadState("networkidle"),
        );
        expect(lists, "one focus performs one organization list refresh").toBe(2);
        yield* browser.checkpoint(
          "The same user does not amplify organization reads during session refresh",
        );
      }),
    ),
  );
  it.effect(scenarios.appDomainPollLimit.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Pending domain ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content:
                'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, {});',
            },
          ],
        });
        expect(response.status).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.login(actors.owner);
        yield* browser.use("Control the browser clock", (page) => page.clock.install());
        const readiness = yield* controlledDomainReadiness(app.id);
        yield* browser.use("Open the pending app domain", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}`),
        );
        yield* browser.use("Readiness starts pending without an app link", (page) =>
          page.getByRole("status").filter({ hasText: "Preparing app domain…" }).waitFor(),
        );
        expect(
          yield* browser.use("A pending origin cannot be opened", (page) =>
            page.getByRole("link", { name: "Open app", exact: true }).count(),
          ),
        ).toBe(0);
        for (let index = 1; index < 7; index++) {
          yield* browser.use("Advance the next readiness retry", (page) =>
            page.clock.runFor(30_100),
          );
          yield* readiness.requested(index);
          yield* browser.use("Settle the completed readiness response", (page) =>
            page.waitForLoadState("networkidle"),
          );
        }
        expect(
          yield* browser.use("The automatic budget ends with a retry control", (page) =>
            page.getByRole("button", { name: "Check again", exact: true }).count(),
          ),
          "pending readiness has a bounded automatic budget",
        ).toBe(1);
        yield* browser.use("Exhausted readiness offers an explicit retry", (page) =>
          page
            .getByRole("status")
            .filter({ hasText: "The app domain is still preparing. Check again in a moment." })
            .waitFor(),
        );
        expect(readiness.reads()).toBe(7);
        yield* browser.use("Advance beyond the automatic retry budget", (page) =>
          page.clock.runFor(120_000),
        );
        expect(readiness.reads()).toBe(7);
        yield* browser.checkpoint("Pending domain polling stops with Check again available");
        readiness.ready();
        yield* browser.use("Retry after provisioning becomes ready", (page) =>
          page.getByRole("button", { name: "Check again", exact: true }).click(),
        );
        yield* browser.use("Retry exposes the ready origin", (page) =>
          page.getByRole("link", { name: "Open app", exact: true }).waitFor(),
        );
        expect(readiness.reads()).toBe(8);
        yield* browser.checkpoint("An explicit retry recovers the ready app link");
      }),
    ),
  );
});
