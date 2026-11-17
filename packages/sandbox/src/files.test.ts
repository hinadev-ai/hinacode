import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { fileBindings } from "./files.ts"
import { runScript } from "./sandbox.ts"

const dir = mkdtempSync(join(tmpdir(), "hinacode-sandbox-files-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const plan = join(dir, "plan.md")
const readme = join(dir, "README.md")
const secret = join(dir, "secret.txt")
writeFileSync(plan, "# Plan\n- [ ] ship\n")
writeFileSync(readme, "Read me")
writeFileSync(secret, "hunter2")

const files = fileBindings({ "plan.md": { path: plan, writable: true }, "README.md": { path: readme } })

describe("fileBindings", () => {
  it("lists, reads and edits only the granted files", async () => {
    const outcome = await runScript({
      code: `const text = await files.read("plan.md")
             await files.write("plan.md", text.replace("[ ]", "[x]"))
             return { list: await files.list(), readme: await files.read("README.md") }`,
      globals: { files },
    })
    expect(outcome).toEqual({
      _tag: "Completed",
      output: JSON.stringify(
        {
          list: [
            { name: "plan.md", writable: true },
            { name: "README.md", writable: false },
          ],
          readme: "Read me",
        },
        null,
        2,
      ),
    })
    expect(readFileSync(plan, "utf8")).toBe("# Plan\n- [x] ship\n")
  })

  it.each([
    [`await files.write("README.md", "changed")`, "README.md is read-only."],
    [`await files.read("secret.txt")`, "No file named secret.txt."],
    [`await files.read(${JSON.stringify(secret)})`, `No file named ${secret}.`],
    [`await files.read("../secret.txt")`, "No file named ../secret.txt."],
    [`await files.read("constructor")`, "No file named constructor."],
    [`await files.write("plan.md", 42)`, "write takes the file name and its new text."],
  ])("refuses %s", async (code, message) => {
    expect(await runScript({ code, globals: { files } })).toMatchObject({
      _tag: "Failed",
      error: expect.stringContaining(message),
    })
    expect(readFileSync(readme, "utf8")).toBe("Read me")
  })
})
