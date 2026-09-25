import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { mkdir, writeFile } from "node:fs/promises";

const Prepared = Schema.Struct({ state: Schema.Literals(["started", "ready"]) });

it.live(
  "native preparation initializes esbuild WASM once before the editor deploys",
  () =>
    Effect.gen(function* () {
      const outdir = new URL("../../../.local/compiler-preparation-native/", import.meta.url)
        .pathname;
      const compiled = yield* Effect.promise(() =>
        build({
          stdin: {
            resolveDir: new URL(".", import.meta.url).pathname,
            sourcefile: "compiler-preparation-native.ts",
            contents: `
          import { Effect, Tracer } from "effect";
          import { createApp, InMemoryFileSystem } from "@cloudflare/worker-bundler";
          import { makeCompilerPreparation } from "../src/implementation/compiler-preparation.ts";
          const prepare = makeCompilerPreparation();
          export default { async fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/compile") {
              const result = await createApp({files:new InMemoryFileSystem({"index.js":"export default {};"}),server:"index.js",installDependencies:false});
              return Response.json({compiled:typeof result.mainModule === "string"});
            }
            const spans = [];
            await Effect.runPromise(prepare.pipe(Effect.withSpan("prepare"),Effect.provideService(Tracer.Tracer,Tracer.make({span:options=>{
              const span = new Tracer.NativeSpan(options); spans.push(span); return span;
            }}))));
            return Response.json({state:spans[0].attributes.get("executor.compiler.preparation")});
          }};
        `,
          },
          bundle: true,
          write: false,
          outdir,
          format: "esm",
          platform: "browser",
          target: "es2022",
          conditions: ["workerd"],
          loader: { ".wasm": "copy" },
          external: ["cloudflare:*"],
        }),
      );
      const modules = compiled.outputFiles.map((file) => ({
        path: file.path,
        ...(file.path.endsWith(".wasm")
          ? { type: "CompiledWasm" as const, contents: file.contents }
          : { type: "ESModule" as const, contents: file.text }),
      }));
      modules.sort(
        (left, right) =>
          Number(left.type === "CompiledWasm") - Number(right.type === "CompiledWasm"),
      );
      const worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Miniflare({
              workers: [
                {
                  name: "prepared",
                  modules,
                  compatibilityDate: "2026-07-30",
                  compatibilityFlags: ["nodejs_compat"],
                },
                {
                  name: "cold",
                  modules,
                  compatibilityDate: "2026-07-30",
                  compatibilityFlags: ["nodejs_compat"],
                },
              ],
            }),
        ),
        (worker) => Effect.promise(() => worker.dispose()),
      );
      const started = performance.now();
      const first = yield* Effect.promise(async () =>
        (await worker.dispatchFetch("https://preparation.example/prepare")).json(),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Prepared)));
      const preparationMs = performance.now() - started;
      expect(first.state).toBe("started");
      const repeated = yield* Effect.promise(async () =>
        (await worker.dispatchFetch("https://preparation.example/prepare")).json(),
      ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Prepared)));
      expect(repeated.state).toBe("ready");
      const beforePrepared = performance.now();
      const prepared = yield* Effect.promise(async () =>
        (await worker.dispatchFetch("https://preparation.example/compile")).json(),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ compiled: Schema.Boolean }))),
      );
      const preparedCompileMs = performance.now() - beforePrepared;
      expect(prepared.compiled).toBe(true);
      const cold = yield* Effect.promise(() => worker.getWorker("cold"));
      const beforeCold = performance.now();
      const direct = yield* Effect.promise(async () =>
        (await cold.fetch("https://preparation.example/compile")).json(),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ compiled: Schema.Boolean }))),
      );
      const coldCompileMs = performance.now() - beforeCold;
      expect(direct.compiled).toBe(true);
      yield* Effect.promise(async () => {
        await mkdir(".local", { recursive: true });
        await writeFile(
          ".local/compiler-preparation-native-timings.json",
          JSON.stringify(
            {
              samples: 1,
              measurement:
                "One native workerd pair with trusted tiny source; not a production latency benchmark",
              preparationMs,
              preparedCompileMs,
              coldCompileMs,
            },
            null,
            2,
          ),
        );
      });
      yield* Effect.logInfo("Native compiler preparation timing", {
        preparationMs,
        preparedCompileMs,
        coldCompileMs,
      });
    }).pipe(Effect.scoped),
  30_000,
);
