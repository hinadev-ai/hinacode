// A perf bundle loads this in place of React's production renderer (see metro.config.js). The harness has to hook
// React before the renderer module runs, because the renderer looks for the hook only once, as it loads.
require("./perf")
module.exports = require("react-native/Libraries/Renderer/implementations/ReactFabric-profiling")
