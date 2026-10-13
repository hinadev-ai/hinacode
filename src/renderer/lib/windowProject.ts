/**
 * The project this window shows, from the `project` query parameter the main process sets when it opens a
 * window for one project. Null in the window that shows every project.
 */
export const windowProjectId = new URLSearchParams(location.search).get("project")
