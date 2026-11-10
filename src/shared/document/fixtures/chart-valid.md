```chart
{
  "type": "bar",
  "title": "Weekly builds",
  "notes": "Failed builds include flaky reruns.",
  "x": "week",
  "series": [{ "key": "passed", "label": "Passed" }, { "key": "failed" }],
  "unit": { "suffix": " runs" },
  "rows": [
    { "week": "W1", "passed": 12, "failed": 1 },
    { "week": "W2", "passed": 15, "failed": null },
    { "week": "W3", "passed": 9, "failed": 4 }
  ]
}
```
