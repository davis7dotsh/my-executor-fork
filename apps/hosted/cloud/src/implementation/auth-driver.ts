/** Better Auth's Kysely boundary over the native Effect PostgreSQL transport. */
import { PgClient } from "@effect/sql-pg";
import { Cause, Effect, Exit, Option, Scope, Schema } from "effect";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type KyselyConfig,
} from "kysely";

class AuthQueryFailed extends Schema.TaggedError<AuthQueryFailed>()("AuthQueryFailed", {
  code: Schema.String,
}) {}

const DriverFailure = Schema.Struct({
  reason: Schema.Struct({
    cause: Schema.Struct({
      code: Schema.String.check(Schema.isPattern(/^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/)),
    }),
  }),
});
const queryFailure = (cause: unknown) =>
  new AuthQueryFailed({
    code: Option.match(Schema.decodeUnknownOption(DriverFailure)(cause), {
      onNone: () => "UnknownDriverError",
      onSome: ({ reason }) => reason.cause.code,
    }),
  });

const QueryResult = Schema.Struct({
  command: Schema.String,
  rowCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
});

// Kysely's pg boundary accepts JSON objects and empty arrays without type
// hints. Send their textual representation so PostgreSQL derives the target
// column type, as it did with pg; native scalar values keep their codecs.
const nativeParameters = (parameters: readonly unknown[]) =>
  parameters.map((value) => {
    if (Array.isArray(value) && value.length === 0) return "{}";
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      !ArrayBuffer.isView(value)
    )
      return JSON.stringify(value);
    return value;
  });

/**
 * Kysely reserves one native connection for an entire transaction. The caller
 * owns the PgClient and its event scope; destroying Kysely releases only its
 * reservations. This auth pool stays separate from product queries because
 * Better Auth's transaction callbacks can call the product's billing services.
 */
export const makeNativeAuthDatabase = (options: Pick<KyselyConfig, "plugins" | "log"> = {}) =>
  Effect.gen(function* () {
    const client = yield* PgClient.PgClient;
    const owner = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const releases = new Map<DatabaseConnection, () => Promise<void>>();
    // Kysely/Better Auth inspect PostgreSQL codes on rejected Error values.
    // Preserve that Promise contract without exposing driver messages or SQL.
    const run = <A, E>(effect: Effect.Effect<A, E>, options?: Effect.RunOptions) =>
      Effect.runPromiseExitWith(context)(effect, options).then((exit) =>
        Exit.match(exit, {
          onSuccess: (value) => Promise.resolve(value),
          onFailure: (cause) =>
            Promise.reject(
              Option.getOrElse(Cause.findErrorOption(cause), () => queryFailure(undefined)),
            ),
        }),
      );
    const driver: Driver = {
      init: () => run(Effect.void),
      acquireConnection: (options) =>
        run(
          Effect.gen(function* () {
            const scope = yield* Scope.fork(owner, "sequential");
            const native = yield* client.reserve.pipe(
              Scope.provide(scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
              Effect.mapError(queryFailure),
            );
            const connection: DatabaseConnection = {
              executeQuery: <R>(
                query: CompiledQuery,
                options?: Parameters<DatabaseConnection["executeQuery"]>[1],
              ) =>
                run(
                  Effect.try(() => nativeParameters(query.parameters)).pipe(
                    Effect.flatMap((parameters) => native.executeRaw(query.sql, parameters)),
                    Effect.flatMap(Schema.decodeUnknownEffect(QueryResult)),
                    Effect.mapError(queryFailure),
                    Effect.map((result) => ({
                      // Kysely owns the query's row type; the wire result above
                      // is checked before crossing its generic driver boundary.
                      rows: [...result.rows] as R[],
                      ...(["INSERT", "UPDATE", "DELETE", "MERGE"].includes(result.command)
                        ? { numAffectedRows: BigInt(result.rowCount) }
                        : {}),
                    })),
                  ),
                  options,
                ),
              async *streamQuery<R>(query: CompiledQuery) {
                yield await connection.executeQuery<R>(query);
              },
            };
            releases.set(connection, () => run(Scope.close(scope, Exit.void)));
            return connection;
          }),
          options,
        ),
      beginTransaction: (connection, settings) =>
        run(
          Effect.promise(() =>
            connection.executeQuery(
              CompiledQuery.raw(
                [
                  "begin",
                  settings.isolationLevel === undefined
                    ? ""
                    : `isolation level ${settings.isolationLevel}`,
                  settings.accessMode ?? "",
                ].join(" "),
              ),
            ),
          ).pipe(Effect.asVoid),
        ),
      commitTransaction: (connection) =>
        run(
          Effect.promise(() => connection.executeQuery(CompiledQuery.raw("commit"))).pipe(
            Effect.asVoid,
          ),
        ),
      rollbackTransaction: (connection) =>
        run(
          Effect.promise(() => connection.executeQuery(CompiledQuery.raw("rollback"))).pipe(
            Effect.asVoid,
          ),
        ),
      releaseConnection: (connection) =>
        run(
          Effect.gen(function* () {
            const release = releases.get(connection);
            if (release !== undefined) {
              releases.delete(connection);
              yield* Effect.promise(release);
            }
          }),
        ),
      destroy: () =>
        run(
          Effect.forEach(
            releases.keys(),
            (connection) => Effect.promise(() => driver.releaseConnection(connection)),
            { discard: true },
          ),
        ),
    };
    return yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Kysely<unknown>({
            ...options,
            dialect: {
              createDriver: () => driver,
              createAdapter: () => new PostgresAdapter(),
              createIntrospector: (db) => new PostgresIntrospector(db),
              createQueryCompiler: () => new PostgresQueryCompiler(),
            },
          }),
      ),
      (db) => Effect.promise(() => db.destroy()),
    );
  });
