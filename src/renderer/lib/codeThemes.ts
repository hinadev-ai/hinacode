import { getResolvedOrResolveTheme, registerCustomTheme } from "@pierre/diffs"

const vitesseOnHina = (
  name: string,
  base: "vitesse-light" | "vitesse-dark",
  background: string,
  colorReplacements: Record<string, string>,
) =>
  registerCustomTheme(name, async () => {
    const theme = await getResolvedOrResolveTheme(base)
    return {
      ...theme,
      name,
      bg: background,
      colors: { ...theme.colors, "editor.background": background },
      colorReplacements,
    }
  })

vitesseOnHina("hina-light", "vitesse-light", "#f7f7f2", {
  "#a0ada0": "#505b50",
  "#999999": "#575757",
  "#a65e2b": "#8b450b",
  "#59873a": "#376313",
  "#1e754f": "#006540",
  "#ab5959": "#8e3f40",
  "#b56959": "#8b4335",
  "#998418": "#6b5600",
  "#b07d48": "#7d4d13",
  "#2e8f82": "#006458",
  "#b05a78": "#8e3b5a",
  "#b31d28": "#ae1524",
  "#ab5e3f": "#8c4223",
  "#bda437": "#6d5400",
  "#2f798a": "#0d6071",
  "#1c6b48": "#146543",
  "#2e808f": "#006170",
  "#22863a": "#00661a",
  "#e36209": "#a62700",
  "#6f42c1": "#693bba",
  "#005cc5": "#0053bb",
  "#586069": "#515962",
  "#5a6aa6": "#46548e",
})

vitesseOnHina("hina-dark", "vitesse-dark", "#233737", {
  "#758575": "#bbcdbb",
  "#666666": "#c7c7c7",
  "#c99076": "#f6ba9f",
  "#80a665": "#abd390",
  "#4d9375": "#8ed6b5",
  "#cb7676": "#ffb4b3",
  "#c98a7d": "#fab7a9",
  "#b8a965": "#d8c984",
  "#bd976a": "#e9c193",
  "#5da994": "#89d6c0",
  "#db889a": "#ffb2c4",
  "#fdaeb7": "#ffb3bc",
  "#c4704f": "#ffb895",
  "#4c9a91": "#87d5cb",
  "#d4976c": "#f9ba8e",
  "#5d99a9": "#95d2e3",
  "#ffab70": "#ffb87d",
  "#b392f0": "#dbbaff",
  "#79b8ff": "#8fcfff",
  "#6872ab": "#b9c6ff",
})
