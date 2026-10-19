import { cn } from "cn"
import { LayoutGroup, motion } from "motion/react"
import { type ComponentProps, type ReactNode, useId } from "react"

const slide = { type: "spring", stiffness: 350, damping: 35 } as const

/**
 * Keeps item highlights inside one popup, so a submenu never steals its parent's highlight.
 * The popup must be `isolate` and its items must not be, so the highlight paints under every item's text.
 */
function HighlightScope({ children }: { children: ReactNode }) {
  return <LayoutGroup id={useId()}>{children}</LayoutGroup>
}

/** A Base UI item `render` whose highlight slides over from the last highlighted item instead of blinking. */
function highlightable(className?: string) {
  return (props: ComponentProps<"div">, state: { highlighted: boolean }) => (
    <div {...props}>
      {state.highlighted && (
        <motion.span
          layoutId="highlight"
          transition={slide}
          className={cn("absolute inset-0 -z-10 rounded-[inherit] bg-accent", className)}
        />
      )}
      {props.children}
    </div>
  )
}

export { HighlightScope, highlightable }
