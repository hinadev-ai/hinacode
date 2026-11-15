# @hinacode/sandbox

Run untrusted JavaScript in QuickJS with only the host functions you bind into it. The script has no file system, network, timers, `require` or `process`. It reaches the outside world only through what you pass as `globals`.

```ts
import { fileBindings, runScript } from "@hinacode/sandbox"

const outcome = await runScript({
  code: `
    const plan = await files.read("plan.md")
    await files.write("plan.md", plan.replace("[ ]", "[x]"))
    await threads.send({ threadId: "t1", prompt: "Plan updated" })
    return (await files.list()).length
  `,
  globals: {
    threads: { send: ([input], signal) => sendToThread(input, signal) },
    files: fileBindings({ "plan.md": { path: "/abs/path/plan.md", writable: true } }),
  },
  signal,
})
// { _tag: "Completed", output: "1" } or { _tag: "Failed", output, error }
```

## Bindings

`globals` is a tree. Each function in it appears in the script at the same path and returns a promise, so `{ threads: { send } }` becomes `await threads.send(...)`. The bound objects are frozen.

A host function receives the script's arguments as `unknown[]` and an `AbortSignal`. Validate the arguments: they come from the script. Arguments and results cross as JSON, so return plain data. A thrown `Error` rejects the script's promise with its message. The signal aborts when the caller's `signal` aborts or when the script ends while the call is still running.

`fileBindings` grants named files, never directories. The script passes a name from the map, so it cannot reach a path you did not list. Files are read-only unless the grant says `writable: true`.

## Built in

`console.log` (and `info`, `warn`, `error`, `debug`) and the returned value make up the output. `await sleep(ms)` waits, so a script can poll, and it ends at the script's deadline.

## Limits

Every await settles. A host call has a timeout, the script has a deadline, and a promise that nothing can settle fails the script at once.

| Limit                | Default | What happens                                                                                           |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `timeoutMs`          | 5 min   | The script fails, and every host call still running is aborted.                                        |
| `callTimeoutMs`      | 30 s    | The call's signal aborts and the script's promise rejects with `<path> timed out`, which it can catch. |
| `maxConcurrentCalls` | 8       | Later calls wait for a free slot. Their timeout starts when they run.                                  |
| `memoryBytes`        | 512 MB  | The script fails with `OUT_OF_MEMORY`.                                                                 |
| `sliceMs`            | 500 ms  | A script that computes this long without awaiting is stopped.                                          |
| `outputChars`        | 40,000  | Output keeps its start and end.                                                                        |

`withTimeout(fn, ms)` gives one binding its own timeout. Pass `Number.POSITIVE_INFINITY` for a call that may run until the deadline, such as one that waits for a person. A call whose timeout reaches past the deadline is left to the deadline, so the script fails with one clear reason.

Each run loads its own QuickJS module on a `WebAssembly.Memory` whose `maximum` is `memoryBytes`, so the cap holds and the memory is freed when the run ends. QuickJS's `setMemoryLimit` is not used, because this build counts allocations rather than bytes.

The sandbox runs on the caller's event loop. It yields to it after every awaited host call, and `sliceMs` bounds how long a script can hold it.
