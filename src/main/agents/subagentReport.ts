import type { Subagent } from "../../shared/agent.ts"

export const subagentReport = (subagent: Subagent): string => {
  const finished = subagent.status === "completed"
  return [
    `Sub-agent ${finished ? "finished" : "failed"}: ${subagent.label}`,
    "",
    `It kept working after your last turn ended. ${finished ? "Its reply" : "Its last message"}:`,
    "",
    subagent.summary ?? "(none)",
  ].join("\n")
}
