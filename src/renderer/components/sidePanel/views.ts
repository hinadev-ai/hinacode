import { type ComponentType, lazy } from "react"
import type { ExperimentalSettings, Thread } from "../../../shared/domain.ts"
import type { CommandId } from "../../keybindings/commands.ts"
import type { EnvironmentId } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import type { SidePanelViewId } from "../../stores/ui.ts"
import { useRunningSubagentCount } from "../ThreadAgents.tsx"
import { BrowserTabStrip } from "./BrowserTabStrip.tsx"
import { DeviceTabStrip } from "./devices/DeviceTabStrip.tsx"
import { DetailsView } from "./DetailsView.tsx"
import { SidechatHeader, SidechatView } from "./SidechatView.tsx"
import { AgentsView, PullRequestsView } from "./SimpleViews.tsx"
import { BranchIcon } from "../icons/BranchIcon.tsx"
import { ChatsIcon } from "../icons/ChatsIcon.tsx"
import { ComputerIcon } from "../icons/ComputerIcon.tsx"
import { FileDiffIcon } from "../icons/FileDiffIcon.tsx"
import { FilesIcon } from "../icons/FilesIcon.tsx"
import { GlobeIcon } from "../icons/GlobeIcon.tsx"
import type { IconComponent } from "../icons/Icon.tsx"
import { InfoIcon } from "../icons/InfoIcon.tsx"
import { PhoneIcon } from "../icons/PhoneIcon.tsx"
import { PullRequestIcon } from "../icons/PullRequestIcon.tsx"
import { RobotIcon } from "../icons/RobotIcon.tsx"

const FilesView = lazy(() => import("./FilesView.tsx").then((module) => ({ default: module.FilesView })))
const ChangesView = lazy(() => import("./ChangesView.tsx").then((module) => ({ default: module.ChangesView })))
const GitGraphView = lazy(() => import("../GitGraphView.tsx").then((module) => ({ default: module.GitGraphView })))
const TinyVmView = lazy(() => import("./TinyVmView.tsx").then((module) => ({ default: module.TinyVmView })))
const BrowserView = lazy(() => import("./BrowserView.tsx").then((module) => ({ default: module.BrowserView })))
const DevicesView = lazy(() => import("./devices/DevicesView.tsx").then((module) => ({ default: module.DevicesView })))

export interface SidePanelView {
  readonly id: SidePanelViewId
  readonly icon: IconComponent
  readonly title: () => string
  readonly commandId: CommandId
  readonly component: ComponentType<{ thread: Thread }>
  readonly header?: ComponentType<{ thread: Thread }>
  readonly badge?: (threadId: string) => number
  readonly experiment?: keyof ExperimentalSettings
}

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
    id: "sidechat",
    icon: ChatsIcon,
    title: m.panel_tab_sidechat,
    commandId: "view.sidechat",
    component: SidechatView,
    header: SidechatHeader,
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
  {
    id: "devices",
    icon: PhoneIcon,
    title: m.panel_tab_devices,
    commandId: "view.devices",
    component: DevicesView,
    header: DeviceTabStrip,
    experiment: "devices",
  },
]

export const useSidePanelViews = (environment: EnvironmentId): ReadonlyArray<SidePanelView> => {
  const { experimental } = useSettings(environment)
  return sidePanelViews.filter((view) => view.experiment === undefined || experimental[view.experiment])
}

export const viewById = (views: ReadonlyArray<SidePanelView>, id: SidePanelViewId) =>
  views.find((view) => view.id === id) ?? views[0]!
