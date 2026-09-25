/** Initialize the existing bundler with trusted source, never authored modules or dependencies. */
import { createApp, InMemoryFileSystem } from "@cloudflare/worker-bundler";
import { RuntimeBuildFailed } from "@executor-js/sdk/core";
import { Effect } from "effect";

const initialize = Effect.tryPromise({
  try: () =>
    createApp({
      files: new InMemoryFileSystem({ "prepare.js": "export default {};" }),
      server: "prepare.js",
      installDependencies: false,
      minify: true,
    }),
  catch: () => new RuntimeBuildFailed({ stage: "compile" }),
}).pipe(Effect.asVoid);

/** Keep only isolate readiness; no Promise, caller scope, identity, or user source is retained. */
export const makeCompilerPreparation = (
  prepare: Effect.Effect<void, RuntimeBuildFailed> = initialize,
) => {
  let state: "cold" | "running" | "ready" = "cold";
  return Effect.suspend(() => {
    const before = state;
    if (before !== "cold")
      return Effect.annotateCurrentSpan("executor.compiler.preparation", before);
    state = "running";
    return prepare.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          state = "ready";
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (state === "running") state = "cold";
        }),
      ),
      Effect.tap(() => Effect.annotateCurrentSpan("executor.compiler.preparation", "started")),
    );
  });
};
