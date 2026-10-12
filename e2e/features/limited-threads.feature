Feature: Limited threads
  Usage limits remain visible until a later turn succeeds.

  Scenario Outline: A usage-limited thread survives restart and can be retried
    Given an isolated usage-limit thread in "<locale>" with the "<theme>" theme
    When I send a message to the usage-limit thread
    Then the usage-limit thread is visibly limited and ready to send again
    And the usage-limit thread remains limited after turn cleanup
    When I restart the usage-limit app
    Then the usage-limit thread is visibly limited and ready to send again
    When I retry the usage-limit thread
    Then the usage-limit thread completes successfully and becomes idle

    Examples:
      | locale | theme   |
      | en     | default |
      | en     | light   |
      | zh-TW  | default |
      | zh-TW  | light   |

  Scenario: A scheduled usage-limit retry survives restart and repeats the original prompt
    Given an isolated usage-limit thread with a near reset
    When I send a message to the near-reset thread
    And I schedule the near-reset thread to resume at reset
    And I restart the near-reset app with its schedule intact
    Then the near-reset thread automatically completes with the original prompt

  Scenario: Cancelling automatic resume survives restart and still allows a manual retry
    Given an isolated usage-limit thread in "en" with the "default" theme
    When I send a message to the usage-limit thread
    And I schedule the usage-limit thread to resume at reset
    And I cancel automatic resume for the usage-limit thread
    And I restart the usage-limit app
    Then the usage-limit thread has no automatic resume scheduled
    When I retry the usage-limit thread
    Then the usage-limit thread completes successfully and becomes idle

  Scenario: An organization spend limit preserves its message and cannot resume automatically
    Given an isolated organization-spend-limit thread
    When I send a message to the organization-spend-limit thread
    Then the organization spend limit callout preserves the provider message without a resume action
    And scheduling automatic resume for the organization-spend-limit thread is rejected
