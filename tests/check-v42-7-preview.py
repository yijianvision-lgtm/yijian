from pathlib import Path
import re
import subprocess
import tempfile

preview = Path("ui-preview-v42-7.html")
html = preview.read_text(encoding="utf-8")
assert html.lower().lstrip().startswith("<!doctype html>"), "Missing HTML doctype"
assert "<title>" in html.lower(), "Missing page title"
assert "</html>" in html.lower(), "HTML document is incomplete"
assert len(html) > 100_000, "Unexpectedly small preview file"

scripts = [
    (attributes, source)
    for attributes, source in re.findall(r"<script\b([^>]*)>([\s\S]*?)</script>", html, re.I)
    if source.strip() and not re.search(r'type\s*=\s*["\']importmap["\']', attributes, re.I)
]
assert scripts, "No inline JavaScript found"

with tempfile.TemporaryDirectory() as tmp:
    for index, (attributes, source) in enumerate(scripts, 1):
        script_path = Path(tmp) / f"inline-{index}.mjs"
        script_path.write_text(source, encoding="utf-8")
        result = subprocess.run(
            ["node", "--check", str(script_path)],
            capture_output=True,
            text=True,
        )
        if result.returncode:
            raise SystemExit(
                f"Inline script {index} ({attributes}) failed syntax check:\n{result.stderr}"
            )

print(f"V42.7 HTML verified: {len(html):,} characters")
print(f"Inline JavaScript syntax passed: {len(scripts)} blocks")
