#!/usr/bin/env python3
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
scratch = root / ".context/perf"
pattern = re.compile(
    r"function (Markdown(?:\$\w+)?)\((\w+)\) \{\n"
    r"  const processor = createProcessor\(\2\);\n"
    r"  const file = createFile\(\2\);\n"
    r"  return post\(processor.runSync\(processor.parse\(file\), file\), \2\);\n\}"
)
matches = []
for path in (root / "out/renderer/assets").glob("index-*.js"):
    source = path.read_text()
    if "__kkcodePerfMarkdown" in source:
        raise SystemExit("Already instrumented. Run pnpm build to restore before instrumenting again.")
    for match in pattern.finditer(source):
        matches.append((path, source, match))
if len(matches) != 1:
    raise SystemExit(
        f"Expected one built ReactMarkdown function, found {len(matches)}. "
        "Run pnpm build; if its output changed, update this explicit matcher."
    )

path, source, match = matches[0]
original = path.read_bytes()
digest = hashlib.sha256(original).hexdigest()
metadata = {
    "version": 1,
    "bundle": str(path.relative_to(root)),
    "originalSha256": digest,
    "functionName": match[1],
}
replacement = f"""globalThis.__kkcodePerfMarkdown = {{ ...{json.dumps(metadata)}, samples: null }};
function {match[1]}({match[2]}) {{
  const started = performance.now();
  const processor = createProcessor({match[2]});
  const file = createFile({match[2]});
  const result = post(processor.runSync(processor.parse(file), file), {match[2]});
  if (globalThis.__kkcodePerfMarkdown.samples) globalThis.__kkcodePerfMarkdown.samples.push({{chars: file.value.length, ms: performance.now() - started}});
  return result;
}}"""
instrumented = (source[:match.start()] + replacement + source[match.end():]).encode()
scratch.mkdir(parents=True, exist_ok=True)
backup = scratch / f"{digest}.original.js"
if not backup.exists():
    backup.write_bytes(original)
metadata["original"] = str(backup.relative_to(root))
metadata["instrumentedSha256"] = hashlib.sha256(instrumented).hexdigest()
(scratch / "instrumentation.json").write_text(json.dumps(metadata, indent=2) + "\n")
path.write_bytes(instrumented)
print(json.dumps(metadata, indent=2))
print("Run pnpm build to restore the bundle when measurements finish.")
