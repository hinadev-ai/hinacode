export const CHART_GUIDE = `A chart in a document is a fenced code block whose language is chart and whose body is JSON:

\`\`\`chart
{
  "type": "bar",
  "title": "Daily sales peaked at ¥63,900 on 10/17",
  "notes": "Total ¥283,675 from 10/15 to 10/19",
  "x": "day",
  "series": [
    { "key": "chat", "label": "Chat" },
    { "key": "drama", "label": "Drama" },
    { "key": "replay", "label": "Replay" }
  ],
  "unit": { "prefix": "¥" },
  "rows": [
    { "day": "10-15", "chat": 25875, "drama": 18700, "replay": 60 },
    { "day": "10-16", "chat": 31900, "drama": 18000, "replay": 0 },
    { "day": "10-17", "chat": 54800, "drama": 9100, "replay": 0 },
    { "day": "10-18", "chat": 52300, "drama": 9200, "replay": 0 },
    { "day": "10-19", "chat": 45700, "drama": 8000, "replay": 40 }
  ]
}
\`\`\`

- type is "bar" or "line". A bar chart stacks its series; a line chart draws one line per series.
- x names the row field for the horizontal axis, in the order the rows list it. series lists the numeric fields to plot, at most 6. A missing or null value counts as 0.
- title states the finding, not the metric. notes holds the range, totals and caveats, one per line.
- unit adds a prefix or suffix to values, such as "¥" or "%".
- At most 500 rows. Colors follow the app theme, so never set them. The highest point gets a label, and the developer can open the rows as a table.
- Put prose before and after the chart; the chart does not explain itself.`
