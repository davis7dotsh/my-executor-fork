import type { DashboardRouterContext } from "@executor-js/hosted-web/contracts/route-preload";
import { PagePending } from "@executor-js/hosted-web/page-pending";
import { PageError } from "@executor-js/hosted-web/route-fallbacks";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.ts";

/** Browser-only navigation with generated routes and split page bundles. */
export const createDashboardRouter = (registry: DashboardRouterContext["registry"]) =>
  createRouter({
    routeTree,
    context: { registry },
    defaultPreload: "intent",
    defaultPendingComponent: PagePending,
    defaultPendingMs: 100,
    defaultPendingMinMs: 0,
    defaultErrorComponent: PageError,
    scrollRestoration: true,
    scrollToTopSelectors: ["main"],
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createDashboardRouter>;
  }
}
