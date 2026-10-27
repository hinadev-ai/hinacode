// Vite inlines `?raw` imports as strings. The node tsconfig leaves out vite/client, which declares them.
declare module "*.swift?raw" {
  const text: string
  export default text
}
