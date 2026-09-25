import { describe, expect, it } from "@effect/vitest";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Deferred, Effect, Layer, Redacted, Result, Schema } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { memorySourceStorage } from "@executor-js/sdk/testing";
import { BlobStore, BlobStoreError, memoryBlobStore, type BlobKey } from "@executor-js/sdk/blobs";
import { retainWorkerBuild, loadWorkerBuild, workerBuildAsset } from "@executor-js/sdk/workerd";
import {
  BuildId,
  DeploymentBuildFailed,
  OwnerId,
  RuntimeBuildFailed,
  StorageError,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
  type Runtime,
} from "@executor-js/sdk/core";
import { database } from "../src/implementation/database.ts";

const owner = OwnerId.make("deploy-owner");
const files = [{ path: "index.ts", content: "source" }] as const;
const services = Layer.mergeAll(BrowserCrypto.layer, pgliteLayer());
const built = { build: BuildId.make("bld_parallel"), requirements: { accounts: {} } };

const fixture = (
  build: Runtime["build"],
  beforePut: (key: BlobKey) => Effect.Effect<void, BlobStoreError> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    const retained = memoryBlobStore();
    const writes: string[] = [];
    const executor = yield* createExecutor({
      storage,
      sources: memorySourceStorage(),
      blobs: {
        ...retained,
        put: (key, body) =>
          Effect.sync(() => writes.push(key)).pipe(
            Effect.andThen(beforePut(key)),
            Effect.andThen(retained.put(key, body)),
          ),
      },
      credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
      runtime: runtimeAdapter({
        build,
        skills: () => Effect.succeed([]),
        inspect: () => Effect.succeed([]),
        call: () => Effect.succeed(null),
        query: () => Effect.succeed(null),
        mutate: () => Effect.succeed(null),
        webhook: () => Effect.succeed(null),
        workflow: () => Effect.succeed(null),
      }),
    });
    return { executor, writes, db: database(storage) };
  });

describe("deploy publication", () => {
  it.live("new deployment source and workspace upload while the compiler is still running", () =>
    Effect.gen(function* () {
      const sourcesStarted = yield* Deferred.make<void>();
      let sources = 0;
      const { executor, writes } = yield* fixture(
        () => Deferred.await(sourcesStarted).pipe(Effect.as(built)),
        () =>
          Effect.gen(function* () {
            if (++sources === 2) yield* Deferred.succeed(sourcesStarted, undefined);
          }),
      );
      const result = yield* executor.apps
        .deploy({ owner, name: "Concurrent", files })
        .pipe(Effect.timeout("2 seconds"), Effect.result);
      expect(Result.isSuccess(result)).toBe(true);
      const deployed = yield* Effect.fromResult(result);
      expect(writes).toHaveLength(2);
      expect(writes).toContain(`deployments/${deployed.deployment.id}/source.json`);
      expect(writes).toContain(`app-source/${deployed.app.code}/initial.json`);
      expect((yield* executor.apps.source({ owner, app: deployed.app.id })).files).toEqual(files);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect("a source upload failure leaves no app or deployment reference", () =>
    Effect.gen(function* () {
      const { executor, db } = yield* fixture(
        () => Effect.succeed(built),
        (key) =>
          key.endsWith("source.json")
            ? Effect.fail(new BlobStoreError({ operation: "put" }))
            : Effect.void,
      );
      const error = yield* executor.apps
        .deploy({ owner, name: "Failed source", files })
        .pipe(Effect.flip);
      expect(Schema.is(StorageError)(error)).toBe(true);
      expect(yield* executor.apps.list({ owner })).toEqual([]);
      expect(yield* db.findMany("deployments", {})).toEqual([]);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect(
    "failed updates leave parallel uploads unreferenced and preserve the active build",
    () =>
      Effect.gen(function* () {
        const { executor, writes, db } = yield* fixture(({ files }) =>
          files[0]?.content === "bad"
            ? Effect.fail(new RuntimeBuildFailed({ stage: "compile" }))
            : Effect.succeed(built),
        );
        const first = yield* executor.apps.deploy({ owner, name: "Preserved", files });
        const error = yield* executor.apps
          .deploy({ owner, app: first.app.id, files: [{ path: "index.ts", content: "bad" }] })
          .pipe(Effect.flip);
        expect(Schema.is(DeploymentBuildFailed)(error)).toBe(true);
        expect((yield* executor.apps.get({ owner, app: first.app.id })).activeDeployment).toBe(
          first.deployment.id,
        );
        expect((yield* executor.apps.source({ owner, app: first.app.id })).files).toEqual(files);
        expect(yield* db.findMany("deployments", {})).toHaveLength(1);
        expect(writes.filter((key) => key.endsWith("initial.json"))).toHaveLength(1);
      }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.live("Worker metadata and UI objects upload together before the build returns", () =>
    Effect.gen(function* () {
      const allStarted = yield* Deferred.make<void>();
      const retained = memoryBlobStore();
      let started = 0;
      const blobs = {
        ...retained,
        put: (key: BlobKey, body: Uint8Array) =>
          Effect.gen(function* () {
            if (++started === 3) yield* Deferred.succeed(allStarted, undefined);
            yield* Deferred.await(allStarted);
            yield* retained.put(key, body);
          }),
      };
      const build = BuildId.make("bld_assets");
      const body = new TextEncoder().encode("asset");
      const result = yield* retainWorkerBuild(
        build,
        {
          mainModule: "server.js",
          modules: { "server.js": "export default {}" },
          database: false,
        },
        [
          { path: "main.js", contentType: "text/javascript", body },
          { path: "main.css", contentType: "text/css", body },
        ],
      ).pipe(Effect.provideService(BlobStore, blobs), Effect.timeout("2 seconds"), Effect.result);
      expect(Result.isSuccess(result)).toBe(true);
      const assets = yield* Effect.fromResult(result);
      expect(assets).toHaveLength(2);
      expect(
        (yield* loadWorkerBuild(build).pipe(Effect.provideService(BlobStore, retained))).ui,
      ).toEqual(assets);
      expect(
        (yield* workerBuildAsset(build, "main.js").pipe(Effect.provideService(BlobStore, retained)))
          ?.body,
      ).toEqual(body);
    }).pipe(Effect.scoped),
  );

  it.live("a partial Worker upload fails without returning a build reference", () =>
    Effect.gen(function* () {
      const retained = memoryBlobStore();
      const manifestWritten = yield* Deferred.make<void>();
      const blobs = {
        ...retained,
        put: (key: BlobKey, body: Uint8Array) =>
          key.endsWith(".json")
            ? retained
                .put(key, body)
                .pipe(Effect.andThen(Deferred.succeed(manifestWritten, undefined)), Effect.asVoid)
            : Deferred.await(manifestWritten).pipe(
                Effect.andThen(Effect.fail(new BlobStoreError({ operation: "put" }))),
              ),
      };
      const error = yield* retainWorkerBuild(
        BuildId.make("bld_partial"),
        {
          mainModule: "server.js",
          modules: { "server.js": "export default {}" },
          database: false,
        },
        [{ path: "main.js", contentType: "text/javascript", body: new Uint8Array([1]) }],
      ).pipe(Effect.provideService(BlobStore, blobs), Effect.flip, Effect.timeout("2 seconds"));
      expect(Schema.is(RuntimeBuildFailed)(error)).toBe(true);
      expect(error.stage).toBe("retain");
    }).pipe(Effect.scoped),
  );
});
