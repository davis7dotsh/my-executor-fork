import { preloadAppDetail } from "@executor-js/hosted-web/contracts/route-preload";
import { Effect } from "effect";
import { AccountConnectionDialog } from "@executor-js/hosted-web/pages/connection-dialog";
import { createFileRoute } from "@tanstack/react-router";
import { AppDetailPage } from "@executor-js/hosted-web/pages/app-detail";
import { OpenAppAction } from "@executor-js/hosted-web/pages/app-sign-in";
import { parseAppSearch } from "@executor-js/hosted-web/contracts/navigation";

export const Route = createFileRoute("/org/$organizationSlug/apps/$appId")({
  validateSearch: parseAppSearch,
  loaderDeps: ({ search }) => ({ view: search.view, profile: search.profile, tool: search.tool }),
  loader: ({ context, params, deps }) => {
    // This warms the page registry without introducing a second data cache or gating its frame.
    Effect.runFork(preloadAppDetail(context.registry, { ...params, ...deps }).pipe(Effect.ignore));
  },
  component: AppPage,
});
function AppPage() {
  const { appId } = Route.useParams();
  const { view, tool, profile, connection, client } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <>
      <AppDetailPage
        appId={appId}
        view={view}
        tool={tool}
        profile={profile}
        openApp={(app, selected) => <OpenAppAction app={app} profile={selected?.id} />}
      />
      <AccountConnectionDialog
        connectionId={connection}
        client={client}
        onClose={() => {
          void navigate({ search: { view, tool, profile }, replace: true });
        }}
      />
    </>
  );
}
