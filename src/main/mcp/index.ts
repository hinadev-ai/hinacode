import { Layer } from "effect"
import * as PullRequests from "../services/PullRequests.ts"
import * as Secrets from "../services/Secrets.ts"
import * as Credentials from "./credentials.ts"
import * as Server from "./server.ts"

export { McpCredentials } from "./credentials.ts"
export { LINEAR_API_KEY_SECRET } from "./server.ts"

/** The credential store, which the agent runner needs before the server can be built. */
export const credentialsLayer = Layer.mergeAll(Credentials.layer, PullRequests.layer, Secrets.layer)

/** The HTTP server and its tools. Needs `credentialsLayer`, the agent runner and the thread services. */
export const serverLayer = Server.layer
