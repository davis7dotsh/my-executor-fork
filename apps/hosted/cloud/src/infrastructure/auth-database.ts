/** The hosted auth database is Postgres; other SQL drivers do not belong in this Worker. */
import { Database } from "@alchemy.run/better-auth/Database";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Option, Schema } from "effect";
import { type QueryId } from "kysely";
import { cloudDatabaseConnection } from "./database.ts";
import { makeNativeAuthDatabase } from "../implementation/auth-driver.ts";

const DriverCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/)),
});
class AuthDatabaseFailed extends Schema.TaggedError<AuthDatabaseFailed>()("AuthDatabaseFailed", {
  code: Schema.String,
}) {}

/** Resolve the selected database transport once; Postgres keeps its pool in the invocation scope. */
export const cloudAuthDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const connection = yield* cloudDatabaseConnection;
    return Layer.succeed(
      Database,
      Database.of({
        provider: "postgres",
        runtime: Effect.gen(function* () {
          // Match the product's native transport without sharing its max-one
          // pool across Better Auth transactions and product callbacks.
          const url = yield* connection.connectionString;
          const services = yield* Layer.build(
            PgClient.layer({ url, maxConnections: 1, prepare: false }),
          ).pipe(Effect.orDie);
          // This trusted host callback needs the complete invocation context.
          const context = yield* Effect.context<never>();
          const started = new WeakMap<QueryId, number>();
          const db = yield* makeNativeAuthDatabase({
            plugins: [
              {
                transformQuery: ({ queryId, node }) => {
                  started.set(queryId, Date.now());
                  return node;
                },
                transformResult: ({ result }) => Promise.resolve(result),
              },
            ],
            log: (event) => {
              const start = started.get(event.query.queryId);
              started.delete(event.query.queryId);
              return Effect.runPromiseWith(context)(
                (event.level === "error"
                  ? Effect.fail(
                      new AuthDatabaseFailed({
                        code: Option.match(Schema.decodeUnknownOption(DriverCode)(event.error), {
                          onNone: () => "UnknownDriverError",
                          onSome: ({ code }) => code,
                        }),
                      }),
                    )
                  : Effect.void
                ).pipe(
                  Effect.withSpan("auth.sql.timing", {
                    attributes: {
                      "db.query.kind": event.query.query.kind,
                      "db.query.duration_ms": event.queryDurationMillis,
                      "db.query.success": event.level === "query",
                      "db.query.parameter_count": event.query.parameters.length,
                      "db.query.clock": "cloudflare-io",
                      "db.query.driver": "effect-pg",
                      ...(start === undefined
                        ? {}
                        : { "db.query.compile_to_result_ms": Date.now() - start }),
                    },
                  }),
                  Effect.withErrorReporting,
                  Effect.ignore,
                ),
              );
            },
          }).pipe(Effect.provideContext(services));
          // SSO account resolution and membership provisioning require real
          // transactions; the Kysely adapter otherwise runs callbacks without one.
          return { db, type: "postgres" as const, transaction: true };
        }),
      }),
    );
  }),
);
