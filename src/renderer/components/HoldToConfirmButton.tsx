import { animate, motion, MotionConfig, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import type { ReactNode } from "react"
import { Button } from "./ui/button.tsx"

const HOLD_SECONDS = 2

const isHoldKey = (key: string) => key === " " || key === "Enter"

interface HoldToConfirmButtonProps {
  readonly children: ReactNode
  readonly disabled: boolean
  readonly onConfirm: () => void
}

export function HoldToConfirmButton({ children, disabled, onConfirm }: HoldToConfirmButtonProps) {
  const progress = useMotionValue(0)
  const reduceMotion = useReducedMotion()
  const x = useTransform(progress, [0, 1], reduceMotion ? ["0%", "0%"] : ["-100%", "0%"])
  const opacity = useTransform(progress, [0, 1], reduceMotion ? [0, 1] : [1, 1])

  const release = () => animate(progress, 0, { duration: 0.3, ease: "easeOut" })
  const hold = () =>
    animate(progress, 1, {
      duration: HOLD_SECONDS * (1 - progress.get()),
      ease: "linear",
      onComplete: () => {
        release()
        onConfirm()
      },
    })

  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={disabled}
      className="relative isolate overflow-hidden"
      onPointerDown={(event) => event.button === 0 && hold()}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onKeyDown={(event) => isHoldKey(event.key) && !event.repeat && hold()}
      onKeyUp={(event) => isHoldKey(event.key) && release()}
      onBlur={release}
    >
      <MotionConfig reducedMotion="user">
        <motion.span aria-hidden className="absolute inset-0 -z-10 bg-destructive/25" style={{ x, opacity }} />
      </MotionConfig>
      {children}
    </Button>
  )
}
