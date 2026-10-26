import type { IconType } from "react-icons"
import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiFeedbackFill,
  RiGitClosePullRequestLine,
  RiGitMergeFill,
  RiGitMergeLine,
  RiGitPrDraftLine,
  RiGitPullRequestLine,
  RiHourglassFill,
  RiPulseLine,
  RiQuestionFill,
  RiTimeLine,
} from "react-icons/ri"
import type { IndicatorTone } from "../../shared/threadStatus.ts"

const icons = {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiFeedbackFill,
  RiGitClosePullRequestLine,
  RiGitMergeFill,
  RiGitMergeLine,
  RiGitPrDraftLine,
  RiGitPullRequestLine,
  RiHourglassFill,
  RiPulseLine,
  RiQuestionFill,
  RiTimeLine,
} satisfies Record<string, IconType>

const toneClassName = {
  muted: "text-muted-foreground",
  attention: "text-attention",
  success: "text-success",
  danger: "text-destructive",
  prOpen: "text-pr-open",
  prMerged: "text-pr-merged",
} satisfies Record<IndicatorTone, string>

/** A thread or pull request indicator from `shared/threadStatus.ts`, as a react-icons component and a text color. */
export const toIcon = ({ icon, tone }: { icon: keyof typeof icons; tone: IndicatorTone }) => ({
  Icon: icons[icon],
  className: toneClassName[tone],
})
