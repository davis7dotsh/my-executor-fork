/** Cache only the public catalog feed; imports and product authorization stay live. */
import { CatalogEntry, type CatalogSource } from "@executor-js/catalog";
import { Clock, Effect, Schema } from "effect";

class CatalogCacheFailed extends Schema.TaggedError<CatalogCacheFailed>()(
  "CatalogCacheFailed",
  {},
) {}

const cached = <A>(read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: () => new CatalogCacheFailed() }).pipe(
    Effect.timeout("2 seconds"),
  );

const storedFeed = Schema.fromJsonString(
  Schema.Struct({
    expiresAt: Schema.Number.check(Schema.isFinite()),
    entries: Schema.Array(CatalogEntry),
  }),
);
const ttlSeconds = 600;

/** Each request supplies its own source; the Cache API retains no client, session or runtime. */
export const cachedCatalogSource = (
  origin: string,
  source: CatalogSource,
  storage: Pick<CacheStorage, "open"> = globalThis.caches,
): CatalogSource => ({
  ...source,
  list: Effect.gen(function* () {
    const key = new URL("/_executor/public-catalog/v1", origin).href;
    const cache = yield* cached(() => storage.open("executor-public-catalog-v1")).pipe(
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
                    Effect.flatMap(Schema.decodeUnknownEffect(storedFeed)),
                  ),
            ),
            Effect.catch(() => Effect.succeed(undefined)),
          );
    const now = yield* Clock.currentTimeMillis;
    if (hit !== undefined && hit.expiresAt > now && hit.expiresAt <= now + ttlSeconds * 1000) {
      yield* Effect.annotateCurrentSpan("catalog.cache", "hit");
      return hit.entries;
    }
    yield* Effect.annotateCurrentSpan("catalog.cache", "miss");
    const entries = yield* source.list;
    if (cache !== undefined) {
      const expiresAt = (yield* Clock.currentTimeMillis) + ttlSeconds * 1000;
      yield* Schema.encodeEffect(storedFeed)({ expiresAt, entries }).pipe(
        Effect.flatMap((body) =>
          cached(() =>
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
    return entries;
  }).pipe(Effect.withSpan("catalog.feed.cached")),
});
