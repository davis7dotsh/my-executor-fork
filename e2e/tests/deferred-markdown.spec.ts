import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Deferred Markdown", (it) => {
  it.effect(scenarios.deferredMarkdown.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const created = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: "Deferred document fixture",
          files: [
            {
              path: "index.ts",
              content:
                'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, {});',
            },
            {
              path: "skills/guide/SKILL.md",
              content:
                "---\nname: guide\ndescription: Deferred skill guide.\n---\n# Deferred skill guide\n\nRead [Reference](references/guide.md) and [External](https://example.com/guide).\n\n[Unsafe](javascript:alert(1))\n\n<script>unsafe()</script>\n\n![Unexpected image](https://private.invalid/pixel.png)",
            },
            {
              path: "skills/guide/references/guide.md",
              content: "# Reference document\n\n[Instructions](../SKILL.md)",
            },
          ],
        });
        expect(created.status).toBe(200);
        const app = yield* body(App, created);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
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
        yield* browser.login(actors.member);
        const renderer = yield* holdQuery(/\/assets\/markdown-renderer-[^/]+\.js$/, "continue");
        yield* browser.use("Open a skill before its Markdown renderer arrives", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=skills`, {
            waitUntil: "domcontentloaded",
          }),
        );
        yield* renderer.requested;
        yield* browser.use("The pending document remains readable", (page) =>
          page
            .getByRole("region", { name: "App skills", exact: true })
            .locator('[aria-busy="true"]')
            .filter({ hasText: "Deferred skill guide" })
            .waitFor({ state: "visible" }),
        );
        const geometry = yield* browser.use(
          "Record the skill region during module loading",
          (page) => page.getByRole("region", { name: "App skills", exact: true }).boundingBox(),
        );
        expect(geometry).not.toBeNull();
        expect(
          yield* browser.use("Pending source cannot create executable markup", (page) =>
            page
              .getByRole("region", { name: "App skills", exact: true })
              .locator("script, img")
              .count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Readable skill while Markdown module is pending");
        yield* renderer.release;
        yield* browser.use("The same document becomes formatted", (page) =>
          page
            .getByRole("heading", { name: "Deferred skill guide", exact: true })
            .waitFor({ state: "visible" }),
        );
        expect(
          yield* browser.use("The skill region retains its geometry", (page) =>
            page.getByRole("region", { name: "App skills", exact: true }).boundingBox(),
          ),
        ).toEqual(geometry);
        expect(
          yield* browser.use("Unsafe links remain plain text", (page) =>
            page.getByRole("link", { name: "Unsafe", exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("An emptied unsafe URL cannot become a skill file button", (page) =>
            page.getByRole("button", { name: "Unsafe", exact: true }).count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("Raw HTML and remote images remain disabled", (page) =>
            page
              .getByRole("region", { name: "App skills", exact: true })
              .locator("script, img")
              .count(),
          ),
        ).toBe(0);
        expect(
          yield* browser.use("External links retain their safety attributes", (page) =>
            page.getByRole("link", { name: "External", exact: true }).evaluate((element) => ({
              href: element.getAttribute("href"),
              target: element.getAttribute("target"),
              rel: element.getAttribute("rel"),
            })),
          ),
        ).toEqual({
          href: "https://example.com/guide",
          target: "_blank",
          rel: "noopener noreferrer",
        });
        yield* browser.use("Follow a relative skill reference", (page) =>
          page.getByRole("button", { name: "Reference", exact: true }).click(),
        );
        yield* browser.use("The selected reference is formatted", (page) =>
          page
            .getByRole("heading", { name: "Reference document", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.use("Resolve a parent-relative link back to instructions", (page) =>
          page.getByRole("button", { name: "Instructions", exact: true }).click(),
        );
        yield* browser.use("Instructions return without losing navigation", (page) =>
          page
            .getByRole("heading", { name: "Deferred skill guide", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Formatted skill with safe relative navigation");
      }),
    ),
  );
});
