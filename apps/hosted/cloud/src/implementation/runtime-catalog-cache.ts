/** Short-lived metadata only. Credentials and current authority are resolved before every read. */
import { Clock, Effect, Redacted, Schema } from "effect";
import { facetIdentity } from "@executor-js/app-data/cloudflare";
import type { BuildId } from "@executor-js/sdk/core";
import type { HostContext } from "apps/contracts";

class RuntimeCatalogCacheFailed extends Schema.TaggedError<RuntimeCatalogCacheFailed>()(
  "RuntimeCatalogCacheFailed",
  {},
) {}

const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new RuntimeCatalogCacheFailed() }).pipe(
    Effect.timeout("2 seconds"),
  );
const ttlSeconds = 30;
const maximumBytes = 2 * 1024 * 1024;

/** Include live credential fields so replacing credentials never reuses an earlier catalog. */
export const runtimeCatalogIdentity = (
  app: string,
  build: BuildId,
  accounts: HostContext["accounts"],
  revision?: string,
) =>
  facetIdentity(build, JSON.stringify({ accounts: Redacted.value(accounts), revision })).pipe(
    Effect.map((identity) => `${app}:${identity}`),
  );

/** The private synthetic URL contains only an app/build/credential/revision digest, never credentials. */
export const cachedRuntimeCatalog = <A, E, R>(
  origin: string,
  operation: "tools" | "workflows",
  identity: string,
  schema: Schema.Codec<A>,
  load: Effect.Effect<A, E, R>,
  storage: Pick<CacheStorage, "open"> = globalThis.caches,
) =>
  Effect.gen(function* () {
    const encoded = Schema.fromJsonString(
      Schema.Struct({
        expiresAt: Schema.Number.check(Schema.isFinite()),
        value: schema,
      }),
    );
    const key = new URL(
      `/_executor/runtime-catalog-cache/v1/${operation}/${encodeURIComponent(identity)}`,
      origin,
    ).href;
    const cache = yield* cached(() => storage.open("executor-private-runtime-catalogs-v1")).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const hit =
      cache === undefined
        ? undefined
        : yield* cached(() => cache.match(key)).pipe(
            Effect.flatMap((response) =>
              response === undefined || response.status !== 200
                ? Effect.succeed(undefined)
                : cached(() => response.text()).pipe(
                    Effect.flatMap((text) =>
                      text.length > maximumBytes
                        ? Effect.succeed(undefined)
                        : Schema.decodeUnknownEffect(encoded)(text),
                    ),
                  ),
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );
    const now = yield* Clock.currentTimeMillis;
    if (hit !== undefined && hit.expiresAt > now && hit.expiresAt <= now + ttlSeconds * 1000) {
      yield* Effect.annotateCurrentSpan("executor.catalog.cache", "hit");
      return hit.value;
    }
    yield* Effect.annotateCurrentSpan("executor.catalog.cache", "miss");
    const value = yield* load;
    if (cache !== undefined) {
      const expiresAt = (yield* Clock.currentTimeMillis) + ttlSeconds * 1000;
      yield* Schema.encodeEffect(encoded)({ expiresAt, value }).pipe(
        Effect.flatMap((body) =>
          new TextEncoder().encode(body).byteLength > maximumBytes
            ? Effect.void
            : cached(() =>
                cache.put(
                  key,
                  new Response(body, {
                    headers: {
                      "content-type": "application/json",
                      "cache-control": `public, max-age=${ttlSeconds}`,
                    },
                  }),
                ),
              ),
        ),
        Effect.ignore,
      );
    }
    return value;
  }).pipe(Effect.withSpan("runtime.cloud.catalog.cached"));
