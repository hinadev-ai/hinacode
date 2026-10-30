import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router"
import { AppShell } from "./components/AppShell.tsx"
import { registry } from "./lib/registry.ts"
import { settingsAtom } from "./lib/rpc.ts"
import { HomeRoute } from "./routes/home.tsx"
import { ThreadRoute } from "./routes/thread.tsx"

const rootRoute = createRootRoute({ component: AppShell })

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomeRoute })

export const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/thread/$threadId",
  component: ThreadRoute,
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === "string" ? { agent: search.agent } : {},
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./routes/settings.tsx"), "SettingsRoute"),
  validateSearch: (search: Record<string, unknown>): { page?: string; environment?: string } => ({
    ...(typeof search.page === "string" ? { page: search.page } : {}),
    ...(typeof search.environment === "string" ? { environment: search.environment } : {}),
  }),
  onEnter: ({ search }) => registry.refresh(settingsAtom(search.environment ?? null)),
})

const LOCATION_KEY = "hinacode.location"

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, threadRoute, settingsRoute]),
  history: createMemoryHistory({ initialEntries: [localStorage.getItem(LOCATION_KEY) ?? "/"] }),
})

router.subscribe("onResolved", ({ toLocation }) => localStorage.setItem(LOCATION_KEY, toLocation.href))

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
