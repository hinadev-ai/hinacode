#!/usr/bin/env python3
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
scratch = root / ".context/perf"
pattern = re.compile(
    r"function (?P<name>[\w$]+)\((?P<options>[\w$]+)\)\{"
    r"const (?P<processor>[\w$]+)=(?P<createProcessor>[\w$]+)\((?P=options)\),"
    r"(?P<file>[\w$]+)=(?P<createFile>[\w$]+)\((?P=options)\);"
    r"return (?P<post>[\w$]+)\((?P=processor)\.runSync\((?P=processor)\.parse\((?P=file)\),(?P=file)\),(?P=options)\)\}"
)
matches = []
for path in (root / "out/renderer/assets").glob("*.js"):
    source = path.read_text()
    if "__hinacodePerfMarkdown" in source:
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
    "functionName": match["name"],
}
m = match.groupdict()
replacement = f"""globalThis.__hinacodePerfMarkdown = {{ ...{json.dumps(metadata)}, samples: null }};
function {m["name"]}({m["options"]}) {{
  const started = performance.now();
  const {m["processor"]} = {m["createProcessor"]}({m["options"]});
  const {m["file"]} = {m["createFile"]}({m["options"]});
  const result = {m["post"]}({m["processor"]}.runSync({m["processor"]}.parse({m["file"]}), {m["file"]}), {m["options"]});
  if (globalThis.__hinacodePerfMarkdown.samples) globalThis.__hinacodePerfMarkdown.samples.push({{chars: {m["file"]}.value.length, ms: performance.now() - started}});
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
