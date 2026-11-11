import { parseHTML } from "linkedom"

export class DocumentHtmlParser {
  parseFromString(html: string) {
    return parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`).document
  }
}
