import { spawn } from "node:child_process"

export interface Listener {
  readonly pid: number
  readonly port: number
}

// One string argument, so console.log never colorizes the numbers (the runner exports FORCE_COLOR).
const REPORT = ".listen(0, '127.0.0.1', () => console.log(`listening ${process.pid} ${s.address().port}`))"
const SERVER = `const s = require('net').createServer()${REPORT}`
const PAGE_SERVER = `const s = require('http').createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(require('fs').readFileSync('index.html')))${REPORT}`

/**
 * Starts a TCP listener whose working directory is `cwd` and resolves with its pid and port once it
 * reports them. kkcode attributes it to the workspace by that directory; the test runner is not kkcode,
 * so being its child does not matter.
 */
export const listenFrom = (cwd: string, script = SERVER) =>
  new Promise<Listener>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { cwd, detached: true, stdio: ["ignore", "pipe", "inherit"] })
    child.unref()
    let output = ""
    child.once("error", reject)
    child.stdout.on("data", (chunk) => {
      output += String(chunk)
      const match = /listening (\d+) (\d+)/.exec(output)
      if (match) resolve({ pid: Number(match[1]), port: Number(match[2]) })
    })
    child.once("exit", (code) => reject(new Error(`listener exited with ${code} before reporting a port: ${output}`)))
  })

/** Like `listenFrom`, but answers every HTTP request with `cwd`'s `index.html`. */
export const servePageFrom = (cwd: string) => listenFrom(cwd, PAGE_SERVER)

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
