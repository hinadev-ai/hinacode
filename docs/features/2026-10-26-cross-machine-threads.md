# Threads on other machines

Status: Shipped
Date: 2026-10-26

## Problem

An agent on a cloud cannot see threads on the desktop or on other clouds. `read_thread` and `@thread:<id>` answer "no longer exists" for a thread the user can see in the sidebar, because the MCP tools only read the database of the machine the agent runs on. The desktop already reaches every cloud, but a cloud knows nothing about the desktop.

## User flow

Mention a thread from any machine in a thread on any other machine, or ask the agent to check it. `read_thread` returns the same metadata, workspace and messages it does for a local thread, and names the machine it runs on. `list_threads` lists the threads of the same repository on every machine the user connected. `send_to_thread` and `stop_thread` drive a thread on another machine the same way they drive a local one, including a new `model` before its first turn and a new `effort` at any time.

## Design

The desktop is the hub. It is the one machine that has a connection to every cloud, so the other machines ask it.

- **Desktop agent.** After the local lookup misses, the tools ask the clouds through `Environments`: `gather` for lists, and `forward` to the owner for a thread.
- **Cloud agent.** The tools ask a connected desktop over the socket the desktop already holds open. A cloud that supports this lists `asks` in its `ready` features, the desktop answers with a `hub` frame, and the cloud can then send it `ask` frames. The desktop answers each one with an `answer` frame, through the same routing a window call takes: its own database, or the cloud that owns the id. That cloud can be the one asking.

`Peers` (`src/main/remote/peers.ts`) hides both paths behind one `ask`. It uses a connected desktop when there is one, and its own clouds otherwise.

An `ask` frame names its method from a closed list: the reads `threads.list`, `projects.list`, `worktrees.list`, `threads.transcript`, `pullRequests.list` and `machines.list`, and the writes `threads.update`, `threads.steer` and `threads.interrupt` that `send_to_thread` and `stop_thread` need. The desktop decodes the frame against that list, so a cloud cannot reach any other method. The asking machine checks that the thread is in the same repository before it writes, the same check `read_thread` makes.

Each machine already has a stable id, `RemoteAccess.identity`, which is also the id the desktop pairs a cloud under. `machines.list` is gathered like `threads.list`: every machine answers with its id, its hostname and its project ids, and the desktop renames each cloud's answer to the name the user gave it. A thread's machine is the one that holds its project. A machine on an older version answers nothing, and its threads show as on another machine with no name.

Project ids are per machine, so "the same project" across machines means the same GitHub repository, `Project.repository`. A project with no GitHub `origin` only sees its own machine's threads.

## Out of scope

- `create_thread` on another machine. It needs a way to name the machine, and an agent can ask the user to start the thread there.
- A cloud reaching other machines while no desktop is connected. Clouds do not pair with each other.

## Checkpoints and verification

1. Frames. `remote.test.ts` decodes the new frames and refuses an `ask` for a method outside the list.
2. Both directions. `src/main/mcp/crossMachine.integration.test.ts` pairs a real cloud runtime with a real desktop runtime. A desktop thread reads a cloud thread, and a cloud thread reads a desktop thread over the hub. A thread in another repository is refused, and a cloud with no desktop says so instead of calling the thread gone.
3. The real app. An isolated Electron desktop paired with an isolated `hinacode serve`, each with a project on the same repository and a scripted turn.

Verified in that pair through each machine's own MCP server, the way an agent calls it. The cloud thread read the desktop thread, and the desktop thread read the cloud thread, both marked as on another machine. `list_threads` on the cloud listed both threads once. The hub came back by itself after both processes restarted. With the desktop stopped, the cloud answered that it is not connected to any other machine.
