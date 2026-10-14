# 0013. Agent tools through MCP, not SDK tool calling

Status: Accepted
Date: 2026-10-12

## Context

kkcode gives agents its own tools, such as `review_changes`, `link_pull_request`, `request_secret`, `create_thread`, the thread controls and the Linear tools. Each agent SDK has its own way to define a tool. Claude's Agent SDK has `tool()` with Zod schemas, wrapped by `createSdkMcpServer()`, which is an in-process MCP server anyway [1]. Codex's app-server has `dynamicTools` on `thread/start`, answered through `item/tool/call`. It's experimental and needs the `experimentalApi` capability [3]. If we wrote kkcode tools against these APIs, every tool would need one implementation per provider. Every new backend would also mean porting every tool, if the backend can define custom tools at all.

Every agent we run, and every one we are likely to add, can connect to an HTTP MCP server [2] [4].

## Decision

- Agent tools live on the one built-in MCP server (`src/main/mcp/`). A tool is an Effect AI `Tool` with an Effect Schema for its input, grouped into a `Toolkit` under `mcp/tools/`. Its handler reads the calling thread's id from `CallingThread`.
- Each provider is wired to that server once. Codex gets the URL and headers in its thread config. Claude reaches it through an in-process relay (`agents/claude/mcp.ts`).
- We don't define tools through provider-specific APIs.

## Consequences

- A new tool is written once and works in every provider. A new provider gets every tool from one config entry.
- The calling thread comes from its credential ([ADR 0007](0007-per-thread-mcp-credentials.md)). Each thread has its own key, so the agent never passes a thread id and cannot act as another thread.
- The server is reached by URL, so an agent doesn't have to run in the same process or on the same device as the server. Today it listens on loopback only. Supporting agents on another machine would change the bind address and the transport security, but not the tools.
- We depend on each provider's MCP support and its quirks. Codex times out MCP calls after 60 seconds by default, so we set `tool_timeout_sec` [4]. Codex asks for MCP approvals through elicitations, not through its regular approval requests.
- We'd revisit this if a tool needs something MCP can't carry, such as streaming into a provider's own UI, or if a provider we want to support can't connect to MCP over HTTP.

## References

1. Claude Agent SDK, [Give Claude custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)
2. Claude Agent SDK, [Connect to external tools with MCP](https://code.claude.com/docs/en/agent-sdk/mcp)
3. Codex, [App Server: Dynamic tool calls (experimental)](https://learn.chatgpt.com/docs/app-server)
4. Codex, [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
