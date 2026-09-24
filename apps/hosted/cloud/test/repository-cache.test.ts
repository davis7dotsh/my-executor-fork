import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const Result = Schema.Struct({
  ok: Schema.Boolean,
  heads: Schema.Int,
  clones: Schema.Int,
  reads: Schema.Int,
  commit: Schema.optional(Schema.String),
});

it.effect(
  "native Git cache rechecks heads, isolates repositories, and never caches a raced head",
  () =>
    Effect.gen(function* () {
      const bundled = yield* Effect.promise(() =>
        build({
          stdin: {
            resolveDir: new URL(".", import.meta.url).pathname,
            sourcefile: "repository-cache-fixture.ts",
            contents: `
              import { Effect, Exit } from "effect";
              import { SourceError } from "@executor-js/app-source/contracts";
              import { cachedRepositories } from "../src/implementation/repository-cache.ts";
              let head = "a".repeat(40);
              let heads = 0, clones = 0, reads = 0;
              export default { async fetch(request) {
                const path = new URL(request.url).pathname;
                if (path === "/race") head = "b".repeat(40);
                if (path === "/move") head = "d".repeat(40);
                const backend = {
                  head: () => Effect.suspend(() => {
                    heads++;
                    return path === "/head-failure"
                      ? Effect.fail(new SourceError({reason:"git"})) : Effect.succeed(head);
                  }),
                  history: () => Effect.sync(() => {
                    clones++;
                    return [{commit:path === "/race" ? "c".repeat(40) : head, author:"Example", message:"Synthetic", timestamp:1}];
                  }),
                  read: (_id, ref) => Effect.sync(() => {
                    reads++;
                    return {commit:ref === "main" ? head : ref, files:[{path:"index.ts", content:"export default {}"}]};
                  }),
                  commit: () => Effect.succeed(head),
                  create: () => Effect.void,
                  request: () => Effect.succeed(new Response("git"))
                };
                const repo = cachedRepositories(backend, path === "/namespace" ? "other" : "stage");
                const operation = path.startsWith("/snapshot")
                  ? repo.read("code-example", "a".repeat(40))
                  : path.startsWith("/workspace")
                    ? repo.read("code-example", "main")
                    : repo.history(path === "/other" ? "code-other" : "code-example");
                const value = await Effect.runPromiseExit(operation);
                const commit = Exit.isSuccess(value)
                  ? Array.isArray(value.value) ? value.value[0].commit : value.value.commit
                  : undefined;
                return Response.json({ok:Exit.isSuccess(value), heads, clones, reads, commit});
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
      const script = bundled.outputFiles[0]?.text;
      expect(script).toBeDefined();
      const worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Miniflare({
              modules: true,
              script: script!,
              compatibilityDate: "2026-07-30",
              compatibilityFlags: ["nodejs_compat"],
            }),
        ),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const request = (path: string) =>
        Effect.promise(async () =>
          (await worker.dispatchFetch("https://fixture.example" + path)).json(),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Result)));
      expect((yield* request("/read")).clones).toBe(1);
      const hit = yield* request("/read");
      expect(hit.heads).toBe(2);
      expect(hit.clones).toBe(1);
      expect((yield* request("/other")).clones).toBe(2);
      expect((yield* request("/namespace")).clones).toBe(3);
      expect((yield* request("/race")).commit).toBe("c".repeat(40));
      const settled = yield* request("/read");
      expect(settled.commit).toBe("b".repeat(40));
      expect(settled.clones).toBe(5);
      expect((yield* request("/read")).clones).toBe(5);
      expect((yield* request("/move")).clones).toBe(6);
      expect((yield* request("/head-failure")).ok).toBe(false);
      expect((yield* request("/snapshot")).reads).toBe(1);
      expect((yield* request("/snapshot")).reads).toBe(1);
      expect((yield* request("/workspace")).reads).toBe(2);
      expect((yield* request("/workspace")).reads).toBe(3);
    }).pipe(Effect.scoped),
  30_000,
);
