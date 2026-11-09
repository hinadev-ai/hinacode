for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const status = button.parentElement?.querySelector("[role=status]")
  button.addEventListener("click", () => {
    navigator.clipboard
      .writeText(button.dataset["copy"] ?? "")
      .then(() => {
        if (status) status.textContent = button.dataset["copiedLabel"] ?? ""
        setTimeout(() => status && (status.textContent = ""), 1600)
      })
      .catch(() => {})
  })
}
