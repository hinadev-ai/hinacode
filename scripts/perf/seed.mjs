#!/usr/bin/env node
// Usage: seed.mjs <user-data-dir> <repo-path>
// Inserts one project and several threads with synthetic transcripts straight into kkcode.sqlite.
// Deterministic (seeded PRNG) so before/after runs render the same bytes. Reload the renderer afterwards.
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"

const [data, repo, heavyProjectId] = process.argv.slice(2)
if (!data || !repo) {
  console.error("usage: seed.mjs <user-data-dir> <repo-path> [existing-project-id-for-heavy-thread]")
  process.exit(2)
}
// Heavy mode: one thread with transcripts ten times larger (long Read/Bash outputs), under an existing project.
const footprint = heavyProjectId === "--footprint"
const heavy = heavyProjectId !== undefined && !footprint
let nextId = 0
const id = () => (footprint ? `perf-${nextId++}` : randomUUID())
const scale = heavy ? 10 : 1
const db = new DatabaseSync(`${data}/kkcode.sqlite`)

let seed = 42
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const pick = (list) => list[Math.floor(rand() * list.length)]
const words =
  "render scroll thread worktree sqlite effect electron renderer main process memory footprint virtual list markdown tool call diff patch commit branch".split(
    " ",
  )
const sentence = (n) => Array.from({ length: n }, () => pick(words)).join(" ")
const lines = (count, width) =>
  Array.from({ length: count * scale }, (_, i) => `${String(i).padStart(4, "0")}  ${sentence(width)}`).join("\n")

const markdown = () => `## ${sentence(3)}

${sentence(30)}.

- **${sentence(2)}** ${sentence(12)}
- **${sentence(2)}** ${sentence(12)}
- ${sentence(9)} \`${pick(words)}.ts\`

\`\`\`ts
export const ${pick(words)} = (${pick(words)}: string) => {
  return ${pick(words)}.split("\\n").map((line) => line.trim()).filter(Boolean)
}
\`\`\`

| file | status |
|---|---|
| src/${pick(words)}.ts | ${pick(["modified", "added"])} |
| src/${pick(words)}.tsx | ${pick(["modified", "deleted"])} |

${sentence(25)}.`

const diff = (path) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,8 +1,9 @@
${lines(4, 6)
  .split("\n")
  .map((l) => ` ${l}`)
  .join("\n")}
-${sentence(7)}
+${sentence(8)}
+${sentence(5)}
${lines(3, 6)
  .split("\n")
  .map((l) => ` ${l}`)
  .join("\n")}
`

const toolCall = () => {
  const kind = pick(["Bash", "Read", "Grep", "Edit"])
  const path = `src/renderer/${pick(words)}/${pick(words)}.tsx`
  const base = { type: "tool_call", callId: `toolu_${id()}`, status: "done" }
  switch (kind) {
    case "Bash":
      return {
        ...base,
        name: "Bash",
        input: { command: `rg -n ${pick(words)} src | head -40`, description: sentence(4) },
        output: lines(40, 8),
      }
    case "Read":
      return { ...base, name: "Read", input: { file_path: path }, output: lines(120, 9) }
    case "Grep":
      return { ...base, name: "Grep", input: { pattern: pick(words), path: "src" }, output: lines(25, 7) }
    default:
      return {
        ...base,
        name: "Edit",
        input: { file_path: path, old_string: sentence(6), new_string: sentence(8) },
        output: "The file has been updated.",
      }
  }
}

const assistantParts = () => {
  const parts = [{ type: "reasoning", text: sentence(60) }]
  const calls = 1 + Math.floor(rand() * 3)
  for (let i = 0; i < calls; i++) parts.push(toolCall())
  if (rand() < 0.5) {
    const path = `src/${pick(words)}/${pick(words)}.ts`
    parts.push({ type: "file_change", path, diff: diff(path) })
  }
  parts.push({ type: "text", text: markdown() })
  return parts
}

const now = footprint ? Date.parse("2026-10-16T00:00:00Z") : Date.now()
const iso = (offsetMs) => new Date(now - offsetMs).toISOString()

const insertThread = db.prepare(
  "INSERT INTO thread (id, project_id, worktree_id, title, provider, model, provider_session_id, status, sort_index, created_at, updated_at) VALUES (?, ?, NULL, ?, 'claude', 'claude-sonnet-5-5', NULL, 'idle', ?, ?, ?)",
)
const insertMessage = db.prepare(
  "INSERT INTO message (id, thread_id, role, parts, created_at, completed_at, usage) VALUES (?, ?, ?, ?, ?, ?, ?)",
)

const projectId = heavy ? heavyProjectId : id()
if (!heavy && !footprint) {
  db.prepare(
    "INSERT INTO project (id, name, root_path, setup_script, created_at, updated_at) VALUES (?, 'perf', ?, NULL, ?, ?)",
  ).run(projectId, repo, iso(0), iso(0))
}

const plan = footprint
  ? Array.from({ length: 30 }, (_, i) => [i < 5 ? `long ${i}` : `small ${i}`, i < 5 ? 1000 : 5])
  : heavy
    ? [["heavy 150 turns", 150]]
    : [
        ["long 200 turns", 200],
        ["medium 40 turns", 40],
        ["small a", 5],
        ["small b", 5],
        ["small c", 5],
      ]
const threads = {}
db.exec("BEGIN")
plan.forEach(([title, turns], index) => {
  const currentProject = footprint ? `perf-project-${Math.floor(index / 10)}` : projectId
  if (footprint && index % 10 === 0) {
    db.prepare(
      "INSERT INTO project (id, name, root_path, setup_script, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)",
    ).run(currentProject, `Perf ${index / 10}`, `${repo}-${index / 10}`, iso(0), iso(0))
  }
  const sortIndex = heavy ? 10 + index : index
  const threadId = id()
  threads[title] = threadId
  insertThread.run(threadId, currentProject, title, sortIndex, iso(0), iso(0))
  for (let turn = 0; turn < turns; turn++) {
    const t = (turns - turn) * 60_000
    insertMessage.run(
      id(),
      threadId,
      "user",
      JSON.stringify([{ type: "text", text: `${sentence(14)}?` }]),
      iso(t),
      iso(t),
      null,
    )
    insertMessage.run(
      id(),
      threadId,
      "assistant",
      JSON.stringify(assistantParts()),
      iso(t - 1),
      iso(t - 30_000),
      JSON.stringify({ inputTokens: 1200, outputTokens: 800 }),
    )
  }
})
db.exec("COMMIT")

const bytes = db
  .prepare("SELECT thread_id, count(*) AS n, sum(length(parts)) AS bytes FROM message GROUP BY thread_id")
  .all()
console.log(JSON.stringify({ projectId, threads, bytes }, null, 2))
db.close()
