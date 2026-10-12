Feature: Built-in MCP server
  Agents running in a thread call back into kkcode through its MCP server. The credential handed
  to a run decides which thread it acts as, and what the agent links shows up in the thread's panel.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Agent"
    And I open the thread "Agent" from the sidebar
    And an agent connected to the thread "Agent"

  Scenario: The server lists its tools to the thread's agent and turns strangers away
    Then the agent sees the tools "review_changes, link_pull_request, list_thread_pull_requests, unlink_pull_request, linear_get_issue, linear_search_issues, linear_create_comment, linear_update_issue_state"
    And a request with a wrong credential is rejected

  Scenario: review_changes reports what changed in the thread's workspace
    When the agent reviews the changes after I change "README.md" in my repository
    Then the tool result contains "+change"

  Scenario: A pull request linked by the agent shows in the panel until the user unlinks it
    When the agent links the pull request "https://github.com/kjj6198/kkcode/pull/1"
    Then the tool result contains "Linked https://github.com/kjj6198/kkcode/pull/1"
    And the pull requests panel lists "kjj6198/kkcode#1"
    When I unlink "kjj6198/kkcode#1" in the pull requests panel
    Then the pull requests panel is empty

  Scenario: A link that is not a pull request is refused
    When the agent links the pull request "https://example.com/not-a-pr"
    Then the tool fails with "not a GitHub pull request URL"

  Scenario: Linear tools explain what is missing without an API key
    When the agent calls "linear_get_issue" with '{"key":"ENG-1"}'
    Then the tool fails with "No Linear API key is configured"
