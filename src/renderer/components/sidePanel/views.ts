import type { ComponentType } from "react"
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
import { DetailsView } from "./DetailsView.tsx"
import { FilesView } from "./FilesView.tsx"
import { AgentsView, PullRequestsView } from "./SimpleViews.tsx"
import { TinyVmView } from "./TinyVmView.tsx"
import { BranchIcon } from "../icons/BranchIcon.tsx"
import { ComputerIcon } from "../icons/ComputerIcon.tsx"
import { FileDiffIcon } from "../icons/FileDiffIcon.tsx"
import { FilesIcon } from "../icons/FilesIcon.tsx"
import { GlobeIcon } from "../icons/GlobeIcon.tsx"
import type { IconComponent } from "../icons/Icon.tsx"
import { InfoIcon } from "../icons/InfoIcon.tsx"
import { PullRequestIcon } from "../icons/PullRequestIcon.tsx"
import { RobotIcon } from "../icons/RobotIcon.tsx"

export interface SidePanelView {
  readonly id: SidePanelViewId
  readonly icon: IconComponent
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
    icon: InfoIcon,
    title: m.panel_tab_details,
    commandId: "view.details",
    component: DetailsView,
  },
  { id: "files", icon: FilesIcon, title: m.panel_tab_files, commandId: "view.files", component: FilesView },
  { id: "changes", icon: FileDiffIcon, title: m.panel_changes, commandId: "view.changes", component: ChangesView },
  { id: "git", icon: BranchIcon, title: m.panel_tab_git, commandId: "view.git", component: GitGraphView },
  {
    id: "pullRequests",
    icon: PullRequestIcon,
    title: m.pr_links_title,
    commandId: "view.pullRequests",
    component: PullRequestsView,
  },
  {
    id: "agents",
    icon: RobotIcon,
    title: m.panel_tab_agents,
    commandId: "view.agents",
    component: AgentsView,
    badge: useRunningSubagentCount,
  },
  {
    id: "browser",
    icon: GlobeIcon,
    title: m.panel_tab_browser,
    commandId: "view.browser",
    component: BrowserView,
    header: BrowserTabStrip,
  },
  {
    id: "tinyVm",
    icon: ComputerIcon,
    title: m.panel_tab_tiny_vm,
    commandId: "view.tinyVm",
    component: TinyVmView,
    experiment: "tinyVm",
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
