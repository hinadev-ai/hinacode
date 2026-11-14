import {
  AnimatePresence,
  type HTMLMotionProps,
  motion,
  PresenceContext,
  type Transition,
  useIsPresent,
  useReducedMotion,
  type Variants,
} from "motion/react"
import { createContext, type ReactNode, use, useState } from "react"

const easeOut = [0.23, 1, 0.32, 1] as const
const resize: Transition = { duration: 0.2, ease: easeOut }
const instant: Transition = { duration: 0 }
const glide: Transition = { type: "spring", duration: 0.3, bounce: 0 }

const rowVariants: Variants = {
  hidden: (still: boolean) => ({
    height: 0,
    marginTop: "-0.25rem",
    opacity: 0,
    overflow: "hidden",
    transition: still ? instant : resize,
  }),
  shown: (still: boolean) => ({
    height: "auto",
    marginTop: 0,
    opacity: 1,
    transition: still ? instant : resize,
    transitionEnd: { overflow: "visible", opacity: "" },
  }),
}

const fadeVariants: Variants = {
  hidden: (still: boolean) => ({ opacity: 0, transition: still ? instant : resize }),
  shown: (still: boolean) => ({ opacity: 1, transition: still ? instant : resize, transitionEnd: { opacity: "" } }),
}

interface RowPlacement {
  readonly id: string
  readonly section: string
}

const placementKey = (placement: RowPlacement) => `${placement.section}/${placement.id}`

const keptOrder = (placements: ReadonlyArray<RowPlacement>, kept: ReadonlyArray<RowPlacement>) => {
  const ids = new Set(kept.map((placement) => placement.id))
  return placements
    .filter((placement) => ids.has(placement.id))
    .map(placementKey)
    .join()
}

const movedBetween = (before: ReadonlyArray<RowPlacement>, after: ReadonlyArray<RowPlacement>) =>
  keptOrder(before, after) !== keptOrder(after, before)

interface RowMotionValue {
  readonly moves: number
  readonly still: boolean
}

const RowMotion = createContext<RowMotionValue>({ moves: 0, still: true })

export function SidebarRowPresence({
  placements,
  still,
  children,
}: {
  placements: ReadonlyArray<RowPlacement>
  still: boolean
  children: ReactNode
}) {
  const signature = placements.map(placementKey).join()
  const [seen, setSeen] = useState({ signature, placements, moves: 0 })
  if (seen.signature !== signature)
    setSeen({ signature, placements, moves: seen.moves + (movedBetween(seen.placements, placements) ? 1 : 0) })
  return (
    <RowMotion value={{ moves: seen.moves, still }}>
      <AnimatePresence initial={false} custom={still} presenceAffectsLayout={false}>
        {children}
      </AnimatePresence>
    </RowMotion>
  )
}

export function SidebarRow(props: HTMLMotionProps<"li">) {
  const { moves, still } = use(RowMotion)
  const reduced = useReducedMotion() ?? false
  const present = useIsPresent()
  const [arrived, setArrived] = useState(use(PresenceContext)?.initial === false)
  const glides = present && arrived && !still && !reduced
  return (
    <motion.li
      layout={glides ? "position" : false}
      onAnimationComplete={(definition) => {
        if (definition === "shown") setArrived(true)
      }}
      layoutDependency={moves}
      transition={glide}
      variants={reduced ? fadeVariants : rowVariants}
      custom={still}
      initial="hidden"
      animate="shown"
      exit="hidden"
      {...props}
    />
  )
}
