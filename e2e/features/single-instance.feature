Feature: Single instance
  One process owns a profile's database, its pollers and its webhook listener. A second launch on the
  same profile hands over to the running window instead of starting threads that window never sees.

  Scenario: Launching kkcode again on the same profile exits
    Then launching kkcode again on the same profile exits
