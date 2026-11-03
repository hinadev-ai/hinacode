import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { expect, onTestFinished, test } from "vitest"
import { openArtifactStore } from "./store.ts"

test("the stdio MCP server publishes into $HINACODE_ARTIFACTS", async () => {
  const root = mkdtempSync(join(tmpdir(), "hinacode-artifacts-"))
  const client = new Client({ name: "cli-test", version: "0.0.0" })
  onTestFinished(async () => {
    await client.close()
    rmSync(root, { recursive: true, force: true })
  })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("./cli.ts", import.meta.url)), "mcp"],
      env: { ...getDefaultEnvironment(), HINACODE_ARTIFACTS: root },
    }),
  )

  const { tools } = await client.listTools()
  expect(tools.map((tool) => tool.name).toSorted()).toEqual(["list_artifacts", "publish_artifact", "read_artifact"])

  await client.callTool({
    name: "publish_artifact",
    arguments: { title: "From MCP", files: [{ path: "index.html", content: "<h1>MCP</h1>" }] },
  })
  const [artifact] = await openArtifactStore(root).list()
  expect(artifact).toMatchObject({ title: "From MCP", version: 1 })

  expect(await client.callTool({ name: "read_artifact", arguments: { id: artifact?.id, path: "index.html" } })).toEqual(
    {
      content: [{ type: "text", text: "<h1>MCP</h1>" }],
    },
  )
  expect(
    await client.callTool({
      name: "publish_artifact",
      arguments: { title: "Escape", files: [{ path: "../x.html", content: "" }], entry: "../x.html" },
    }),
  ).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("Invalid file path") }] })
})
