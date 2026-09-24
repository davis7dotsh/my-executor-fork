import { AppId, type ProfileId } from "@executor-js/sdk";
import { OrganizationReference } from "@executor-js/hosted-server/organization";
import { accountContexts, selectedAccountContext } from "@executor-js/ui/dashboard/account-group";
import { Effect, Schema } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";
import { appAtom, sourceAtom, toolsAtom, deploymentsAtom } from "./apps.ts";
import { profilesSourceAtom } from "./profiles.ts";
import { appAccessAtom } from "./resource-access.ts";
import { appBrowserBindings } from "./app-browser.ts";
import { appManagement } from "./app-management.ts";
import type { AppView } from "@executor-js/ui/contracts/dashboard";

/** Router loaders and mounted views use one page-owned atom registry. */
export interface DashboardRouterContext {
  readonly registry: AtomRegistry.AtomRegistry;
}

/** Warm reads through the same atoms used by the page, including exact profile revisions. */
export const preloadAppDetail = (
  registry: AtomRegistry.AtomRegistry,
  input: {
    organizationSlug: string;
    appId: string;
    view?: AppView | undefined;
    profile?: ProfileId | undefined;
    tool?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const organization = yield* Schema.decodeUnknownEffect(OrganizationReference)(
      input.organizationSlug,
    );
    const app = yield* Schema.decodeUnknownEffect(AppId)(input.appId);
    const key = { organization, app };
    const [current, profiles, access] = yield* Effect.all(
      [
        AtomRegistry.getResult(registry, appAtom(key)),
        AtomRegistry.getResult(registry, profilesSourceAtom(key)),
        AtomRegistry.getResult(registry, appAccessAtom(key)),
      ],
      { concurrency: "unbounded" },
    );
    const view = input.view ?? (input.tool === undefined ? "overview" : "tools");
    if (access.canManage && (view === "source" || view === "history")) {
      const management = appManagement(organization);
      registry.get(management.source(app));
      registry.get(management.history(app));
    }
    if (access.canManage && view === "deployments") {
      registry.get(deploymentsAtom(key));
      if (current.activeDeployment !== null)
        registry.get(sourceAtom({ ...key, deployment: current.activeDeployment }));
    }
    if (!access.canUse) return;
    const context = selectedAccountContext(accountContexts(current, profiles, true), input.profile);
    if (context === undefined) return;
    const bindings = appBrowserBindings(organization, current, context.profile);
    if (view === "skills") {
      if (current.activeDeployment !== null) registry.get(bindings.bundle);
      if (access.canManage) registry.get(appManagement(organization).workspace(app));
    }
    if (
      view === "tools" &&
      context.profile?.enabled !== false &&
      context.profile?.status !== "removing"
    )
      registry.get(
        toolsAtom({
          ...key,
          deployment: current.activeDeployment ?? undefined,
          profile: context.profile?.id,
          expectedProfileRevision: context.profile?.revision,
          accounts: JSON.stringify(context.accounts),
        }),
      );
    if (view === "workflows") registry.get(bindings.workflows);
  }).pipe(Effect.asVoid);
