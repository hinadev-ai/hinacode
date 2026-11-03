const LANES = [
  "--graph-lane-1",
  "--graph-lane-2",
  "--graph-lane-3",
  "--graph-lane-4",
  "--graph-lane-5",
  "--graph-lane-0",
] as const

export const chartLane = (index: number) => LANES[index % LANES.length] ?? LANES[0]
