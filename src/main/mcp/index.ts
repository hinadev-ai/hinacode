import { Layer } from "effect"
import * as PullRequests from "../services/PullRequests.ts"
import * as Secrets from "../services/Secrets.ts"
import * as Credentials from "./credentials.ts"
import * as Server from "./server.ts"

export { McpCredentials } from "./credentials.ts"

export const credentialsLayer = Layer.mergeAll(Credentials.layer, PullRequests.layer, Secrets.layer)

export const serverLayer = Server.layer
