import { type ComponentType, lazy } from "react"
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
  RiQuestionAnswerLine,
} from "react-icons/ri"
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

const FilesView = lazy(() => import("./FilesView.tsx").then((module) => ({ default: module.FilesView })))
const ChangesView = lazy(() => import("./ChangesView.tsx").then((module) => ({ default: module.ChangesView })))
const GitGraphView = lazy(() => import("../GitGraphView.tsx").then((module) => ({ default: module.GitGraphView })))
const TinyVmView = lazy(() => import("./TinyVmView.tsx").then((module) => ({ default: module.TinyVmView })))
const BrowserView = lazy(() => import("./BrowserView.tsx").then((module) => ({ default: module.BrowserView })))
const DevicesView = lazy(() => import("./devices/DevicesView.tsx").then((module) => ({ default: module.DevicesView })))

export interface SidePanelView {
  readonly id: SidePanelViewId
  readonly icon: IconType
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
    id: "sidechat",
    icon: RiQuestionAnswerLine,
    title: m.panel_tab_sidechat,
    commandId: "view.sidechat",
    component: SidechatView,
    header: SidechatHeader,
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
