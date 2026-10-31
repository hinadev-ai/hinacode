import { defineConfig } from "astro/config"
import react from "@astrojs/react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  site: process.env.SITE_URL,
  output: "static",
  devToolbar: { enabled: false },
  i18n: {
    defaultLocale: "en",
    locales: ["en", "zh-tw", "ja"],
  },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
})
