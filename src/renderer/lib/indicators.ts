import type { IconComponent } from "../components/icons/Icon.tsx"
import { CheckCircleFillIcon } from "../components/icons/CheckCircleFillIcon.tsx"
import { ClockIcon } from "../components/icons/ClockIcon.tsx"
import { FeedbackFillIcon } from "../components/icons/FeedbackFillIcon.tsx"
import { HourglassFillIcon } from "../components/icons/HourglassFillIcon.tsx"
import { MergeFillIcon } from "../components/icons/MergeFillIcon.tsx"
import { MergeIcon } from "../components/icons/MergeIcon.tsx"
import { PrClosedIcon } from "../components/icons/PrClosedIcon.tsx"
import { PrDraftIcon } from "../components/icons/PrDraftIcon.tsx"
import { PullRequestIcon } from "../components/icons/PullRequestIcon.tsx"
import { PulseIcon } from "../components/icons/PulseIcon.tsx"
import { QuestionFillIcon } from "../components/icons/QuestionFillIcon.tsx"
import { WarningFillIcon } from "../components/icons/WarningFillIcon.tsx"
import { XCircleFillIcon } from "../components/icons/XCircleFillIcon.tsx"
import type { IndicatorTone } from "../../shared/threadStatus.ts"

/** Keyed by the icon names in `shared/threadStatus.ts`, which the phone app shares. */
const icons = {
  RiCheckboxCircleFill: CheckCircleFillIcon,
  RiCloseCircleFill: XCircleFillIcon,
  RiErrorWarningFill: WarningFillIcon,
  RiFeedbackFill: FeedbackFillIcon,
  RiGitClosePullRequestLine: PrClosedIcon,
  RiGitMergeFill: MergeFillIcon,
  RiGitMergeLine: MergeIcon,
  RiGitPrDraftLine: PrDraftIcon,
  RiGitPullRequestLine: PullRequestIcon,
  RiHourglassFill: HourglassFillIcon,
  RiPulseLine: PulseIcon,
  RiQuestionFill: QuestionFillIcon,
  RiTimeLine: ClockIcon,
} satisfies Record<string, IconComponent>

const toneClassName = {
  muted: "text-muted-foreground",
  attention: "text-attention",
  success: "text-success",
  danger: "text-destructive",
  prOpen: "text-pr-open",
  prMerged: "text-pr-merged",
} satisfies Record<IndicatorTone, string>

/** A thread or pull request indicator from `shared/threadStatus.ts`, as an icon component and a text color. */
export const toIcon = ({ icon, tone }: { icon: keyof typeof icons; tone: IndicatorTone }) => ({
  Icon: icons[icon],
  className: toneClassName[tone],
})
