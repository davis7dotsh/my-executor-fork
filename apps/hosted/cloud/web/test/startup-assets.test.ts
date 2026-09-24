import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { chromium } from "playwright";
import { build } from "vite-plus";
import { cloudflareRedirects } from "../cloudflare-redirects.ts";

const fixture = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "dashboard-assets-"))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  );
  yield* Effect.promise(async () => {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "public"));
    await writeFile(join(root, "public/favicon.svg"), "<svg></svg>");
    await writeFile(
      join(root, "index.html"),
      '<html><head></head><body><script type="module" src="/src/boot.ts"></script></body></html>',
    );
    await writeFile(
      join(root, "src/boot.ts"),
      'import { value } from "./shared.ts"; window.shared = value; window.order = ["reporter"]; import("./main.tsx").catch(() => window.order.push("caught"));',
    );
    await writeFile(
      join(root, "src/main.tsx"),
      'import { value } from "./shared.ts"; window.order.push(value); if (location.search) throw new Error("boot failure"); window.openRoute = () => import("./route.ts");',
    );
    await writeFile(join(root, "src/shared.ts"), 'export const value = "main";');
    await writeFile(join(root, "src/route.ts"), 'window.order.push("route");');
  });
  const redirects = cloudflareRedirects();
  redirects.routes.onRouteTreeChanged?.({
    routeTree: [],
    routeNodes: [],
    rootRouteNode: { filePath: "", fullPath: "", variableName: "", _fsRouteType: "__root" },
    acc: { routeTree: [], routeNodes: [], routePiecesByPath: {}, routeNodesByPath: new Map() },
  });
  return { root, plugin: redirects.assets };
});

it.effect(
  "compiled preloads keep reporting first and Cloudflare caches only generated assets",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, plugin } = yield* fixture;
        const result = yield* Effect.promise(() =>
          build({ root, configFile: false, plugins: [plugin], logLevel: "silent" }),
        );
        if (Array.isArray(result) || !("output" in result))
          return yield* Effect.die("Expected one browser build.");
        const main = result.output
          .filter((output) => output.type === "chunk")
          .find((output) => output.facadeModuleId?.endsWith("/src/main.tsx"));
        if (main === undefined) return yield* Effect.die("Expected the dynamic main chunk.");
        const html = yield* Effect.promise(() => readFile(join(root, "dist/index.html"), "utf8"));
        expect(html).toContain(`rel="modulepreload" crossorigin="" href="/${main.fileName}"`);
        const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
        for (const fileName of main.imports) {
          expect(references.filter((reference) => reference === `/${fileName}`)).toHaveLength(1);
        }
        for (const fileName of main.dynamicImports) {
          expect(html).not.toContain(`href="/${fileName}"`);
        }
        const worker = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new Miniflare({
                modules: true,
                script:
                  "export default { fetch(request, env) { return env.ASSETS.fetch(request); } };",
                compatibilityDate: "2026-07-30",
                assets: { directory: join(root, "dist"), binding: "ASSETS" },
              }),
          ),
          (worker) => Effect.promise(() => worker.dispose()),
        );
        const asset = yield* Effect.promise(() =>
          worker.dispatchFetch(`http://localhost/${main.fileName}`),
        );
        expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        for (const path of ["/", "/favicon.svg"]) {
          const response = yield* Effect.promise(() =>
            worker.dispatchFetch(`http://localhost${path}`),
          );
          expect(response.headers.get("cache-control")).not.toContain("immutable");
        }
        const browser = yield* Effect.acquireRelease(
          Effect.promise(() => chromium.launch({ headless: true })),
          (browser) => Effect.promise(() => browser.close()),
        );
        const origin = yield* Effect.promise(() => worker.ready);
        const page = yield* Effect.promise(() => browser.newPage());
        yield* Effect.promise(() => page.goto(origin.toString()));
        yield* Effect.promise(() =>
          page.waitForFunction(() => Reflect.get(window, "order")?.length === 2),
        );
        expect(
          yield* Effect.promise(() => page.evaluate(() => Reflect.get(window, "order"))),
        ).toEqual(["reporter", "main"]);
        yield* Effect.promise(() => page.goto(`${origin}?fail=1`));
        yield* Effect.promise(() =>
          page.waitForFunction(() => Reflect.get(window, "order")?.length === 3),
        );
        expect(
          yield* Effect.promise(() => page.evaluate(() => Reflect.get(window, "order"))),
        ).toEqual(["reporter", "main", "caught"]);
      }),
    ),
);

it.effect("an unhashed generated asset fails the Cloud build", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { root, plugin } = yield* fixture;
      const result = yield* Effect.exit(
        Effect.promise(() =>
          build({
            root,
            configFile: false,
            plugins: [plugin],
            build: { rolldownOptions: { output: { entryFileNames: "assets/entry.js" } } },
            logLevel: "silent",
          }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  ),
);

it.effect("stable public files cannot enter the immutable namespace", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { root, plugin } = yield* fixture;
      yield* Effect.promise(() => mkdir(join(root, "public/assets")));
      const result = yield* Effect.exit(
        Effect.promise(() =>
          build({ root, configFile: false, plugins: [plugin], logLevel: "silent" }),
        ),
      );
      expect(result._tag).toBe("Failure");
    }),
  ),
);
