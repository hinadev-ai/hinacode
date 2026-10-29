import type { GitCommit } from "../../shared/domain.ts"

export interface GraphEdge {
  readonly fromLane: number
  readonly toLane: number
}

export interface GraphRow {
  readonly commit: GitCommit
  readonly lane: number
  readonly edges: ReadonlyArray<GraphEdge>
}

const freeLane = (lanes: ReadonlyArray<string | null>) => {
  const index = lanes.indexOf(null)
  return index === -1 ? lanes.length : index
}

export function layoutGraph(commits: ReadonlyArray<GitCommit>): Array<GraphRow> {
  const rows: Array<GraphRow> = []
  let lanes: Array<string | null> = []
  let pending: Array<GraphEdge> = []

  for (const commit of commits) {
    const waiting = lanes.indexOf(commit.hash)
    const lane = waiting === -1 ? freeLane(lanes) : waiting

    const previous = rows.at(-1)
    if (previous) {
      const edges = pending.map((edge) => (lanes[edge.toLane] === commit.hash ? { ...edge, toLane: lane } : edge))
      rows[rows.length - 1] = { ...previous, edges }
    }

    lanes = lanes.map((hash) => (hash === commit.hash ? null : hash))
    const passing = lanes.flatMap((hash, index) => (hash === null ? [] : [{ fromLane: index, toLane: index }]))
    const toParents = commit.parents.map((parent, index) => {
      let parentLane = lanes.indexOf(parent)
      if (index === 0 && (parentLane === -1 || parentLane > lane)) parentLane = lane
      else if (parentLane === -1) parentLane = freeLane(lanes)
      lanes[parentLane] = parent
      return { fromLane: lane, toLane: parentLane }
    })
    while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop()

    pending = [...passing, ...toParents]
    rows.push({ commit, lane, edges: pending })
  }
  return rows
}

export const laneCount = (rows: ReadonlyArray<GraphRow>) => {
  let count = 0
  for (const row of rows) {
    count = Math.max(count, row.lane + 1)
    for (const edge of row.edges) count = Math.max(count, edge.fromLane + 1, edge.toLane + 1)
  }
  return count
}

export const chipRefs = (refs: ReadonlyArray<string>) =>
  refs.filter((ref) => !ref.endsWith("/HEAD") && !(ref.includes("/") && refs.includes(ref.slice(ref.indexOf("/") + 1))))
