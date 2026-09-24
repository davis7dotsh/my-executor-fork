import { describe, expect, it } from "@effect/vitest";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Effect, Layer, Redacted, Schema, Tracer } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { memorySourceStorage } from "@executor-js/sdk/testing";
import {
  AppNotFound,
  BuildId,
  DeploymentNotFound,
  OwnerId,
  ProfileConflict,
  SkillRevisionChanged,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
} from "@executor-js/sdk/core";

const owner = OwnerId.make("skill-owner");
const document = "---\nname: guide\ndescription: A guide\n---\nInstructions.";
const files = [
  { path: "index.ts", content: "app source" },
  { path: "skills/guide/SKILL.md", content: document },
] as const;
const services = Layer.mergeAll(BrowserCrypto.layer, pgliteLayer());

const fixture = () =>
  Effect.gen(function* () {
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    const retained = memoryBlobStore();
    const reads: string[] = [];
    const evaluations: string[] = [];
    const executor = yield* createExecutor({
      storage,
      sources: memorySourceStorage(),
      blobs: {
        ...retained,
        get: (key) => Effect.sync(() => reads.push(key)).pipe(Effect.andThen(retained.get(key))),
      },
      credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
      runtime: runtimeAdapter({
        build: ({ files }) =>
          Effect.succeed({
            build: BuildId.make(`bld_${files[0]?.content ?? "current"}`),
            requirements: {
              accounts: {},
              ...(files[0]?.content === "legacy" ? {} : { capabilities: { skills: true } }),
            },
          }),
        skills: ({ build }) =>
          Effect.sync(() => {
            evaluations.push(build);
            return [
              {
                name: "guide",
                description: "A guide",
                files: [{ path: "SKILL.md", content: document }],
              },
            ];
          }),
        inspect: () => Effect.succeed([]),
        call: () => Effect.succeed(null),
        query: () => Effect.succeed(null),
        mutate: () => Effect.succeed(null),
        webhook: () => Effect.succeed(null),
        workflow: () => Effect.succeed(null),
      }),
    });
    return { executor, reads, evaluations };
  });

describe("skill snapshots", () => {
  it.effect("runtime catalogs use one joined app read and no retained-source blob", () =>
    Effect.gen(function* () {
      const { executor, reads, evaluations } = yield* fixture();
      const { app, deployment } = yield* executor.apps.deploy({ owner, name: "Current", files });
      const spans: Tracer.Span[] = [];
      const bundle = yield* executor.skills.bundle({ app: app.id, owner }).pipe(
        Effect.provideService(
          Tracer.Tracer,
          Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              spans.push(span);
              return span;
            },
          }),
        ),
      );
      expect(bundle.deployment).toBe(deployment.id);
      expect(bundle.skills[0]?.files[0]?.content).toBe(document);
      expect(reads).toEqual([]);
      expect(evaluations).toEqual([deployment.build]);
      const queries = spans
        .filter((span) => span.name === "sql.execute")
        .map((span) =>
          Schema.decodeUnknownSync(Schema.String)(span.attributes.get("db.query.text")),
        );
      expect(queries.filter((query) => query.includes('"executor_apps"'))).toHaveLength(1);
      yield* executor.skills
        .read({ app: app.id, owner, name: "guide", revision: "0".repeat(64) })
        .pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => expect(Schema.is(SkillRevisionChanged)(error)).toBe(true)),
          ),
        );
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect("legacy folders stay readable without evaluating the runtime", () =>
    Effect.gen(function* () {
      const { executor, reads, evaluations } = yield* fixture();
      const { app } = yield* executor.apps.deploy({
        owner,
        name: "Legacy",
        files: [{ path: "index.ts", content: "legacy" }, ...files.slice(1)],
      });
      const bundle = yield* executor.skills.bundle({ app: app.id, owner });
      expect(bundle.skills[0]?.name).toBe("guide");
      expect(reads).toHaveLength(1);
      expect(evaluations).toEqual([]);
    }).pipe(Effect.provide(services), Effect.scoped),
  );

  it.effect("owner, lineage, selected profile and historical build checks precede evaluation", () =>
    Effect.gen(function* () {
      const { executor, reads, evaluations } = yield* fixture();
      const first = yield* executor.apps.deploy({ owner, name: "Pinned", files });
      const other = yield* executor.apps.deploy({ owner, name: "Other", files });
      yield* executor.skills
        .bundle({ app: first.app.id, owner: OwnerId.make("another-owner") })
        .pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => expect(Schema.is(AppNotFound)(error)).toBe(true)),
          ),
        );
      yield* executor.skills
        .bundle({ app: first.app.id, owner, deployment: other.deployment.id })
        .pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => expect(Schema.is(DeploymentNotFound)(error)).toBe(true)),
          ),
        );
      const profile = yield* executor.apps.profiles.create({
        app: first.app.id,
        owner,
        subject: "skill-user",
        accounts: {},
        idempotencyKey: "skill-profile",
      });
      yield* executor.skills
        .bundle({
          app: first.app.id,
          owner,
          profile: profile.id,
          expectedProfileRevision: profile.revision + 1,
        })
        .pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => expect(Schema.is(ProfileConflict)(error)).toBe(true)),
          ),
        );
      expect(evaluations).toEqual([]);
      yield* executor.apps.deploy({
        app: first.app.id,
        owner,
        files: [{ path: "index.ts", content: "later" }],
      });
      const pinned = yield* executor.skills.bundle({
        app: first.app.id,
        owner,
        deployment: first.deployment.id,
      });
      expect(pinned.deployment).toBe(first.deployment.id);
      expect(evaluations).toEqual([first.deployment.build]);
      expect(reads).toEqual([]);
    }).pipe(Effect.provide(services), Effect.scoped),
  );
});
