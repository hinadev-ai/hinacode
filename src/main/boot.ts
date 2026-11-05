import { enableCompileCache, flushCompileCache } from "node:module"
import { join } from "node:path"
import { app } from "electron"

enableCompileCache(join(app.getPath("appData"), "hinacode-compile-cache"))
await import("./index.ts")
flushCompileCache()
