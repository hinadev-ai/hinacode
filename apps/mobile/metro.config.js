const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)
const shared = path.resolve(__dirname, "../../src/shared")
const messages = path.resolve(__dirname, "../../messages")
const icons = path.resolve(__dirname, "../../packages/icons")
const composerEditor = path.resolve(__dirname, "../../packages/composer-editor")
const perfFrames = path.resolve(__dirname, "../../packages/perf-frames")
const documentView = path.resolve(__dirname, "../../packages/document-view")

// FIXME: Metro only resolves files inside a watched folder, and src/shared/document imports the root's patched Tiptap.
const rootModules = path.resolve(__dirname, "../../node_modules")

config.watchFolders = [shared, messages, icons, composerEditor, perfFrames, documentView, rootModules]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules"), path.resolve(__dirname, "../../node_modules")]

// FIXME: Metro would resolve `effect` for src/shared, and React for packages without node_modules, from the repo root and bundle a second copy.
const fromApp = path.join(__dirname, "package.json")
const fromAppForPackages = /^(react|react-native|react-native-svg|expo)(\/|$)/
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
