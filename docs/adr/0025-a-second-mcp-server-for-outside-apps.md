# 0025. A second MCP server for outside apps, reachable through the relay

Status: Accepted
Date: 2026-11-10

## Context

The built-in MCP server serves agents HinaCode started. It listens on loopback, and each credential is bound to one thread. Every tool leans on that: defaults come from the calling thread, writes stay in its project, and tools such as `request_secret`, the tiny VM and `review_changes` act on the caller's turn or workspace.

Chat apps and other harnesses can only reach a remote MCP server from their vendor's servers, over public https with OAuth. Serving them means putting an MCP endpoint on the relay hostname, which the security rules so far ruled out: "the MCP server listens on loopback only".

One server with two kinds of credential would keep one listener, but every tool would have to handle a caller with no thread, and a mistake in that branch would hand a public caller a tool meant for a local agent.

## Decision

Outside apps get their own MCP server with its own tool list and its own OAuth authorization server, in `src/main/apps/`. The thread server stays on loopback, unchanged. The remote listener forwards plain HTTP on the relay hostname to the app server, and the app server answers 404 until the developer mints an approval code or has a connected app.

The developer approves an app by typing a one-time code from Settings into a page their own machine serves. Access tokens are stored hashed, do not expire, and end when the developer removes the connection.

## Consequences

- The loopback rule still holds for the thread server. The boundary to hold for the app server is its tool list: nothing that returns a secret, runs a shell, or drives a VM or device goes on it.
- A connected app can start an agent in any project on the machine, and that agent runs code. Connecting an app is as strong as pairing a phone, and the approval page says so.
- The approval code is typed into a page reached from a link the other app produced. Someone who tricks the developer into opening their link while a code is live, and into typing it, gets a connection. The page names the app and its redirect host, the code lasts ten minutes, and nothing is exposed while no code is live.
- A leaked token works until removed. Expiry with refresh tokens is the next step if connections turn out to be long-lived and forgotten.
- The MCP transport keeps a session until the client ends it or HinaCode restarts. Only a connected app can open one, and a request body is capped at 1 MB, so a client that reconnects without closing costs a little memory per session. Expiry belongs in the transport.
- A machine without a relay cannot use this. A second ingress path or another tunnel provider would need the issuer to stop being the relay hostname.
