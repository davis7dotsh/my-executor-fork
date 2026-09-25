import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/unstable/http";
import { NetAddress } from "effect/unstable/net";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  AppAccess,
  AppAccessDenied,
  AppIdentity,
  AppManagementHost,
  AppSourceView,
  appManagementApi,
  appManagementRoutes,
} from "@executor-js/app-management";
import { gitSourceStorage } from "@executor-js/app-source";
import { nativeRepositories } from "@executor-js/app-source/node";
import { remoteRegistry } from "@executor-js/app-registry";
import {
  OwnerId,
  SourceFiles,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
} from "@executor-js/sdk/core";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { nodeRuntime } from "@executor-js/sdk/node";
import { AuthoringBackground } from "../src/contracts/authoring-background.ts";

/** Real source storage and HTTP routing exercise the hook's authority and request lifetime. */
it.live(
  "only editable full workspaces prepare through their current background callback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "authoring-preparation-" });
        const storage = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* storage.migrate;
        const blobs = memoryBlobStore();
        const repositories = nativeRepositories(`${directory}/repositories`);
        const sources = gitSourceStorage(repositories);
        const executor = yield* createExecutor({
          storage,
          blobs,
          sources,
          credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
          runtime: nodeRuntime({ workDirectory: `${directory}/runtime` }),
        });
        const owner = OwnerId.make("fixture");
        const files = SourceFiles.make([
          {
            path: "index.ts",
            content:
              "throw new Error('Preparation must not execute authored source'); export default {};",
          },
        ]);
        const app = yield* executor.apps.create({ owner, name: "Source hook", files });
        const scheduled: string[] = [];
        const completed: string[] = [];
        const release = yield* Deferred.make<void>();
        const finished = yield* Deferred.make<void>();
        const backgroundScope = yield* Effect.scope;
        const prepareAuthoring = Effect.gen(function* () {
          const submit = yield* AuthoringBackground;
          yield* submit(Deferred.await(release));
        });
        const access = Layer.succeed(AppAccess, (response) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.headers.authorization !== "Bearer fixture")
              return yield* new AppAccessDenied({ reason: "authentication" });
            const role = request.headers["x-fixture-role"];
            return yield* response.pipe(
              Effect.provideService(AppIdentity, {
                owner,
                readOwner: role === "foreign" ? OwnerId.make("other") : owner,
                scope: "fixture",
                namespace: "fixture",
                actor: role ?? "editor",
                canWrite: role !== "member" && role !== "readonly",
                protectedApps: role === "protected" ? [app.id] : [],
                ...(role === "restricted" ? { appIds: [] } : {}),
              }),
            );
          }),
        );
        const host = Layer.succeed(
          AppManagementHost,
          Effect.succeed({
            executor,
            sources,
            repositories,
            blobs,
            publisher: undefined,
            registry: remoteRegistry("https://registry.invalid"),
            prepareAuthoring,
            access: (_app, identity) =>
              Effect.succeed({
                visible: true,
                manage: identity.actor !== "member",
                edit: identity.canWrite && identity.actor !== "noedit",
              }),
          }),
        );
        const handle = yield* HttpRouter.toHttpEffect(
          appManagementRoutes(appManagementApi("/api", AppAccess)).pipe(
            Layer.provide(access),
            HttpRouter.provideRequest(host),
          ),
        );
        const server = yield* HttpServer.HttpServer;
        if (!NetAddress.isInetAddress(server.address))
          return yield* Effect.die("Expected a native HTTP listener.");
        const origin = `http://127.0.0.1:${server.address.port}`;
        yield* server.serve(
          Effect.gen(function* () {
            const label =
              (yield* HttpServerRequest.HttpServerRequest).headers["x-fixture-request"] ?? "";
            return yield* handle.pipe(
              Effect.provideService(AuthoringBackground, (work) =>
                Effect.gen(function* () {
                  scheduled.push(label);
                  yield* Effect.forkIn(
                    work.pipe(
                      Effect.tap(() =>
                        Effect.gen(function* () {
                          completed.push(label);
                          if (completed.length === 2) yield* Deferred.succeed(finished, undefined);
                        }),
                      ),
                    ),
                    backgroundScope,
                  );
                }),
              ),
            );
          }),
        );
        const request = (path: string, role = "editor", label = "") =>
          Effect.scoped(
            Effect.gen(function* () {
              const client = HttpClient.withScope(yield* HttpClient.HttpClient);
              const response = yield* client.get(origin + path, {
                headers: {
                  authorization: "Bearer fixture",
                  "x-fixture-role": role,
                  "x-fixture-request": label,
                },
              });
              return { status: response.status, body: yield* response.text };
            }),
          );
        const path = `/api/apps/${app.id}`;
        expect((yield* request(`${path}/authoring`)).status).toBe(200);
        expect((yield* request(`${path}/workspace/display`)).status).toBe(200);
        expect(scheduled).toEqual([]);
        expect((yield* request(`${path}/workspace`, "member")).status).toBe(403);
        expect((yield* request(`${path}/workspace`, "foreign")).status).toBe(404);
        expect((yield* request(`${path}/workspace`, "restricted")).status).toBe(403);
        for (const role of ["readonly", "noedit", "protected"]) {
          const response = yield* request(`${path}/workspace`, role);
          expect(response.status).toBe(200);
          const view = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AppSourceView))(
            response.body,
          );
          expect(view.canEdit).toBe(false);
        }
        expect(scheduled).toEqual([]);
        const first = yield* request(`${path}/workspace`, "editor", "first");
        expect(first.status).toBe(200);
        expect(scheduled).toEqual(["first"]);
        expect(completed).toEqual([]);
        const firstView = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AppSourceView))(
          first.body,
        );
        expect(firstView.files).toEqual(files);
        const second = yield* request(`${path}/workspace`, "editor", "second");
        expect(second.status).toBe(200);
        expect(scheduled).toEqual(["first", "second"]);
        expect(completed).toEqual([]);
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(finished);
        expect(completed.toSorted()).toEqual(["first", "second"]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpServer.layerTest,
          pgliteLayer(),
          FetchHttpClient.layer,
        ),
      ),
    ),
  15_000,
);
