import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const result = Schema.Struct({
  reads: Schema.Int,
  documents: Schema.Int,
  entries: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});

it.effect(
  "native Cache API shares only successful catalog feeds, expires them, and keeps documents live",
  () =>
    Effect.gen(function* () {
      const bundle = yield* Effect.promise(() =>
        build({
          stdin: {
            resolveDir: new URL(".", import.meta.url).pathname,
            sourcefile: "catalog-cache-fixture.ts",
            contents: `
              import { Effect, Exit } from "effect";
              import { CatalogUnavailable } from "@executor-js/catalog";
              import { cachedCatalogSource } from "../src/implementation/catalog-cache.ts";
              let reads = 0;
              let documents = 0;
              export default { async fetch(request) {
                const url = new URL(request.url);
                const key = url.origin + "/_executor/public-catalog/v1";
                const cache = await caches.open("executor-public-catalog-v1");
                if (url.pathname === "/corrupt") {
                  await cache.put(key, new Response("invalid"));
                } else if (url.pathname === "/expire") {
                  await cache.put(key, new Response(JSON.stringify({expiresAt: 0, entries: []})));
                }
                const source = {
                  list: Effect.suspend(() => {
                    reads++;
                    return url.pathname === "/fail"
                      ? Effect.fail(new CatalogUnavailable())
                      : Effect.succeed([{id:"example", kind:"mcp", name:"Example", description:"", domain:"example.com"}]);
                  }),
                  document: () => Effect.sync(() => ++documents)
                };
                const storage = url.pathname === "/unavailable"
                  ? {open: () => Promise.reject(new TypeError("cache unavailable"))}
                  : caches;
                const cached = cachedCatalogSource(url.origin, source, storage);
                if (url.pathname === "/documents") {
                  await Effect.runPromise(cached.document({id:"example"}));
                  await Effect.runPromise(cached.document({id:"example"}));
                }
                const value = await Effect.runPromiseExit(cached.list);
                return Response.json({reads, documents, ...(Exit.isSuccess(value) ? {entries:value.value} : {})});
              }};
            `,
          },
          bundle: true,
          write: false,
          platform: "browser",
          format: "esm",
          target: "es2022",
        }),
      );
      const script = bundle.outputFiles[0]?.text;
      expect(script).toBeDefined();
      const worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Miniflare({
              modules: true,
              compatibilityDate: "2026-07-30",
              compatibilityFlags: ["nodejs_compat"],
              script: script!,
            }),
        ),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const request = (path: string, origin = "https://stage.example") =>
        Effect.promise(async () => (await worker.dispatchFetch(origin + path)).json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(result)),
        );
      expect((yield* request("/fail")).entries).toBeUndefined();
      expect((yield* request("/read")).reads).toBe(2);
      const hit = yield* request("/fail");
      expect(hit.entries).toEqual([{ id: "example" }]);
      expect(hit.reads).toBe(2);
      expect((yield* request("/read", "https://other.example")).reads).toBe(3);
      expect((yield* request("/expire")).reads).toBe(4);
      expect((yield* request("/corrupt")).reads).toBe(5);
      expect((yield* request("/unavailable")).reads).toBe(6);
      const documents = yield* request("/documents");
      expect(documents.documents).toBe(2);
      expect(documents.reads).toBe(6);
    }).pipe(Effect.scoped),
  30_000,
);
