Feature: Agent tasks above the composer
  The agent's own task list (Claude tasks, Codex plan, Muse todos) is folded from its todo
  tool calls and shown above the composer while any of it is unfinished. The simulated agent
  makes the same TaskCreate and TaskUpdate calls a real Claude Code transcript holds, so no
  real agent turn is needed to cover it.

  Scenario: Progress shows above the composer and clears when the list is finished
    Given an isolated thread with a simulated agent that plans tasks
    When I send a message to the task thread
    Then the composer shows 1 of 3 tasks done and "Read math.js" in progress
    When I expand the task list above the composer
    Then the expanded list shows "Read README.md", "Read math.js" and "Summarize"
    When I send a follow-up message to the task thread
    Then the task list above the composer is gone
