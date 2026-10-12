# 0001. Everything runs in the Electron main process

Status: Accepted
Date: 2026-10-11

## Context

t3code runs a standalone Node server and talks to its web client over WebSocket, which pays off when the agent runs on another machine. kkcode is local only.

## Decision

kkcode is a single electron-vite package: main, preload and renderer. Agents, git, SQLite, the MCP server and the automation servers all live in the main process. The build is electron-vite 5 with Electron 44 and Vite 7.

## Consequences

- There's one process to start, one data directory, and no ports or auth between the UI and the backend.
- Remote access would need a new transport. That's acceptable while remote stays out of scope.
- electron-vite 5 caps Vite at 7, so we didn't adopt Vite+ or Electron Forge.
