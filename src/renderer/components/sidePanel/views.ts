import type { ComponentType } from "react"
import type { IconType } from "react-icons"
import {
  RiFileCopy2Line,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiInformationLine,
  RiRobot2Line,
  RiFileEditLine,
} from "react-icons/ri"
import type { Thread } from "../../../shared/domain.ts"
import type { CommandId } from "../../keybindings/commands.ts"
import { m } from "../../paraglide/messages.js"
import type { SidePanelViewId } from "../../stores/ui.ts"
import { useRunningSubagentCount } from "../ThreadAgents.tsx"
import { ChangesView } from "./ChangesView.tsx"
import { DetailsView } from "./DetailsView.tsx"
import { FilesView } from "./FilesView.tsx"
import { AgentsView, GitView, PullRequestsView } from "./SimpleViews.tsx"

export interface SidePanelView {
  readonly id: SidePanelViewId
  readonly icon: IconType
  readonly title: () => string
  /** The command that shows the view, whose chord the activity bar tooltip shows. */
  readonly commandId: CommandId
  readonly component: ComponentType<{ thread: Thread }>
  /** A hook the activity bar calls on every render. A count above 0 shows on the icon. */
  readonly badge?: (threadId: string) => number
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
  { id: "git", icon: RiGitBranchLine, title: m.panel_tab_git, commandId: "view.git", component: GitView },
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
]

export const viewById = (id: SidePanelViewId) => sidePanelViews.find((view) => view.id === id) ?? sidePanelViews[0]!
