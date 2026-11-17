"""The app's own face, as files Rune can read.

Rune reads TrueType, not WOFF2, so the Hanken Grotesk the web renderer bundles
(@fontsource-variable/hanken-grotesk: variable weight, one file per script) is
unpacked here into apps/rune/fonts/, which is checked in. Run it again when the
package is bumped:

    python scripts/rune-fonts.py        (needs fonttools and brotli)

Rune keeps one face per family, weight and style, so the Latin Extended file
can't share the Latin one's family name: it's renamed "Hanken Grotesk Ext" and
named second in the family list (apps/rune/src/view.rs, FACE).
"""
import json
import os
import sys

from fontTools.ttLib import TTFont

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
pkg = os.path.join(root, "node_modules", "@fontsource-variable", "hanken-grotesk")
out = os.path.join(root, "apps", "rune", "fonts")
os.makedirs(out, exist_ok=True)

FILES = [
    ("latin-wght-normal", "HankenGrotesk-Latin.ttf", None),
    ("latin-wght-italic", "HankenGrotesk-Latin-Italic.ttf", None),
    ("latin-ext-wght-normal", "HankenGrotesk-LatinExt.ttf", "Hanken Grotesk Ext"),
    ("latin-ext-wght-italic", "HankenGrotesk-LatinExt-Italic.ttf", "Hanken Grotesk Ext"),
]

version = json.load(open(os.path.join(pkg, "package.json"), encoding="utf-8"))["version"]
for src, dst, family in FILES:
    font = TTFont(os.path.join(pkg, "files", f"hanken-grotesk-{src}.woff2"))
    font.flavor = None
    if family:
        for rec in font["name"].names:
            # 1 family, 4 full name, 16 typographic family
            if rec.nameID in (1, 16):
                rec.string = family
            elif rec.nameID == 4:
                rec.string = rec.toUnicode().replace("Hanken Grotesk", family)
    font.save(os.path.join(out, dst))
    names = {font["name"].getDebugName(i) for i in (1, 16)} - {None}
    print(f"{dst}: {os.path.getsize(os.path.join(out, dst)) // 1024} KB, family {sorted(names)}, axes {[a.axisTag for a in font['fvar'].axes]}")

with open(os.path.join(out, "README.md"), "w", encoding="utf-8", newline="\n") as f:
    f.write(
        "# Hanken Grotesk, for Rune\n\n"
        f"Unpacked from `@fontsource-variable/hanken-grotesk` {version} by `scripts/rune-fonts.py` (WOFF2 to TrueType;\n"
        "the Latin Extended files are renamed *Hanken Grotesk Ext*). SIL Open Font License 1.1, as the package's.\n"
        "`npm run rune:build` copies them beside the wasm, where Rune fetches them.\n"
    )
sys.exit(0)
