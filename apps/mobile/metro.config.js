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
// A perf bundle (`scripts/perf/mobile.ts`) swaps React's production renderer for its profiling build, which times
// each render, behind the harness in src/lib/perf.ts. It keeps function names so commits list components by name.
const perf = Boolean(process.env.EXPO_PUBLIC_PERF_URL)
const perfRenderer = path.join(__dirname, "src/lib/perf-renderer.js")
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    moduleName === "effect" || moduleName.startsWith("effect/") ? { ...context, originModulePath: fromApp } : context,
    perf && moduleName.endsWith("/ReactFabric-prod") ? perfRenderer : moduleName,
    platform,
  )
if (perf) config.transformer.minifierConfig = { ...config.transformer.minifierConfig, keep_fnames: true }

module.exports = config
