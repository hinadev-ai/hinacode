const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)
const shared = path.resolve(__dirname, "../../src/shared")
// The repo's copy catalogs, which `src/lib/copy.ts` reads.
const messages = path.resolve(__dirname, "../../messages")
const icons = path.resolve(__dirname, "../../packages/icons")
const composerEditor = path.resolve(__dirname, "../../packages/composer-editor")
const perfFrames = path.resolve(__dirname, "../../packages/perf-frames")
const documentView = path.resolve(__dirname, "../../packages/document-view")

// The document model is the desktop's own Tiptap and ProseMirror, imported by src/shared/document from the repo's
// node_modules, where its pnpm patches live. Metro only resolves files inside a watched folder.
const rootModules = path.resolve(__dirname, "../../node_modules")

config.watchFolders = [shared, messages, icons, composerEditor, perfFrames, documentView, rootModules]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(__dirname, "../../node_modules")]

// src/shared would otherwise resolve `effect` from the repo root, giving the bundle two copies whose
// schemas do not recognise each other. Resolve it from this app for every importer. packages/icons has no
// node_modules of its own, so its React and react-native-svg come from this app too.
const fromApp = path.join(__dirname, "package.json")
const fromAppForPackages = /^(react|react-native|react-native-svg|expo)(\/|$)/
// A perf bundle (`scripts/perf/mobile.ts`) swaps React's production renderer for its profiling build, which times
// each render, behind the harness in src/lib/perf.ts. It keeps function names so commits list components by name.
const perf = Boolean(process.env.EXPO_PUBLIC_PERF_URL)
const perfRenderer = path.join(__dirname, "src/lib/perf-renderer.js")
const resolvesFromApp = (context, moduleName) =>
  moduleName === "effect" ||
  moduleName.startsWith("effect/") ||
  ([icons, composerEditor, perfFrames, documentView].some((dir) => context.originModulePath.startsWith(dir)) &&
    fromAppForPackages.test(moduleName))
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    resolvesFromApp(context, moduleName) ? { ...context, originModulePath: fromApp } : context,
    perf && moduleName.endsWith("/ReactFabric-prod") ? perfRenderer : moduleName,
    platform,
  )
if (perf) config.transformer.minifierConfig = { ...config.transformer.minifierConfig, keep_fnames: true }

module.exports = config
