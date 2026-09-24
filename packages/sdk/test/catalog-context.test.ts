import { expect, it } from "@effect/vitest";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { Effect, Layer, Redacted, Schema } from "effect";
import { pgliteLayer } from "fumadb-effect/pglite";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { memorySourceStorage } from "@executor-js/sdk/testing";
import {
  BuildId,
  OwnerId,
  ProfileConflict,
  aesGcmCredentials,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
} from "@executor-js/sdk/core";

it.effect(
  "catalog reads always resolve current profile and credential state before the runtime",
  () =>
    Effect.gen(function* () {
      const storage = yield* makeExecutorStorage({ provider: "postgresql" });
      yield* storage.migrate;
      const seen: Array<readonly [string, string | undefined, string]> = [];
      const owner = OwnerId.make("catalog-owner");
      const executor = yield* createExecutor({
        storage,
        sources: memorySourceStorage(),
        blobs: memoryBlobStore(),
        credentials: yield* aesGcmCredentials(Redacted.make("ab".repeat(32)), crypto),
        runtime: runtimeAdapter({
          build: () =>
            Effect.succeed({
              build: BuildId.make("bld_catalog"),
              requirements: {
                accounts: {
                  service: {
                    cardinality: "one",
                    definition: {
                      name: "Synthetic",
                      auth: {
                        key: {
                          type: "secrets",
                          label: "API key",
                          fields: {
                            type: "object",
                            properties: { token: { type: "string" } },
                            required: ["token"],
                          },
                        },
                      },
                    },
                  },
                },
              },
            }),
          inspect: (input) =>
            Effect.sync(() => {
              seen.push([
                "tools",
                input.catalogRevision,
                JSON.stringify(Redacted.value(input.accounts)),
              ]);
              return [];
            }),
          workflow: (input) =>
            Effect.sync(() => {
              seen.push([
                input.command.operation,
                input.catalogRevision,
                JSON.stringify(Redacted.value(input.accounts)),
              ]);
              return [];
            }),
          skills: () => Effect.succeed([]),
          call: () => Effect.succeed(null),
          query: () => Effect.succeed(null),
          mutate: () => Effect.succeed(null),
          webhook: () => Effect.succeed(null),
        }),
      });
      const { app } = yield* executor.apps.deploy({
        owner,
        name: "Catalog",
        files: [{ path: "index.ts", content: "source" }],
      });
      const provider = app.requirements.accounts.service?.provider;
      if (provider === undefined) return yield* Effect.die("Fixture has no account requirement");
      const account = yield* executor.accounts.add({
        owner,
        provider,
        method: "key",
        label: "Synthetic",
        fields: Redacted.make({ token: "synthetic-original" }),
      });
      const profile = yield* executor.apps.profiles.create({
        owner,
        app: app.id,
        subject: "catalog-user",
        accounts: { service: account.id },
        idempotencyKey: "catalog-profile",
      });
      const input = { app: app.id, profile: profile.id };
      yield* executor.tools.list(input);
      yield* executor.apps.workflows.list(input);
      expect(seen.map(([operation]) => operation)).toEqual(["tools", "workflows"]);
      expect(seen[0]?.[1]).toMatch(/^[a-f0-9]{64}$/);
      expect(seen[1]?.[1]).toBe(seen[0]?.[1]);
      yield* executor.accounts.replaceCredentials({
        account: account.id,
        owner,
        fields: Redacted.make({ token: "synthetic-replaced" }),
      });
      yield* executor.tools.list(input);
      expect(seen[2]?.[1]).not.toBe(seen[0]?.[1]);
      expect(seen[2]?.[2]).toContain("synthetic-replaced");
      expect(seen[2]?.[2]).not.toContain("synthetic-original");
      yield* executor.accounts.replaceCredentials({
        account: account.id,
        owner,
        fields: Redacted.make({ token: "synthetic-replaced" }),
      });
      yield* executor.tools.list(input);
      expect(seen[3]?.[2]).toBe(seen[2]?.[2]);
      expect(seen[3]?.[1]).not.toBe(seen[2]?.[1]);
      expect((yield* executor.apps.profiles.get(input)).revision).toBe(profile.revision);
      const updated = yield* executor.apps.profiles.update({
        ...input,
        expectedRevision: profile.revision,
        accounts: { service: account.id },
        webhookConfig: { changed: true },
      });
      yield* executor.apps.workflows.list(input);
      expect(seen[4]?.[1]).not.toBe(seen[3]?.[1]);
      yield* executor.apps.profiles.setEnabled({
        ...input,
        expectedRevision: updated.revision,
        enabled: false,
      });
      yield* executor.tools.list(input).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => expect(Schema.is(ProfileConflict)(error)).toBe(true)),
        ),
      );
      expect(seen).toHaveLength(5);
    }).pipe(Effect.provide(Layer.mergeAll(BrowserCrypto.layer, pgliteLayer())), Effect.scoped),
);
