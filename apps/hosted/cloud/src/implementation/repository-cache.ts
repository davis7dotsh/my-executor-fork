/** Cache immutable Git metadata and source only after the product authorizes its caller. */
import { Commit, GitCommit, type RepositoryBackend } from "@executor-js/app-source/contracts";
import { SourceFiles } from "@executor-js/sdk/core";
import { Effect, Option, Schema } from "effect";

class RepositoryCacheFailed extends Schema.TaggedError<RepositoryCacheFailed>()(
  "RepositoryCacheFailed",
  {},
) {}
const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new RepositoryCacheFailed() }).pipe(
    Effect.timeout("2 seconds"),
  );
const historySchema = Schema.fromJsonString(Schema.Array(GitCommit));
const snapshotSchema = Schema.fromJsonString(Schema.Struct({ commit: Commit, files: SourceFiles }));
const history = Schema.decodeUnknownOption(historySchema);
const snapshot = Schema.decodeUnknownOption(snapshotSchema);

/** Keys include the repository namespace; no request, token, live client or actor is retained. */
export const cachedRepositories = (
  backend: RepositoryBackend,
  namespace: string,
  storage: Pick<CacheStorage, "open"> = globalThis.caches,
): RepositoryBackend => {
  const key = (id: string, commit: string, operation: string) =>
    `https://executor-repository-cache.invalid/${encodeURIComponent(namespace)}/${encodeURIComponent(id)}/${operation}/${commit}`;
  const read = (key: string) =>
    Effect.gen(function* () {
      const cache = yield* cached(() => storage.open("executor-private-repositories-v1")).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      const text =
        cache === undefined
          ? undefined
          : yield* cached(() => cache.match(key)).pipe(
              Effect.flatMap((response) =>
                response?.status === 200
                  ? cached(() => response.text())
                  : Effect.succeed(undefined),
              ),
              Effect.catch(() => Effect.succeed(undefined)),
            );
      return { cache, text };
    });
  const write = (cache: Cache | undefined, key: string, body: string) =>
    cache === undefined
      ? Effect.void
      : cached(() =>
          cache.put(
            key,
            new Response(body, {
              headers: {
                "content-type": "application/json",
                "cache-control": "public, max-age=86400",
              },
            }),
          ),
        ).pipe(Effect.ignore);
  return {
    ...backend,
    history: (id) =>
      Effect.gen(function* () {
        // Always read the current head, including after commits and external force pushes.
        const head = yield* backend.head(id, "main");
        if (head === null || !Schema.is(Commit)(head)) return yield* backend.history(id);
        const cacheKey = key(id, head, "history");
        const { cache, text } = yield* read(cacheKey);
        const hit = history(text);
        if (Option.isSome(hit) && hit.value[0]?.commit === head) {
          yield* Effect.annotateCurrentSpan("source.history.cache", "hit");
          return hit.value;
        }
        yield* Effect.annotateCurrentSpan("source.history.cache", "miss");
        const rows = yield* backend.history(id);
        // A concurrent commit may land between the head probe and clone; never label it as the old head.
        if (rows[0]?.commit === head)
          yield* Schema.encodeEffect(historySchema)(rows).pipe(
            Effect.flatMap((body) => write(cache, cacheKey, body)),
            Effect.ignore,
          );
        return rows;
      }).pipe(Effect.withSpan("source.git.history.cached")),
    read: (id, ref) =>
      Effect.gen(function* () {
        // Mutable workspace branches remain live. Retained commit displays are immutable.
        if (!Schema.is(Commit)(ref)) return yield* backend.read(id, ref);
        const cacheKey = key(id, ref, "source");
        const { cache, text } = yield* read(cacheKey);
        const hit = snapshot(text);
        if (Option.isSome(hit) && hit.value.commit === ref) {
          yield* Effect.annotateCurrentSpan("source.snapshot.cache", "hit");
          return hit.value;
        }
        yield* Effect.annotateCurrentSpan("source.snapshot.cache", "miss");
        const value = yield* backend.read(id, ref);
        if (value.commit === ref)
          yield* Schema.encodeEffect(snapshotSchema)(value).pipe(
            Effect.flatMap((body) => write(cache, cacheKey, body)),
            Effect.ignore,
          );
        return value;
      }).pipe(Effect.withSpan("source.git.snapshot.cached")),
  };
};
