import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router"

const rootRoute = createRootRoute({ component: Outlet })

const pullRequestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/thread/$threadId/pull-request",
  component: lazyRouteComponent(() => import("./components/PullRequestWindow.tsx"), "PullRequestWindow"),
  validateSearch: (search: Record<string, unknown>): { url: string } => ({
    url: typeof search.url === "string" ? search.url : "",
  }),
})

export const pullRequestWindowRouter = (entry: string) =>
  createRouter({
    routeTree: rootRoute.addChildren([pullRequestRoute]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  })
