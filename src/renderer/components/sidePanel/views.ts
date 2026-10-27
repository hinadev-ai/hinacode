import type { ComponentType } from "react"
import type { IconType } from "react-icons"
import {
  RiFileCopy2Line,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiInformationLine,
  RiRobot2Line,
  RiFileEditLine,
  RiGlobalLine,
  RiComputerLine,
  RiSmartphoneLine,
} from "react-icons/ri"
import type { ExperimentalSettings, Thread } from "../../../shared/domain.ts"
import type { CommandId } from "../../keybindings/commands.ts"
import type { EnvironmentId } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import type { SidePanelViewId } from "../../stores/ui.ts"
import { GitGraphView } from "../GitGraphView.tsx"
import { useRunningSubagentCount } from "../ThreadAgents.tsx"
import { BrowserTabStrip } from "./BrowserTabStrip.tsx"
import { BrowserView } from "./BrowserView.tsx"
import { ChangesView } from "./ChangesView.tsx"
import { DevicesView } from "./devices/DevicesView.tsx"
import { DetailsView } from "./DetailsView.tsx"
import { FilesView } from "./FilesView.tsx"
import { AgentsView, PullRequestsView } from "./SimpleViews.tsx"
import { TinyVmView } from "./TinyVmView.tsx"

export interface SidePanelView {
  readonly id: SidePanelViewId
  readonly icon: IconType
  readonly title: () => string
  /** The command that shows the view, whose chord the activity bar tooltip shows. */
  readonly commandId: CommandId
  readonly component: ComponentType<{ thread: Thread }>
  /** Takes the place of the title in the panel header. */
  readonly header?: ComponentType<{ thread: Thread }>
  /** A hook the activity bar calls on every render. A count above 0 shows on the icon. */
  readonly badge?: (threadId: string) => number
  /** The experiment the view belongs to. It is hidden while the experiment is off. */
  readonly experiment?: keyof ExperimentalSettings
}

/** Every side panel view, in activity bar order. The bar and the content area render from this alone. */
export const sidePanelViews: ReadonlyArray<SidePanelView> = [
  {
    id: "details",
    icon: RiInformationLine,
    title: m.panel_tab_details,
    commandId: "view.details",
    component: DetailsView,
  },
  { id: "files", icon: RiFileCopy2Line, title: m.panel_tab_files, commandId: "view.files", component: FilesView },
  { id: "changes", icon: RiFileEditLine, title: m.panel_changes, commandId: "view.changes", component: ChangesView },
  { id: "git", icon: RiGitBranchLine, title: m.panel_tab_git, commandId: "view.git", component: GitGraphView },
  {
    id: "pullRequests",
    icon: RiGitPullRequestLine,
    title: m.pr_links_title,
    commandId: "view.pullRequests",
    component: PullRequestsView,
  },
  {
    id: "agents",
    icon: RiRobot2Line,
    title: m.panel_tab_agents,
    commandId: "view.agents",
    component: AgentsView,
    badge: useRunningSubagentCount,
  },
  {
    id: "browser",
    icon: RiGlobalLine,
    title: m.panel_tab_browser,
    commandId: "view.browser",
    component: BrowserView,
    header: BrowserTabStrip,
  },
  {
    id: "tinyVm",
    icon: RiComputerLine,
    title: m.panel_tab_tiny_vm,
    commandId: "view.tinyVm",
    component: TinyVmView,
    experiment: "tinyVm",
  },
  {
    id: "devices",
    icon: RiSmartphoneLine,
    title: m.panel_tab_devices,
    commandId: "view.devices",
    component: DevicesView,
    experiment: "devices",
  },
]

/** The views whose experiment, if any, is turned on. */
export const useSidePanelViews = (environment: EnvironmentId): ReadonlyArray<SidePanelView> => {
  const { experimental } = useSettings(environment)
  return sidePanelViews.filter((view) => view.experiment === undefined || experimental[view.experiment])
}

/** The view to show for `id`, or the first one when `id` is not among `views`, such as a view whose experiment was turned off. */
export const viewById = (views: ReadonlyArray<SidePanelView>, id: SidePanelViewId) =>
  views.find((view) => view.id === id) ?? views[0]!
