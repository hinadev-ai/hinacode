import {
  RiGitClosePullRequestLine,
  RiGitMergeFill,
  RiGitMergeLine,
  RiGitPrDraftLine,
  RiGitPullRequestLine,
} from "react-icons/ri"
import {
  CheckCircleFillIcon,
  ClockIcon,
  FeedbackFillIcon,
  HourglassFillIcon,
  type IconComponent,
  PulseIcon,
  QuestionFillIcon,
  WarningFillIcon,
  XCircleFillIcon,
} from "@hinacode/icons"
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
  foreground: "text-foreground",
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
