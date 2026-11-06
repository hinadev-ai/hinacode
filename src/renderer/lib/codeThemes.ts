import { getResolvedOrResolveTheme, registerCustomTheme } from "@pierre/diffs"

const vitesseWithReadableTokens = (
  name: string,
  base: "vitesse-light" | "vitesse-dark",
  colorReplacements: Record<string, string>,
) => registerCustomTheme(name, async () => ({ ...(await getResolvedOrResolveTheme(base)), name, colorReplacements }))

vitesseWithReadableTokens("hina-light", "vitesse-light", {
  "#ab5959": "#9a5050",
  "#b07d48": "#865f37",
  "#59873a": "#4b7131",
  "#b56959": "#945649",
  "#2f798a": "#2b6f7f",
})

vitesseWithReadableTokens("hina-dark", "vitesse-dark", {
  "#cb7676": "#dda6a6",
  "#bd976a": "#ccaf8c",
  "#80a665": "#a0bc8c",
  "#c98a7d": "#d8aaa0",
  "#4c9a91": "#8bbdb8",
})
