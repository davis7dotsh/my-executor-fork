import { CurrentAuthorization } from "../contracts/authorization.ts";
import { permittedAppIds } from "@executor-js/authorization";
import { getAccount } from "./accounts.ts";
/** Sharing writes are atomic; metadata visibility and credential use remain separate. */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { teamAppPending } from "./provisioning.ts";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  StorageError,
  AccountNotFound,
  ProviderNotFound,
  AccountId,
  Provider,
  type AppId,
  type Profile,
} from "@executor-js/sdk/core";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { CurrentOrganization, OrganizationForbidden } from "../contracts/organization.ts";
import {
  AccessConflict,
  type AppAudience,
  type SharedAudience,
  type AccessRevision,
} from "../contracts/resource-access.ts";
import { requireGroupSharing } from "./group-sharing.ts";
import {
  policyDatabase,
  currentResourceAuthority,
  applicationAccesses,
  accountAccesses,
  requireAppAccess,
  requireAccountAccess,
} from "./resource-policy.ts";

const lockActor = Effect.gen(function* () {
  const actor = yield* currentResourceAuthority;
  const sql = yield* policyDatabase;
  const rows =
    yield* sql`select id from member where id = ${actor.member} and "userId" = ${actor.user} for share`;
  if (rows.length !== 1) return yield* new OrganizationForbidden();
  return actor;
});
/** Shared resource listing for the normal app/account lists and an explicit management view. */
export const resourceDirectory = (view: "available" | "managed" = "available") =>
  Effect.gen(function* () {
    const actor = yield* currentResourceAuthority;
    const executor = yield* Effect.flatten(HostedExecutor);
    const { owner } = yield* CurrentOrganization;
    const policy = yield* CurrentAuthorization;
    const apps = yield* executor.apps.list({ owner, ids: permittedAppIds(policy) });
    const appPolicies = new Map(
      (yield* applicationAccesses(
        apps.map((app) => app.id),
        actor,
      )).map((access) => [access.app, access]),
    );
    const selectedApps = apps.flatMap((app) => {
      const access = appPolicies.get(app.id);
      return access === undefined || !(view === "managed" ? access.canManage : access.canUse)
        ? []
        : [{ app, access }];
    });
    const profiles = yield* executor.apps.profiles.listMany({
      apps: selectedApps.filter(({ access }) => access.canUse).map(({ app }) => app.id),
      owner,
      subject: actor.user,
    });
    const byApp = new Map<AppId, Profile[]>();
    for (const profile of profiles) {
      const existing = byApp.get(profile.app);
      if (existing === undefined) byApp.set(profile.app, [profile]);
      else existing.push(profile);
    }
    const appEntries = selectedApps.map(({ app, access }) => ({
      app,
      access,
      profiles: access.canUse ? (byApp.get(app.id) ?? []) : [],
    }));
    const selected = new Set(
      appEntries.flatMap(({ profiles }) =>
        profiles
          .map((profile) => profile.accounts)
          .flatMap((accounts) =>
            Object.values(accounts).flatMap((value) =>
              typeof value === "string" ? [value] : value,
            ),
          ),
      ),
    );
    const accounts = (yield* executor.accounts.list({ owner })).filter(
      (account) => policy.tools.kind === "all" || selected.has(account.id),
    );
    const accountPolicies = new Map(
      (yield* accountAccesses(
        accounts.map((account) => account.id),
        actor,
      )).map((access) => [access.account, access]),
    );
    const selectedAccounts = accounts.flatMap((account) => {
      const access = accountPolicies.get(account.id);
      return access === undefined || !(view === "managed" ? access.canManage : access.canUse)
        ? []
        : [{ account, access }];
    });
    // Provider definitions are public metadata. Read them only for accounts
    // admitted above, with the same owner predicate the SDK's point read uses.
    const providerRows =
      selectedAccounts.length === 0
        ? []
        : yield* Effect.gen(function* () {
            const sql = yield* policyDatabase;
            const rows = yield* sql`select a.id as account, p.id, p.definition
              from executor_accounts a left join executor_providers p on p.id = a.provider
              where a.owner = ${owner} and ${sql.in(
                "a.id",
                selectedAccounts.map(({ account }) => account.id),
              )}`;
            return yield* Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  account: AccountId,
                  id: Schema.NullOr(Provider.fields.id),
                  definition: Schema.NullOr(Provider.fields.definition),
                }),
              ),
            )(rows);
          }).pipe(
            Effect.catchTags({
              SqlError: () => new StorageError(),
              SchemaError: () => new StorageError(),
            }),
          );
    const providers = new Map(providerRows.map((row) => [row.account, row]));
    const accountEntries = yield* Effect.forEach(selectedAccounts, ({ account, access }) =>
      Effect.gen(function* () {
        const row = providers.get(account.id);
        if (row === undefined) return yield* new AccountNotFound({ account: account.id });
        if (row.id === null) return yield* new ProviderNotFound({ provider: account.provider });
        if (row.definition === null) return yield* new StorageError();
        return {
          account,
          access,
          provider: Provider.make({ id: row.id, definition: row.definition }),
        };
      }),
    );
    const pendingApp =
      policy.tools.kind === "all" && (view === "available" || actor.role !== "member")
        ? yield* teamAppPending(actor.organization).pipe(
            Effect.provideService(SqlClient.SqlClient, yield* policyDatabase),
          )
        : false;
    return { apps: appEntries, accounts: accountEntries, pendingApp };
  });
/** The compare-and-swap revision protects settings and all group grants as one update. */
export const shareApp = (
  app: AppId,
  audience: typeof AppAudience.Type,
  revision: typeof AccessRevision.Type,
) =>
  Effect.gen(function* () {
    const sql = yield* policyDatabase;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const actor = yield* lockActor;
        const access = yield* requireAppAccess(app, "manage");
        if (audience.kind === "private" && access.creator === null)
          return yield* new AccessConflict({ reason: "creator_unavailable" });
        if (audience.kind === "groups")
          yield* requireGroupSharing(sql, actor.organization, actor.user, audience.groups);
        const changed =
          yield* sql`update hosted_app_access set audience = ${audience.kind}, revision = gen_random_uuid()::text
      where id = ${app} and organization_id = ${actor.organization} and revision = ${revision} returning id`;
        if (changed.length !== 1) return yield* new AccessConflict({ reason: "changed" });
        yield* sql`delete from hosted_app_groups where app_id = ${app}`;
        if (audience.kind === "groups")
          for (const group of audience.groups)
            yield* sql`insert into hosted_app_groups (organization_id, app_id, group_id) values (${actor.organization}, ${app}, ${group})`;
      }),
    );
    return yield* requireAppAccess(app, "read");
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/** Personal account ownership cannot be changed by editing shared-account grants. */
export const shareAccount = (
  account: AccountId,
  audience: typeof SharedAudience.Type,
  revision: typeof AccessRevision.Type,
) =>
  Effect.gen(function* () {
    yield* getAccount((yield* CurrentOrganization).owner, account);
    const sql = yield* policyDatabase;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const actor = yield* lockActor;
        const access = yield* requireAccountAccess(account, "manage");
        if (access.ownership.kind === "personal")
          return yield* new AccessConflict({ reason: "personal_account" });
        if (audience.kind === "groups")
          yield* requireGroupSharing(sql, actor.organization, actor.user, audience.groups);
        const changed =
          yield* sql`update hosted_account_access set audience = ${audience.kind}, revision = gen_random_uuid()::text
      where account_id = ${account} and organization_id = ${actor.organization} and revision = ${revision} returning account_id`;
        if (changed.length !== 1) return yield* new AccessConflict({ reason: "changed" });
        yield* sql`delete from hosted_account_groups where account_id = ${account}`;
        if (audience.kind === "groups")
          for (const group of audience.groups)
            yield* sql`insert into hosted_account_groups (organization_id, account_id, group_id) values (${actor.organization}, ${account}, ${group})`;
      }),
    );
    return yield* requireAccountAccess(account, "read");
  }).pipe(
    Effect.catchTags({ SqlError: () => new StorageError(), SchemaError: () => new StorageError() }),
  );
/** Both hosted products register the same authenticated policy handlers. */
export const hostedResourceAccessHandlers = HttpApiBuilder.group(
  HostedApi,
  "resourceAccess",
  (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle("directory", ({ query }) => resourceDirectory(query.view))
        .handle("app", ({ params }) => requireAppAccess(params.app, "read"))
        .handle("shareApp", ({ params, payload }) =>
          shareApp(params.app, payload.audience, payload.revision),
        )
        .handle("account", ({ params }) =>
          Effect.gen(function* () {
            yield* getAccount((yield* CurrentOrganization).owner, params.account);
            return yield* requireAccountAccess(params.account, "read");
          }),
        )
        .handle("shareAccount", ({ params, payload }) =>
          shareAccount(params.account, payload.audience, payload.revision),
        );
    }),
);
