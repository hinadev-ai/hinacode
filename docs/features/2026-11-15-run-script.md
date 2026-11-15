# run_script

Status: Shipped
Date: 2026-11-15

## Problem

An agent that drives HinaCode's tools pays one model round trip per call, and every result lands in its context in full. Fanning `run_agent` out to three providers, reading five threads to find one fact, or clicking through a VM screen by screen costs turns and tokens the agent does not need. The agent cannot run these calls in parallel or filter their results before it reads them.

## User flow

The agent calls `run_script` with JavaScript instead of calling tools one by one:

```js
const [codex, claude] = await Promise.all([
  tools.run_agent({ provider: "codex", description: "review", prompt: "Review the diff" }),
  tools.run_agent({ provider: "claude", description: "review", prompt: "Review the diff" }),
])
return { codex, claude }
```

The tool result holds the `console.log` lines and the returned value, and nothing else the script read. The developer sees one `run_script` call in the transcript, and the sub-agents and other side effects show up where they always do.

## Design

`run_script` is one tool on the thread MCP server (`src/main/mcp/tools/runScript.ts`). Its parameter is `code`, the body of an async function.

- **Sandbox.** The `@hinacode/sandbox` package (`packages/sandbox`) runs the code in QuickJS (`quickjs-emscripten-core` with the single-file sync variant, so the wasm survives the Electron, daemon and single-executable bundles). Each call loads a fresh QuickJS module (2 to 15 ms) with its own runtime and context, disposed when it ends, so the module's memory is freed with it. A WebAssembly memory never shrinks, so a cached module would keep a heavy script's peak for the life of the process. There is no file system, network, timers, `require` or `process`. `run_script` binds one global, `tools`, through the package's `globals` tree, and other callers can bind their own functions or `fileBindings` (see the package README).
- **Tools.** `tools.<name>(args)` exists for every tool the caller's session can see, read from `McpServer.tools` and filtered by each tool's `EnabledWhen`, so VM and device tools appear only while their toggles are on. `run_script` itself is left out, and the host refuses any name outside that list, so a script cannot nest scripts. A call goes through `McpServer.callTool` in the caller's request context, so it runs as the same thread with the same credential checks as a direct call.
- **Values.** Arguments and results cross the boundary as JSON strings. A tool resolves to its structured content, else its text, else its encoded content blocks, and rejects with an `Error` carrying the tool's message.
- **Limits.** The sandbox runs on the main process's event loop. An interrupt handler stops a script that computes for more than 500 ms between awaits, so a runaway loop stalls HinaCode for at most that long. After each awaited tool call the pump yields to the event loop with `setImmediate` before it runs the script again, because a tool that answers at once settles in a microtask, and a loop of those would otherwise keep timers, I/O and cancellation from ever running. Memory is capped at 512 MB by the `maximum` of the module's `WebAssembly.Memory`, and a script that needs more fails with "The script ran out of memory in the sandbox." QuickJS's own `setMemoryLimit` is not used: in this build `malloc_usable_size` is unavailable, so it bills each allocation 8 bytes and limits the number of allocations, not their size. With it set to 32 MB, a loop of 4 MB buffers still grew the heap to the 2 GB wasm ceiling. The stack is capped at 1 MB. The host copies a tool result into the VM with an unchecked `malloc`, so it does so only when the wasm memory can still grow to hold it, and otherwise fails the script as out of memory. Any exception from QuickJS during the run or disposal is reported the same way, and the module is dropped. A script waiting on a promise with no tool call in flight fails at once, because nothing could settle it. Output keeps its first and last 20,000 characters as it arrives, so a logging loop cannot grow the host's heap.
- **Time.** Every await settles. A script has a 4 minute deadline, under the 300 seconds Muse gives an MCP call. Each tool call times out after 2 minutes with an `Error` the script can catch, except `run_agent`, `wait_agent`, `request_secret`, `review_changes` and `vm_exec`, which by design can take minutes and run until the deadline. At most 8 calls run at once, so one `Promise.all` cannot start a hundred sub-agents. `sleep(ms)` lets a script poll, bounded by the same deadline.
- **Choosing it.** Claude Code defers MCP tools, so an agent sees only `run_script`'s name until it loads it. The `Scripts:` section of `AGENT_INSTRUCTIONS` tells every provider when to reach for it: two or more hinacode calls, fan out, chaining or polling. It also says when not to: one call, or shell and file work. The tool description leads with the same rule, so a tool search for parallel or batched calls finds it.
- **Failures.** A failed script returns its output, the error, and two more sentences: tool calls that finished already took effect, and what to do next for that `reason` (the `NEXT_STEP` table in `runScript.ts`), such as starting a long sub-agent in the background when the deadline hit.
- **Cancellation.** When the MCP request is interrupted, the script stops and its in-flight tool calls are interrupted through their `AbortSignal`. When a script returns while calls are still running, those calls are interrupted too.

Trust boundary: the script is code the agent writes, and it can reach only what the agent could already reach through the same tools. It adds no capability.

## Out of scope

- The agent's own tools (shell, file edits) and other MCP servers. The sandbox lives in HinaCode, which reaches only its own tools.
- Persisted state between scripts and TypeScript declarations in the description. The agent already sees every tool's schema in its tool list.
- A worker thread. The 500 ms slice keeps the main process responsive without a second bundle entry for the Electron, daemon and executable builds. Move it to a worker if real scripts need long computation.

## Verification

- `packages/sandbox/src/sandbox.test.ts` covers output, nested bindings, frozen globals, failed calls, missing globals, caller limits, a never settling promise, CPU and memory limits, cancellation and truncation. `files.test.ts` covers granted, read-only and unknown files.
- `src/main/mcp/server.integration.test.ts` (`run_script`) calls real tools over HTTP as one thread, checks that `run_script` and disabled tools are hidden, and checks the failure result.
- In the real app with `verify-hinacode`, call `run_script` through `mcp-call.ts`, then ask a Claude thread to use it and check the transcript for the `mcp__hinacode__run_script` call.
