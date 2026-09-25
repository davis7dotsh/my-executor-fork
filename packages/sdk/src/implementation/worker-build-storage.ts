/** Publish immutable browser objects and Worker metadata before returning a build reference. */
import { BlobKey, BlobStore } from "../contracts/blobs.ts";
import { RuntimeBuildFailed, RuntimeBuildUnavailable } from "../contracts/runtime.ts";
import type { BuildId } from "../contracts/shared.ts";
import type { UiBuildFile } from "../contracts/ui-build.ts";
import { Effect, Option, Schema } from "effect";
import { RetainedWorkerBuild, type WorkerBundle } from "../contracts/worker-build.ts";

const key = (value: string) => Schema.decodeUnknownEffect(BlobKey)(value);

/** A successful return makes both server code and every listed UI object available. Failed publication yields no build reference. */
export const retainWorkerBuild = (
  build: BuildId,
  bundle: WorkerBundle & Pick<typeof RetainedWorkerBuild.Type, "database">,
  ui: readonly UiBuildFile[] | undefined,
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const metadata = ui?.map(({ path, contentType }) => ({ path, contentType }));
    const encoded = yield* Schema.encodeEffect(RetainedWorkerBuild)({
      ...bundle,
      ...(metadata === undefined ? {} : { ui: metadata }),
    });
    const body = new TextEncoder().encode(JSON.stringify(encoded));
    yield* Effect.annotateCurrentSpan({
      "executor.build.retained_bytes": body.byteLength,
      "executor.build.module_count": Object.keys(bundle.modules).length,
    });
    // A partial upload is unreferenced: callers publish the build only after every put succeeds.
    yield* Effect.forEach(
      [
        ...(ui ?? []).map((file) => ({ path: `${build}/ui/${file.path}`, body: file.body })),
        { path: `${build}.json`, body },
      ],
      (file) =>
        Effect.gen(function* () {
          yield* blobs.put(yield* key(file.path), file.body);
        }),
      { concurrency: 8, discard: true },
    );
    return metadata;
  }).pipe(
    Effect.mapError(() => new RuntimeBuildFailed({ stage: "retain" })),
    Effect.withSpan("runtime.cloud.retain"),
  );

/** Previous Worker-only bundles remain valid: UI metadata is optional. */
export const loadWorkerBuild = (build: BuildId) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const found = yield* blobs.get(yield* key(`${build}.json`));
    if (Option.isNone(found)) return yield* new RuntimeBuildUnavailable();
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RetainedWorkerBuild))(
      new TextDecoder().decode(found.value),
    );
  }).pipe(Effect.mapError(() => new RuntimeBuildUnavailable()));

/** The product authenticates access; this capability serves only assets listed in the immutable build. */
export const workerBuildAsset = (build: BuildId, path: string) =>
  Effect.gen(function* () {
    const assetKey = Schema.decodeUnknownOption(BlobKey)(`${build}/ui/${path}`);
    if (Option.isNone(assetKey)) return undefined;
    const blobs = yield* BlobStore;
    // Both immutable objects can load together. The manifest still authorizes
    // the exact asset before any bytes leave this capability.
    const { retained, found } = yield* Effect.all(
      {
        retained: loadWorkerBuild(build).pipe(Effect.withSpan("runtime.cloud.asset.manifest")),
        found: blobs.get(assetKey.value).pipe(Effect.withSpan("runtime.cloud.asset.object")),
      },
      { concurrency: 2 },
    );
    const asset = retained.ui?.find((asset) => asset.path === path);
    if (asset === undefined) return undefined;
    if (Option.isNone(found)) return yield* new RuntimeBuildUnavailable();
    return { body: found.value, contentType: asset.contentType };
  }).pipe(
    Effect.mapError(() => new RuntimeBuildUnavailable()),
    Effect.withSpan("runtime.cloud.asset"),
  );
