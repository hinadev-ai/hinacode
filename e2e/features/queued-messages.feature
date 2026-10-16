Feature: Queued messages

  Scenario: A failed steer restores the queued message beside the current draft
    Given a project "demo" for my repository
    And the project "demo" has an archived thread "Queued" with a queued message and attachment
    When I open the sidebar tab "Archived"
    And I open the thread "Queued" from the sidebar
    And I compose the draft "Keep this draft"
    And I paste 1 images into the message
    And I steer the queued message now
    Then the queued message is restored beside "Keep this draft" with both attachments

