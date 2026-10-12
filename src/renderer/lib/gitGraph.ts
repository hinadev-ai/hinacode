import type { GitCommit } from "../../shared/domain.ts"

/** A line from a lane on this row's center line to a lane on the next row's center line. */
export interface GraphEdge {
  readonly fromLane: number
  readonly toLane: number
}

export interface GraphRow {
  readonly commit: GitCommit
  readonly lane: number
  /**
   * Every line between this row and the next: lanes passing by, and this commit's lines to its parents.
   * The last row's edges lead to parents beyond the loaded commits.
   */
  readonly edges: ReadonlyArray<GraphEdge>
}

const freeLane = (lanes: ReadonlyArray<string | null>) => {
  const index = lanes.indexOf(null)
  return index === -1 ? lanes.length : index
}

/**
 * Assigns each commit a lane for a graph drawn top to bottom. `commits` must list children before their
 * parents, as `git log --topo-order` does. A freed lane is reused by the next branch that needs one.
 */
export function layoutGraph(commits: ReadonlyArray<GitCommit>): Array<GraphRow> {
  const rows: Array<GraphRow> = []
  // The hash each lane is waiting for, between the row just placed and the next one.
  let lanes: Array<string | null> = []
  let pending: Array<GraphEdge> = []

  for (const commit of commits) {
    const waiting = lanes.indexOf(commit.hash)
    const lane = waiting === -1 ? freeLane(lanes) : waiting

    const previous = rows.at(-1)
    if (previous) {
      // Every lane waiting for this commit ends at its node, not at the lane's own position.
      const edges = pending.map((edge) => (lanes[edge.toLane] === commit.hash ? { ...edge, toLane: lane } : edge))
      rows[rows.length - 1] = { ...previous, edges }
    }

    lanes = lanes.map((hash) => (hash === commit.hash ? null : hash))
    const passing = lanes.flatMap((hash, index) => (hash === null ? [] : [{ fromLane: index, toLane: index }]))
    const toParents = commit.parents.map((parent, index) => {
      let parentLane = lanes.indexOf(parent)
      if (parentLane === -1) {
        parentLane = index === 0 ? lane : freeLane(lanes)
        lanes[parentLane] = parent
      }
      return { fromLane: lane, toLane: parentLane }
    })
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop()

    pending = [...passing, ...toParents]
    rows.push({ commit, lane, edges: pending })
  }
  return rows
}

/** The number of lanes the graph needs to show every row. */
export const laneCount = (rows: ReadonlyArray<GraphRow>) => {
  let count = 0
  for (const row of rows) {
    count = Math.max(count, row.lane + 1)
    for (const edge of row.edges) count = Math.max(count, edge.fromLane + 1, edge.toLane + 1)
  }
  return count
}
