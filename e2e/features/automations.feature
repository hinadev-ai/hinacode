Feature: Automations
  A webhook automation starts a thread when a signed delivery arrives. The signing secret is shown
  once at creation, and deliveries that are unsigned, unknown or aimed at a disabled automation are
  turned away before any thread starts.

  Background:
    Given a project "demo" for my repository
    And I open settings
    And I create a webhook automation named "hook" in "demo" with the prompt "Reply with {{body.word}} only."

  Scenario: Creating a webhook automation shows its signing secret once
    Then the automation "hook" is listed with a signing secret

  Scenario: A delivery with the wrong signature is rejected
    When a delivery for "hook" signed with the wrong secret arrives
    Then the delivery is rejected with 401 "invalid_signature"

  Scenario: A delivery for an unknown automation is rejected
    When a delivery arrives for an automation that does not exist
    Then the delivery is rejected with 404 ""

  Scenario: A disabled automation rejects signed deliveries
    When I disable the automation "hook"
    And a signed delivery for "hook" arrives
    Then the delivery is rejected with 409 "automation_disabled"
