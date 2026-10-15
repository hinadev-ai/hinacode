const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)
const shared = path.resolve(__dirname, "../../src/shared")
// The repo's copy catalogs, which `src/lib/copy.ts` reads.
const messages = path.resolve(__dirname, "../../messages")

config.watchFolders = [shared, messages]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(__dirname, "../../node_modules")]

// src/shared would otherwise resolve `effect` from the repo root, giving the bundle two copies whose
// schemas do not recognise each other. Resolve it from this app for every importer.
const fromApp = path.join(__dirname, "package.json")
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    moduleName === "effect" || moduleName.startsWith("effect/") ? { ...context, originModulePath: fromApp } : context,
    moduleName,
    platform,
  )

module.exports = config
