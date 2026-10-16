// Vite inlines `?raw` imports as strings. The node tsconfig leaves out vite/client, which declares them.
declare module "*.md?raw" {
  const text: string
  export default text
}
