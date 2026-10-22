;(() => {
  const FUNCTION = 0
  const CLASS = 1
  const FORWARD_REF = 11
  const MEMO = 14
  const SIMPLE_MEMO = 15
  const PERFORMED_WORK = 1
  const composite = new Set([FUNCTION, CLASS, FORWARD_REF, MEMO, SIMPLE_MEMO])

  const nameOf = (fiber) => {
    const type = fiber.tag === MEMO ? fiber.type.type : fiber.tag === FORWARD_REF ? fiber.type.render : fiber.type
    return fiber.type?.displayName || type?.displayName || type?.name || "Anonymous"
  }

  const walk = (next, prev, rendered) => {
    if (composite.has(next.tag) && (prev === null || (next.flags & PERFORMED_WORK) !== 0)) {
      rendered.push(prev === null ? `${nameOf(next)} (mount)` : nameOf(next))
    }
    if (prev !== null && next.child === prev.child) return
    for (let child = next.child; child !== null; child = child.sibling) walk(child, child.alternate, rendered)
  }

  const state = { recording: false, commits: [] }
  let nextRendererId = 1
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    inject(renderer) {
      const id = nextRendererId++
      this.renderers.set(id, renderer)
      return id
    },
    onCommitFiberRoot(_id, root) {
      if (!state.recording) return
      const rendered = []
      walk(root.current, root.current.alternate, rendered)
      state.commits.push({ at: performance.now(), rendered })
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  }
  window.__reactCommits = {
    start() {
      state.commits = []
      state.recording = true
    },
    stop() {
      state.recording = false
      return state.commits
    },
  }
})()
