import { expect, it } from "@effect/vitest";
import { PgClient } from "@effect/sql-pg";
import { CompiledQuery, Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "@executor-js/hosted-server";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { makeNativeAuthDatabase } from "../src/implementation/auth-driver.ts";

const execute = promisify(execFile);
class FixtureFailed extends Schema.TaggedError<FixtureFailed>()("FixtureFailed", {}) {}
const docker = (args: string[]) =>
  Effect.tryPromise({
    try: () => execute("docker", args, { timeout: 20_000 }),
    catch: () => new FixtureFailed(),
  });

/** A disposable real server exercises the native wire protocol, not an internal fake. */
const fixture = Effect.gen(function* () {
  const container = `executor-auth-wire-${randomUUID()}`;
  yield* Effect.acquireRelease(
    docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:17",
    ]),
    () => docker(["rm", "--force", container]).pipe(Effect.orDie, Effect.asVoid),
  );
  yield* docker([
    "exec",
    container,
    "pg_isready",
    "--host",
    "127.0.0.1",
    "--username",
    "postgres",
  ]).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }));
  const mapping = (yield* docker(["port", container, "5432/tcp"])).stdout.trim();
  const address = yield* Schema.decodeUnknownEffect(
    Schema.String.check(Schema.isPattern(/^127\.0\.0\.1:\d+$/)),
  )(mapping);
  const url = Redacted.make(`postgresql://postgres@${address}/postgres?sslmode=disable`);
  const productServices = yield* Layer.build(
    PgClient.layer({ url, maxConnections: 1, prepare: false }),
  );
  const authServices = yield* Layer.build(
    PgClient.layer({ url, maxConnections: 1, prepare: false }),
  );
  const product = yield* PgClient.PgClient.pipe(Effect.provideContext(productServices));
  const db = yield* makeNativeAuthDatabase().pipe(Effect.provideContext(authServices));
  yield* product`create table fixture (id integer primary key, value text not null)`;
  return { product, db, url };
});

const query = (db: Kysely<unknown>, sql: string, parameters: readonly unknown[] = []) =>
  Effect.tryPromise({
    try: () => db.executeQuery(CompiledQuery.raw(sql, [...parameters])),
    catch: () => new FixtureFailed(),
  });

it.live(
  "native auth queries decode values, retain affected counts and hide driver details",
  () =>
    Effect.gen(function* () {
      const { db } = yield* fixture;
      const at = new Date("2030-01-02T03:04:05.000Z");
      const value = yield* query(
        db,
        "select $1::timestamp as expires, $2::boolean as active, $3::jsonb as data, $4::int8 as count, $5::text[] as empty",
        [at, true, { profile: "fixture" }, 42n, []],
      );
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            expires: Schema.Date,
            active: Schema.Boolean,
            data: Schema.Struct({ profile: Schema.String }),
            count: Schema.BigInt,
            empty: Schema.Array(Schema.String),
          }),
        ),
      )(value.rows);
      expect(rows).toEqual([
        { expires: at, active: true, data: { profile: "fixture" }, count: 42n, empty: [] },
      ]);
      expect(
        (yield* query(db, "insert into fixture values ($1, $2)", [1, "one"])).numAffectedRows,
      ).toBe(1n);
      const duplicate = yield* Effect.tryPromise({
        try: () =>
          db.executeQuery(
            CompiledQuery.raw("insert into fixture values ($1, $2)", [1, "duplicate"]),
          ),
        catch: (error) => error,
      }).pipe(Effect.flip);
      expect(
        (yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }))(duplicate)).code,
      ).toBe("23505");
      expect(
        (yield* query(db, "update fixture set value = $1 where id = $2", ["updated", 1]))
          .numAffectedRows,
      ).toBe(1n);
      expect((yield* query(db, "delete from fixture where id = $1", [1])).numAffectedRows).toBe(1n);
      const failed = yield* Effect.tryPromise(() =>
        db.executeQuery(CompiledQuery.raw("select $1::integer", ["synthetic-private-value"])),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(failed)).toBe(true);
      expect(Exit.match(failed, { onSuccess: () => "", onFailure: Cause.pretty })).not.toContain(
        "synthetic-private-value",
      );
    }),
  30_000,
);

it.live(
  "auth transactions serialize their pool, roll back and permit product callbacks",
  () =>
    Effect.gen(function* () {
      const { product, db } = yield* fixture;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const transaction = yield* Effect.forkChild(
        Effect.tryPromise({
          try: () =>
            db.transaction().execute((tx) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  yield* query(tx, "insert into fixture values (1, 'transaction')");
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  // This is the shape of Better Auth's member-limit/billing callback.
                  expect(
                    (yield* product`select count(*)::text as count from fixture`)[0]?.count,
                  ).toBe("0");
                }),
              ),
            ),
          catch: () => new FixtureFailed(),
        }),
      );
      yield* Deferred.await(entered);
      let completed = false;
      const queued = yield* Effect.forkChild(
        query(db, "select * from fixture").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
        ),
        { startImmediately: true },
      );
      expect(
        (yield* product`select count(*)::text as count from fixture`.pipe(
          Effect.timeout("2 seconds"),
        ))[0]?.count,
      ).toBe("0");
      expect(completed).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transaction);
      expect((yield* Fiber.join(queued)).rows).toEqual([{ id: 1, value: "transaction" }]);
      const rolledBack = yield* Effect.tryPromise({
        try: () =>
          db.transaction().execute((tx) =>
            Effect.runPromise(
              Effect.gen(function* () {
                yield* query(tx, "insert into fixture values (2, 'rolled back')");
                return yield* Effect.fail(new FixtureFailed());
              }),
            ),
          ),
        catch: () => new FixtureFailed(),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(rolledBack)).toBe(true);
      expect((yield* query(db, "select * from fixture order by id")).rows).toEqual([
        { id: 1, value: "transaction" },
      ]);
    }),
  30_000,
);

it.live(
  "both auth transports execute the same local PostgreSQL reads",
  () =>
    Effect.gen(function* () {
      const { db, url } = yield* fixture;
      const previous = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Kysely<unknown>({
              dialect: new PostgresDialect({
                pool: new Pool({ connectionString: Redacted.value(url), max: 1 }),
              }),
            }),
        ),
        (db) => Effect.promise(() => db.destroy()),
      );
      const cold = (database: Kysely<unknown>) =>
        Effect.gen(function* () {
          const started = performance.now();
          yield* query(database, "select 1 as value");
          return performance.now() - started;
        });
      const connectionSetup = { pg_ms: yield* cold(previous), native_ms: yield* cold(db) };
      const options = {
        ...authOptions({ url: "https://auth.example.test", oauthRedirectUri: Option.none() }, []),
        database: { db, type: "postgres" as const, transaction: true },
        secret: "synthetic-native-auth-benchmark-secret",
        rateLimit: { enabled: false },
      };
      const migrations = yield* Effect.promise(() => getMigrations(options));
      yield* Effect.promise(() => migrations.runMigrations());
      const auth = betterAuth(options);
      const context = yield* Effect.promise(() => auth.$context);
      const user = yield* Effect.promise(() =>
        context.internalAdapter.createUser(
          {
            name: "Fixture",
            email: "fixture@example.test",
            emailVerified: true,
          },
          { method: "admin" },
        ),
      );
      const session = yield* Effect.promise(() => context.internalAdapter.createSession(user.id));
      const organization = yield* Effect.promise(() =>
        auth.api.createOrganization({
          body: { name: "Fixture", slug: "fixture", userId: user.id },
        }),
      );
      expect(organization).not.toBeNull();
      if (organization === null) return yield* Effect.die("Missing synthetic organization");
      const sequence = [
        {
          name: "session",
          sql: 'select s.id, s."expiresAt", u.name from "session" s join "user" u on u.id = s."userId" where s.token = $1',
          parameters: [session.token],
        },
        {
          name: "organization",
          sql: "select id, slug from organization where id = $1 or slug = $1 limit 2",
          parameters: [organization.id],
        },
        {
          name: "membership",
          sql: 'select role from member where "userId" = $1 and "organizationId" = $2',
          parameters: [user.id, organization.id],
        },
      ];
      const samples = (database: Kysely<unknown>, sql: string, parameters: string[]) =>
        Effect.gen(function* () {
          const times: number[] = [];
          for (let index = 0; index < 30; index++) {
            const started = performance.now();
            expect((yield* query(database, sql, parameters)).rows).toHaveLength(1);
            times.push(performance.now() - started);
          }
          return times.sort((a, b) => a - b)[15];
        });
      const warmed = yield* Effect.forEach(sequence, ({ name, sql, parameters }) =>
        Effect.gen(function* () {
          return {
            name,
            pg_ms: yield* samples(previous, sql, parameters),
            native_ms: yield* samples(db, sql, parameters),
          };
        }),
      );
      const comparison = {
        environment: "local PostgreSQL without TLS; not deployed latency",
        samplesPerQuery: 30,
        connectionSetup,
        warmed,
      };
      yield* Effect.logInfo("Auth transport query comparison", comparison);
      yield* Effect.promise(() =>
        writeFile(
          new URL("../../../../.local/auth-driver-benchmark.json", import.meta.url),
          JSON.stringify(comparison, null, 2),
        ),
      );
    }),
  30_000,
);
