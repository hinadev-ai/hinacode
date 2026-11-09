const fs = require("node:fs")
const path = require("node:path")
const { withDangerousMod } = require("expo/config-plugins")

/** Material 3's navigation bar is 80dp tall with 12dp above the icons and 16dp under the labels; ours is 64dp. */
const dimens = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <dimen name="m3_bottom_nav_min_height">64dp</dimen>
  <dimen name="m3_bottom_nav_item_padding_top">8dp</dimen>
  <dimen name="m3_bottom_nav_item_padding_bottom">8dp</dimen>
</resources>
`

module.exports = function withCompactTabBar(config) {
  return withDangerousMod(config, [
    "android",
    (config) => {
      const values = path.join(config.modRequest.platformProjectRoot, "app/src/main/res/values")
      fs.mkdirSync(values, { recursive: true })
      fs.writeFileSync(path.join(values, "compact_tab_bar.xml"), dimens)
      return config
    },
  ])
}
