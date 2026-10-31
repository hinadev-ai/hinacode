import rehypeRaw from "rehype-raw"
import rehypeSanitize from "rehype-sanitize"

export const rehypeGitHubHtml = [rehypeRaw, rehypeSanitize]
