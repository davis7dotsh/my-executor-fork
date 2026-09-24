import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const Result = Schema.Struct({
  reads: Schema.Int,
  key: Schema.String,
  names: Schema.optional(Schema.Array(Schema.String)),
});

it.effect(
  "native metadata caches isolate builds, accounts and profile revisions, and recover from stale entries",
  () =>
    Effect.gen(function* () {
      const bundle = yield* Effect.promise(() =>
        build({
          stdin: {
            resolveDir: new URL(".", import.meta.url).pathname,
            sourcefile: "runtime-catalog-fixture.ts",
            contents: `
              import { Effect, Exit, Redacted, Schema } from "effect";
              import { cachedRuntimeCatalog, runtimeCatalogIdentity } from "../src/implementation/runtime-catalog-cache.ts";
              let reads = 0;
              const catalog = Schema.Array(Schema.Struct({name: Schema.String}));
              export default { async fetch(request) {
                const url = new URL(request.url);
                const operation = url.searchParams.get("operation") ?? "tools";
                const identity = await Effect.runPromise(runtimeCatalogIdentity(
                  url.searchParams.get("app") ?? "app_example",
                  url.searchParams.get("build") ?? "bld_example",
                  Redacted.make({service:{id:"acc_example",provider:{name:"Example",auth:{}},method:"key",fields:{token:url.searchParams.get("token") ?? "synthetic-first-token"}}}),
                  url.searchParams.get("revision") ?? "profile:1",
                ));
                const key = url.origin + "/_executor/runtime-catalog-cache/v1/" + operation + "/" + encodeURIComponent(identity);
                const cache = await caches.open("executor-private-runtime-catalogs-v1");
                if (url.pathname.startsWith("/expire")) {
                  await cache.put(key, new Response(JSON.stringify({expiresAt:0,value:[{name:"old"}]})));
                } else if (url.pathname === "/corrupt") {
                  await cache.put(key, new Response(JSON.stringify({expiresAt:Date.now()+30000,value:[{invalid:"value"}]})));
                }
                const storage = url.pathname === "/unavailable"
                  ? {open: () => Promise.reject(new TypeError("cache unavailable"))}
                  : caches;
                const load = Effect.suspend(() => {
                  reads++;
                  if (url.pathname.endsWith("fail")) return Effect.fail("upstream failed");
                  return Effect.succeed([{name:url.pathname === "/oversize" ? "x".repeat(2*1024*1024+1) : operation}]);
                });
                const value = await Effect.runPromiseExit(cachedRuntimeCatalog(url.origin, operation, identity, catalog, load, storage));
                return Response.json({reads,key,...(Exit.isSuccess(value) ? {names:value.value.map(item=>item.name.length > 100 ? "oversize" : item.name)} : {})});
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
      if (script === undefined) return yield* Effect.die("Fixture produced no Worker source");
      const worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Miniflare({
              modules: true,
              compatibilityDate: "2026-07-30",
              compatibilityFlags: ["nodejs_compat"],
              script,
            }),
        ),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const request = (path: string, origin = "https://stage.example") =>
        Effect.promise(async () => (await worker.dispatchFetch(origin + path)).json()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Result)),
        );
      const first = yield* request("/read");
      expect(first.reads).toBe(1);
      expect(first.key).not.toContain("synthetic-first-token");
      expect(first.names).toEqual(["tools"]);
      expect((yield* request("/read")).reads).toBe(1);
      expect((yield* request("/read?revision=profile:2")).reads).toBe(2);
      const rotated = yield* request("/read?token=synthetic-replaced-token");
      expect(rotated.reads).toBe(3);
      expect(rotated.key).not.toBe(first.key);
      expect(rotated.key).not.toContain("synthetic-replaced-token");
      expect((yield* request("/read?build=bld_later")).reads).toBe(4);
      expect((yield* request("/read?app=app_other")).reads).toBe(5);
      const workflows = yield* request("/read?operation=workflows");
      expect(workflows.reads).toBe(6);
      expect(workflows.names).toEqual(["workflows"]);
      expect((yield* request("/expire")).reads).toBe(7);
      expect((yield* request("/corrupt")).reads).toBe(8);
      expect((yield* request("/expire-fail")).names).toBeUndefined();
      expect((yield* request("/read")).reads).toBe(10);
      expect((yield* request("/unavailable")).reads).toBe(11);
      expect((yield* request("/fail?revision=profile:3")).names).toBeUndefined();
      expect((yield* request("/read?revision=profile:3")).reads).toBe(13);
      expect((yield* request("/read?revision=profile:3")).reads).toBe(13);
      expect((yield* request("/read", "https://other-stage.example")).reads).toBe(14);
      expect((yield* request("/oversize?revision=profile:4")).reads).toBe(15);
      expect((yield* request("/oversize?revision=profile:4")).reads).toBe(16);
    }).pipe(Effect.scoped),
  30_000,
);
