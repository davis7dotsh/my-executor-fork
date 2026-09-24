import { evaluationFailure, snapshot as invocation, resolve } from "./tools.ts";
import { AppSkills } from "apps/contracts";
import { AppEvaluationFailed } from "../contracts/tools.ts";
/** Skill reads project one authorized runtime catalog, or a retained pre-capability folder. */
import { Crypto, Effect, Encoding, Schema } from "effect";
import type { BlobStorage } from "../contracts/blobs.ts";
import { AppSkillInputs, AppSkillNotFound, SkillRevisionChanged } from "../contracts/skills.ts";
import { RequestInvalid, StorageError } from "../contracts/shared.ts";
import { prepareAppSkills } from "./skill-source.ts";
import { readDeploymentSource } from "./deployment-source.ts";

/** Bind skill reads to the same app lookup and retained-source lineage used by deployment inspection. */
export const makeSkills = (
  blobs: BlobStorage,
  db: import("./database.ts").Query,
  runtime: import("../contracts/runtime.ts").Runtime,
  resolveAccount: ReturnType<typeof import("./oauth.ts").makeOAuth>["resolve"],
  crypto: Crypto.Crypto,
  lifecycle?: import("../contracts/executor.ts").ResourceLifecycle,
) => {
  const snapshot = (input: typeof AppSkillInputs.list.Type) =>
    Effect.gen(function* () {
      const state = yield* invocation(db, { ...input, skillCatalog: true });
      const { app } = state;
      const deployment = state.deployment.id;
      // A retained framework that predates dynamic skills cannot receive the new command.
      // Its immutable bundled skills remain readable until its owner deploys a newer build.
      const live =
        state.deployment.requirements.capabilities?.skills === true
          ? yield* Effect.gen(function* () {
              const context = yield* resolve(state, resolveAccount, lifecycle);
              const skills = yield* runtime
                .skills({ app: app.id, build: state.deployment.build, ...context })
                .pipe(
                  Effect.mapError((error) =>
                    evaluationFailure(
                      { app: app.id, deployment },
                      error,
                      "Skill evaluation failed",
                    ),
                  ),
                );
              return { skills, profile: state.profile };
            })
          : {
              skills: yield* readDeploymentSource(blobs, deployment).pipe(
                Effect.flatMap(prepareAppSkills),
              ),
              profile: undefined,
            };
      const skills = yield* Schema.decodeUnknownEffect(AppSkills)(live.skills).pipe(
        Effect.mapError(
          () =>
            new AppEvaluationFailed({ app: app.id, deployment, reason: "Invalid skill catalog" }),
        ),
        Effect.map((skills) =>
          [...skills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((skill) => ({
              ...skill,
              files: [...skill.files].sort((a, b) => a.path.localeCompare(b.path)),
            })),
        ),
      );
      const revision = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(JSON.stringify(skills)))
        .pipe(
          Effect.map(Encoding.encodeHex),
          Effect.mapError(() => new StorageError()),
        );
      if (input.revision !== undefined && input.revision !== revision)
        return yield* new SkillRevisionChanged({
          app: app.id,
          expected: input.revision,
          current: revision,
        });
      return {
        app: { id: app.id, name: app.name, slug: app.slug },
        deployment,
        revision,
        skills,
        ...(live.profile === undefined
          ? {}
          : { profile: live.profile.id, profileRevision: live.profile.revision }),
      };
    });
  return {
    bundle: (input: typeof AppSkillInputs.list.Type) =>
      Schema.decodeUnknownEffect(AppSkillInputs.list)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap(snapshot),
        Effect.withSpan("sdk.skills.bundle"),
      ),
    list: (input: typeof AppSkillInputs.list.Type) =>
      Schema.decodeUnknownEffect(AppSkillInputs.list)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap(snapshot),
        Effect.map((snapshot) => ({
          ...snapshot,
          skills: snapshot.skills.map(({ files: _files, ...metadata }) => metadata),
        })),
        Effect.withSpan("sdk.skills.list"),
      ),
    read: (input: typeof AppSkillInputs.read.Type) =>
      Schema.decodeUnknownEffect(AppSkillInputs.read)(input).pipe(
        Effect.mapError(() => new RequestInvalid()),
        Effect.flatMap((input) =>
          Effect.gen(function* () {
            const { skills, ...identity } = yield* snapshot(input);
            const { app } = identity;
            const skill = skills.find((skill) => skill.name === input.name);
            const file = input.file ?? "SKILL.md";
            const resource = skill?.files.find((resource) => resource.path === file);
            if (skill === undefined || resource === undefined)
              return yield* new AppSkillNotFound({ app: app.id, name: input.name, file });
            const { files, ...metadata } = skill;
            return {
              ...metadata,
              ...identity,
              file,
              content: resource.content,
              files: files.map((file) => file.path),
            };
          }),
        ),
        Effect.withSpan("sdk.skills.read"),
      ),
  };
};
