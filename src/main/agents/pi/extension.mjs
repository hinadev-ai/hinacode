export default function hinacode(pi) {
  const url = process.env.HINACODE_MCP_URL
  if (url) {
    pi.registerMcpServer("hinacode", {
      url,
      headers: { authorization: process.env.HINACODE_MCP_AUTHORIZATION },
      timeout: 3600,
      exposure: "direct",
    })
  }
  pi.on("tool_call", async (event, ctx) => {
    const answer = await ctx.ui.select(`hinacode:approve ${event.toolCallId}`, ["allow", "deny"], {
      signal: ctx.signal,
    })
    if (answer !== "allow") return { block: true, reason: "The user denied this tool call" }
  })
  pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("hinacode", "ready"))
}
