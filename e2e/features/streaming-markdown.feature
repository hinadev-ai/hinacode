Feature: Streaming Markdown
  Agent output keeps its meaning while it arrives, and the developer can keep working.

  Background:
    Given a project "demo" for my repository
    And the project "demo" has a thread "Stream"
    When I open the thread "Stream" from the sidebar
    And the agent starts streaming in "Stream"

  Scenario: References resolve across earlier and later Markdown blocks
    When the agent appends Markdown
      """
      [Forward][later]

      A separate paragraph.

      [earlier]: https://example.com/earlier
      """
    Then the unresolved reference "[Forward][later]" is shown as text
    When the agent appends Markdown
      """


      [later]: https://example.com/later

      Another separate paragraph.

      [Backward][earlier]
      """
    Then the Markdown link "Forward" points to "https://example.com/later"
    And the Markdown link "Backward" points to "https://example.com/earlier"
    And the completed Markdown exactly matches its full snapshot

  Scenario: An open code fence and an incomplete table evolve into complete blocks
    When the agent appends Markdown
      """
      ```ts
      const answer =
      """
    Then the code block contains "const answer ="
    When the agent appends Markdown
      """
       42
      ```

      | Name | Value |
      """
    Then the code block contains "const answer = 42"
    And there is no Markdown table yet
    When the agent appends Markdown
      """

      | --- | --- |
      | answer | 4
      """
    Then the Markdown table has a row "answer" with value "4"
    When the agent appends Markdown
      """
      2 |

      Finished **exactly**.
      """
    Then the Markdown table has a row "answer" with value "42"
    And the completed Markdown exactly matches its full snapshot

  Scenario: A turn finishes with an open code fence
    When the agent appends Markdown
      """
      ```ts
      const answer =
      """
    Then the code block contains "const answer ="
    And the completed Markdown exactly matches its full snapshot

  Scenario: A turn finishes with an incomplete table row
    When the agent appends Markdown
      """
      | Name | Value |
      | --- | --- |
      | answer | 4
      """
    Then the Markdown table has a row "answer" with value "4"
    And the completed Markdown exactly matches its full snapshot

  Scenario: Tools and approvals publish the text that precedes them
    When the agent requests a tool and approval behind queued text
    Then the approval first appears with the preceding text already rendered
    And the transcript keeps text on both sides of the tool and reasoning
    When the tool and approval finish
    Then the tool result is inspectable and the approval disappears

  Scenario Outline: A turn ends with its queued final text intact
    When the agent sends its final text and <ending> in one burst
    Then the first completed rendering contains its final text and <ending>

    Examples:
      | ending    |
      | completes |
      | fails     |

  Scenario: Typing and scrolling remain usable during paced output
    When I type and scroll while the agent streams many Markdown blocks
    Then my draft and reading position survive the continuing stream
