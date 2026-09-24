import type { AuthContext } from "@better-auth/core";
import { expect, it } from "@effect/vitest";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { makeAuthDatabase } from "@executor-js/mcp-auth/node-database";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import {
  authOptions,
  resolveOrganizationReference,
  lookupMembership,
  sessionPrincipal,
  OrganizationReference,
} from "@executor-js/hosted-server";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const db = yield* makeAuthDatabase;
  const options = {
    ...authOptions(
      { url: "https://organization.example.test", oauthRedirectUri: Option.none() },
      [],
    ),
    database: { db, type: "postgres" as const, transaction: true },
    secret: "synthetic-organization-reference-secret",
    rateLimit: { enabled: false },
  };
  const migration = yield* Effect.promise(() => getMigrations(options));
  yield* Effect.promise(() => migration.runMigrations());
  const auth = betterAuth(options);
  const context = yield* Effect.promise(() => auth.$context);
  const reads: Parameters<AuthContext["adapter"]["findMany"]>[0][] = [];
  const adapter: Pick<AuthContext["adapter"], "findMany"> = {
    findMany: (input) => {
      reads.push(input);
      return context.adapter.findMany(input);
    },
  };
  yield* sql`insert into "organization" (id, name, slug, "createdAt")
    values ('org_alpha', 'Alpha', 'alpha', now()), ('org_beta', 'Beta', 'beta', now())`;
  return { sql, context, adapter, reads };
});

const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(pgliteLayer()));

it.live("returns the canonical id and slug in one lookup for either reference", () =>
  withDatabase(
    Effect.gen(function* () {
      const { adapter, reads } = yield* fixture;
      for (const reference of ["alpha", "org_alpha"]) {
        const before = reads.length;
        const resolved = yield* resolveOrganizationReference(
          adapter,
          Schema.decodeUnknownSync(OrganizationReference)(reference),
        );
        expect(resolved).toEqual({ id: "org_alpha", slug: "alpha" });
        expect(reads.length - before).toBe(1);
        expect(reads[before]).toMatchObject({ select: ["id", "slug"], limit: 2 });
      }
    }),
  ),
);

it.live("refuses unknown and ambiguous id-or-slug references", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, adapter } = yield* fixture;
      const missing = yield* resolveOrganizationReference(
        adapter,
        Schema.decodeUnknownSync(OrganizationReference)("missing"),
      ).pipe(Effect.flip);
      expect(missing._tag).toBe("OrganizationForbidden");
      yield* sql`update "organization" set slug = 'org_alpha' where id = 'org_beta'`;
      const ambiguous = yield* resolveOrganizationReference(
        adapter,
        Schema.decodeUnknownSync(OrganizationReference)("org_alpha"),
      ).pipe(Effect.flip);
      expect(ambiguous._tag).toBe("OrganizationForbidden");
    }),
  ),
);

it.live("reads role changes and revocation on the next request without retaining membership", () =>
  withDatabase(
    Effect.gen(function* () {
      const { sql, context, adapter } = yield* fixture;
      yield* sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values ('user_alpha', 'Alpha User', 'alpha@example.test', true, now(), now())`;
      yield* sql`insert into member (id, "organizationId", "userId", role, "createdAt")
        values ('member_alpha', 'org_alpha', 'user_alpha', 'admin', now())`;
      const principal = yield* sessionPrincipal({
        user: { id: "user_alpha", name: "Alpha User" },
        session: { id: "session_alpha" },
      });
      if (principal === null) return yield* Effect.die("Missing synthetic principal");
      const membership = Effect.gen(function* () {
        const resolved = yield* resolveOrganizationReference(
          adapter,
          Schema.decodeUnknownSync(OrganizationReference)("alpha"),
        );
        return yield* lookupMembership(context.adapter, principal, resolved.id);
      });
      expect((yield* membership).role).toBe("admin");
      yield* sql`update member set role = 'member' where id = 'member_alpha'`;
      expect((yield* membership).role).toBe("member");
      yield* sql`delete from member where id = 'member_alpha'`;
      expect((yield* membership.pipe(Effect.flip))._tag).toBe("OrganizationForbidden");
    }),
  ),
);
