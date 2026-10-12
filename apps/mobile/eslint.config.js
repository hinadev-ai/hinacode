// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config")
const expoConfig = require("eslint-config-expo/flat")

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    // effect only declares `exports`, which eslint-plugin-import's resolver does not read. tsc checks these imports.
    rules: { "import/no-unresolved": ["error", { ignore: ["^effect"] }] },
  },
])
