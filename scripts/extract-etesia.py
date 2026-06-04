#!/usr/bin/env python3
"""Extract the clean UI sources from the self-contained Etesia bundle.

Produces ./etesia-ui-extracted/{App.jsx, coin-data.json, corr-data.json,
styles.css, body-skeleton.html}. Re-runnable; documents provenance of the
ported sources. See .claude/stellar-integration.md for the bundle anatomy.
"""
import re, json, base64, gzip, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "Etesia Portfolio Builder.html")
OUT = os.path.join(ROOT, "etesia-ui-extracted")
os.makedirs(OUT, exist_ok=True)

src = open(HTML, encoding="utf-8").read()

def script_body(typ):
    m = re.search(r'<script type="%s">(.*?)</script>' % re.escape(typ), src, re.DOTALL)
    if not m:
        sys.exit(f"missing <script type={typ}>")
    return m.group(1)

# ---- manifest: locate the App component (the JS asset containing riskParity) ----
manifest = json.loads(script_body("__bundler/manifest"))
app_js = None
for uuid, a in manifest.items():
    if not (a.get("mime") or "").endswith("javascript"):
        continue
    raw = base64.b64decode(a["data"])
    if a.get("compressed"):
        raw = gzip.decompress(raw)
    text = raw.decode("utf-8", "replace")
    if "riskParity" in text and "ConnectScreen" in text:
        app_js = text
        print(f"App component asset: {uuid[:8]}  ({len(text):,} chars)")
        break
if not app_js:
    sys.exit("App component not found in manifest")
open(os.path.join(OUT, "App.jsx"), "w").write(app_js)

# ---- template: data JSON, styles, body skeleton ----
template = json.loads(script_body("__bundler/template"))
open(os.path.join(OUT, "body-skeleton.html"), "w").write(template)

def tag_body(tid):
    m = re.search(r'<script[^>]*id="%s"[^>]*>(.*?)</script>' % re.escape(tid), template, re.DOTALL)
    return m.group(1) if m else None

coin = json.loads(tag_body("coin-data"))
corr = json.loads(tag_body("corr-data"))
json.dump(coin, open(os.path.join(OUT, "coin-data.json"), "w"), indent=2)
json.dump(corr, open(os.path.join(OUT, "corr-data.json"), "w"), indent=2)

styles = re.findall(r'<style[^>]*>(.*?)</style>', template, re.DOTALL)
open(os.path.join(OUT, "styles.css"), "w").write("\n\n".join(s.strip() for s in styles))

print(f"coin-data: {len(coin)} assets | corr-data: {type(corr).__name__} "
      f"{len(corr)} | styles: {len(styles)} block(s), {sum(len(s) for s in styles):,} chars")

# ---- font wiring intel (decide self-host vs Google in Step 2) ----
css = "\n".join(styles)
faces = re.findall(r'@font-face\s*\{[^}]*\}', css, re.DOTALL)
print(f"\n@font-face blocks in CSS: {len(faces)}")
for f in faces[:8]:
    print("  ", " ".join(f.split())[:160])
fams = sorted(set(re.findall(r'font-family:\s*([^;}]+)', css)))
print("\nfont-family declarations:")
for fam in fams:
    print("  ", fam.strip())
links = re.findall(r'<link[^>]*>', template)
print(f"\n<link> tags in template: {len(links)}")
for l in links:
    print("  ", l[:160])

# ---- WIRE INTO THE APP -------------------------------------------------------
# (1) self-host the embedded woff2 fonts under public/fonts/<uuid>.woff2
# (2) emit app/styles.css == extracted CSS with @font-face src rewritten to the
#     self-hosted paths (every other byte identical — preserves typography)
# (3) copy the static data JSON into data/ (the app's import target)
pub_fonts = os.path.join(ROOT, "public", "fonts")
os.makedirs(pub_fonts, exist_ok=True)
font_uuids = []
for uuid, a in manifest.items():
    if (a.get("mime") or "") == "font/woff2":
        raw = base64.b64decode(a["data"])
        if a.get("compressed"):
            raw = gzip.decompress(raw)
        open(os.path.join(pub_fonts, uuid + ".woff2"), "wb").write(raw)
        font_uuids.append(uuid)

app_css = "\n\n".join(s.strip() for s in styles)
for uuid in font_uuids:
    app_css = app_css.replace('url("%s")' % uuid, 'url("/fonts/%s.woff2")' % uuid)
open(os.path.join(ROOT, "app", "styles.css"), "w").write(app_css)

data_dir = os.path.join(ROOT, "data")
os.makedirs(data_dir, exist_ok=True)
json.dump(coin, open(os.path.join(data_dir, "coin-data.json"), "w"), indent=2)
json.dump(corr, open(os.path.join(data_dir, "corr-data.json"), "w"), indent=2)

leftover = re.findall(r'url\("[0-9a-f]{8}-[0-9a-f-]+"\)', app_css)
print(f"\nWired {len(font_uuids)} fonts -> public/fonts/ ; wrote app/styles.css "
      f"({len(app_css):,} chars) ; copied data/ JSON. Leftover unwired uuid urls: {len(leftover)}")
