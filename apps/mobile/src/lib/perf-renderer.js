// FIXME: React's renderer looks for the devtools hook only once as it loads, so the perf harness hooks React first.
require("./perf")
module.exports = require("react-native/Libraries/Renderer/implementations/ReactFabric-profiling")
