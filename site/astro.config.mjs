import { defineConfig } from "astro/config"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  site: process.env.SITE_URL,
  output: "static",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "zh-tw", "ja"],
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
