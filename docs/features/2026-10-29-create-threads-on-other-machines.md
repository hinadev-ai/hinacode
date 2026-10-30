# Create threads on other machines

Status: Shipped
Date: 2026-10-29

## Problem

An agent can read, steer and stop threads on the user's other machines (`2026-10-26-cross-machine-threads.md`), but `create_thread` only starts a thread on its own machine. To hand work to the home server or a cloud VM, the agent has to stop and ask the user to start the thread there by hand.

## User flow

1. The user asks the agent to run something on another machine, for example "start a thread on the mini that runs the load test".
2. The agent calls `list_machines`. It lists every machine the user connected, marks this one with `self`, and says whether each has a project for this GitHub repository.
3. The agent calls `create_thread` with that machine's `id`. The thread appears in the user's sidebar under that machine and starts its first turn there.
4. If the machine has no project for this repository, `create_thread` fails and names the repository and the machine. The agent asks the user to add the project on that machine, then tries again.

## Design

- `list_machines` returns `[{ id, name, self?, hasProject }]`. This machine comes from `RemoteAccess.identity` and its own projects. The others come from `machines.list` and `projects.list` through `Peers`, the same two answers `list_threads` already gathers.
- `create_thread` takes `machine`, a machine id. With no `machine`, or this machine's id, nothing changes. Otherwise the tool picks the first project on that machine with the same `Project.repository` as the caller's project, then asks `threads.create` and `threads.steer` through `Peers`. Steering an idle thread starts its turn, which is how `send_to_thread` already starts a turn on another machine.
- `threads.create` accepts the options `create_thread` passes: `title`, `provider`, `model`, `effort`, `worktree` and `createdBy`, all optional. The desktop's new thread button still sends only `projectId` and gets the defaults.
- `threads.create` joins the closed list of methods a cloud may `ask` the desktop. The desktop routes it to the machine that owns the project, and learns the new thread's owner from the answer, so the `threads.steer` that follows reaches the same machine.
- The caller must have a GitHub `origin`. A project without one only starts threads on its own machine, as it only sees its own machine's threads.

A target machine on an older version drops the new `threads.create` fields, so the thread gets a random name and that machine's default agent and model. When the agent asked for a worktree and the thread came back without one, the tool does not start it and asks the user to update that machine, so a task meant for its own branch never runs in the main checkout. An older desktop does not know the method, so a cloud asking it waits out the 15 second ask timeout.

## Out of scope

- Adding the project on the other machine for the user. Cloning picks a path on a machine the agent cannot see, so the user does it.
- Picking a machine by name. Names are what the user typed and can repeat; the agent gets ids from `list_machines`.

## Verification

1. `src/main/mcp/crossMachine.integration.test.ts`: `list_machines` from both sides, a desktop thread creating a thread on the cloud, a cloud thread creating one on the desktop through the hub, and a machine without the repository refused with the message the agent relays.
2. The real app: an isolated Electron desktop paired with an isolated `hinacode serve`, with a desktop thread calling `create_thread` for the cloud through its MCP server.

Verified in that pair through the desktop's MCP server, with the cloud running the mock Claude. `list_machines` showed both machines and marked the cloud as having no project for a second repository. `create_thread` started a thread on the cloud that showed in the desktop sidebar as on that machine, ran in the cloud's checkout and answered the prompt. The same call from the second repository's thread returned the message asking the user to add the project.
