import {
  RiGitClosePullRequestLine,
  RiGitMergeFill,
  RiGitMergeLine,
  RiGitPrDraftLine,
  RiGitPullRequestLine,
} from "react-icons/ri"
import type { IconComponent } from "../components/icons/Icon.tsx"
import { CheckCircleFillIcon } from "../components/icons/CheckCircleFillIcon.tsx"
import { ClockIcon } from "../components/icons/ClockIcon.tsx"
import { FeedbackFillIcon } from "../components/icons/FeedbackFillIcon.tsx"
import { HourglassFillIcon } from "../components/icons/HourglassFillIcon.tsx"
import { PulseIcon } from "../components/icons/PulseIcon.tsx"
import { QuestionFillIcon } from "../components/icons/QuestionFillIcon.tsx"
import { WarningFillIcon } from "../components/icons/WarningFillIcon.tsx"
import { XCircleFillIcon } from "../components/icons/XCircleFillIcon.tsx"
import type { IndicatorTone } from "../../shared/threadStatus.ts"

const icons = {
  RiCheckboxCircleFill: CheckCircleFillIcon,
  RiCloseCircleFill: XCircleFillIcon,
  RiErrorWarningFill: WarningFillIcon,
  RiFeedbackFill: FeedbackFillIcon,
  RiGitClosePullRequestLine,
  RiGitMergeFill,
  RiGitMergeLine,
  RiGitPrDraftLine,
  RiGitPullRequestLine,
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

export const toIcon = ({ icon, tone }: { icon: keyof typeof icons; tone: IndicatorTone }) => ({
  Icon: icons[icon],
  className: toneClassName[tone],
})
