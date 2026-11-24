const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
}

export default function hinacode(pi) {
  const url = process.env.HINACODE_MCP_URL
  const authorization = process.env.HINACODE_MCP_AUTHORIZATION
  delete process.env.HINACODE_MCP_URL
  delete process.env.HINACODE_MCP_AUTHORIZATION
  if (url) {
    pi.registerMcpServer("hinacode", {
      url,
      headers: { authorization },
      timeout: 3600,
      exposure: "direct",
    })
  }
  pi.on("tool_call", async (event, ctx) => {
    const answer = await ctx.ui.select(`hinacode:approve ${event.toolCallId}`, ["allow", "deny"], {
      signal: ctx.signal,
    })
    if (answer !== "allow") return { block: true, reason: "The user denied this tool call" }
    deepFreeze(event.input)
  })
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("hinacode", "ready"))
}
