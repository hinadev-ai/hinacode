import assert from "node:assert/strict"
import { test } from "node:test"
import { isServerExternal, parseRootManifest, serverManifest, type RootManifest } from "./server-package.ts"

const root: RootManifest = {
  version: "1.2.3",
  description: "desc",
  license: "MIT",
  repository: { type: "git", url: "git+https://example.invalid/repo.git" },
  engines: { node: "^24.22.1" },
  dependencies: {
    effect: "4.0.3",
    "electron-updater": "6.8.9",
    "node-pty": "1.2.0-beta.15",
    "playwright-core": "1.64.0",
  },
}

test("externals match the package and its subpaths only", () => {
  assert.equal(isServerExternal("node-pty"), true)
  assert.equal(isServerExternal("node-pty/package.json"), true)
  assert.equal(isServerExternal("playwright-core"), true)
  assert.equal(isServerExternal("playwright-core/lib/server/registry/index.js"), true)
  assert.equal(isServerExternal("playwright"), false)
  assert.equal(isServerExternal("effect"), false)
  assert.equal(isServerExternal("electron"), false)
  assert.equal(isServerExternal("node:fs"), false)
})

test("manifest keeps only the externals as dependencies", () => {
  const manifest = serverManifest(root)
  assert.equal(manifest.name, "hinacode")
  assert.equal(manifest.version, "1.2.3")
  assert.deepEqual(manifest.bin, { hinacode: "bin/hinacode.mjs" })
  assert.deepEqual(manifest.files, ["bin", "out/server"])
  assert.deepEqual(manifest.dependencies, { "node-pty": "1.2.0-beta.15", "playwright-core": "1.64.0" })
})

test("manifest refuses a root package missing an external", () => {
  const { "playwright-core": _dropped, ...dependencies } = root.dependencies
  assert.throws(() => serverManifest({ ...root, dependencies }), /playwright-core is missing/)
})

test("root manifest parsing rejects a non-string version", () => {
  assert.throws(
    () => parseRootManifest({ version: 1, description: "d", license: "MIT", dependencies: {} }),
    /version must be a string/,
  )
})
