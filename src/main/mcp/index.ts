import { Layer } from "effect"
import * as PullRequests from "../services/PullRequests.ts"
import * as Secrets from "../services/Secrets.ts"
import * as Server from "./server.ts"

export { LINEAR_API_KEY_SECRET, McpServer } from "./server.ts"

/** The MCP server plus the services its tools use, which the rpc handlers share. */
export const layer = Server.layer.pipe(Layer.provideMerge(Layer.mergeAll(PullRequests.layer, Secrets.layer)))
