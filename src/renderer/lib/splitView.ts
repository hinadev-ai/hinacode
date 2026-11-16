export interface SplitPane {
  readonly size: number
  readonly min: number
  readonly max: number
  readonly snap: boolean
}

export interface SplitLayout {
  readonly sizes: ReadonlyArray<number>
  readonly visible: ReadonlyArray<boolean>
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const sum = (panes: ReadonlyArray<SplitPane>, value: (pane: SplitPane) => number) =>
  panes.reduce((total, pane) => total + value(pane), 0)
const halfMin = (pane: SplitPane) => Math.floor(pane.min / 2)

export function dragSash(
  panes: ReadonlyArray<SplitPane>,
  sash: number,
  delta: number,
  { snap = true }: { snap?: boolean } = {},
): SplitLayout {
  const before = panes.slice(0, sash + 1).toReversed()
  const after = panes.slice(sash + 1)

  const hidden = new Set<SplitPane>()
  const snapBefore = snap ? before.find((pane) => pane.snap) : undefined
  const snapAfter = snap ? after.find((pane) => pane.snap) : undefined
  const beforeSlack = sum(before, (pane) => pane.size - pane.min)
  const afterSlack = sum(after, (pane) => pane.size - pane.min)
  const canPushBefore = sum(after, (pane) => pane.max - pane.size) >= beforeSlack
  const canPushAfter = sum(before, (pane) => pane.max - pane.size) >= afterSlack
  if (snapBefore && canPushBefore && delta < -beforeSlack - halfMin(snapBefore)) hidden.add(snapBefore)
  if (snapAfter && canPushAfter && delta >= afterSlack + halfMin(snapAfter)) hidden.add(snapAfter)
  const min = (pane: SplitPane) => (hidden.has(pane) ? 0 : pane.min)
  const max = (pane: SplitPane) => (hidden.has(pane) ? 0 : pane.max)

  const minDelta = Math.max(
    sum(before, (pane) => min(pane) - pane.size),
    sum(after, (pane) => pane.size - max(pane)),
  )
  const maxDelta = Math.min(
    sum(after, (pane) => pane.size - min(pane)),
    sum(before, (pane) => max(pane) - pane.size),
  )
  const moved = clamp(delta, minDelta, maxDelta)

  const sizes = new Map<SplitPane, number>()
  let remaining = moved
  for (const pane of before) {
    const size = clamp(pane.size + remaining, min(pane), max(pane))
    sizes.set(pane, size)
    remaining -= size - pane.size
  }
  remaining = moved
  for (const pane of after) {
    const size = clamp(pane.size - remaining, min(pane), max(pane))
    sizes.set(pane, size)
    remaining += size - pane.size
  }

  return {
    sizes: panes.map((pane) => (hidden.has(pane) ? pane.size : (sizes.get(pane) ?? pane.size))),
    visible: panes.map((pane) => !hidden.has(pane)),
  }
}
