import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router"
import { AppShell } from "./components/AppShell.tsx"
import { HomeRoute } from "./routes/home.tsx"
import { SettingsRoute } from "./routes/settings.tsx"
import { ThreadRoute } from "./routes/thread.tsx"

const rootRoute = createRootRoute({ component: AppShell })

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomeRoute })

export const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/thread/$threadId",
  component: ThreadRoute,
  /** `agent` opens the sub-agent whose tool calls carry that `parentCallId` instead of the thread's own transcript. */
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === "string" ? { agent: search.agent } : {},
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
  /** `page` opens one settings page, such as `environments`. `environment` picks the cloud the Environment pages edit. */
  validateSearch: (search: Record<string, unknown>): { page?: string; environment?: string } => ({
    ...(typeof search.page === "string" ? { page: search.page } : {}),
    ...(typeof search.environment === "string" ? { environment: search.environment } : {}),
  }),
})

// Electron has no address bar, and memory history keeps working under file:// in production.
export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, threadRoute, settingsRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
