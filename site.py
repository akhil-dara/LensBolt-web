"""Build site/: lensbolt.com, a static site for Cloudflare Pages (free tier: files, _headers, _redirects only).

    python web/build.py && python web/site.py [--apk path/to/app-release.apk] [--play-live]

    /             the landing (web/site/index.html)
    /send         the sender (web/index.html), /receive the receiver (web/receive.html): the multi-file pages,
                  so the browser caches the wasm on its own; their scripts, modules, decode worker, wasm and
                  pictures go to /a/, each named by its content hash
    /privacy      PRIVACY.md with the site's styles
    /downloads/   the offline single-file pages (web/dist) and the Android APK when there is one
    /sw.js        the service worker: precaches /send, /receive, /a/* and the app icon, versioned by their hash
    /manifest.webmanifest   the sender's web app manifest (linked from /send on desktops only)
    _headers, _redirects    Cloudflare Pages' own files

web/index.html and web/receive.html are not changed: what the hosted site needs (hashed paths, the manifest, the
worker's registration, the Android app banner, styles moved out of style attributes) goes into their copies in
site/ here. web/dist must match its sources (web/dist/stamp.json, written by web/build.py): otherwise site.py stops.

The Android app: drop the APK at site/downloads/lensbolt.apk (a rebuild keeps it) or pass --apk; it is never
committed. Without an APK the landing says "Coming to Google Play" and /receive shows no app banner, until
--play-live says the Play listing is live.
"""
import argparse
import base64
import datetime
import hashlib
import html
import json
import os
import re
import shutil
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = HERE
SRC = os.path.join(HERE, "site")
OUT = os.path.join(ROOT, "public")
sys.path.insert(0, HERE)
import build as webbuild  # noqa: E402  (web/build.py: the stamp of web/dist)

GITHUB = "https://github.com/akhil-dara/lensbolt-web"
PLAY_URL = "https://play.google.com/store/apps/details?id=com.lensbolt.app"
APK = "lensbolt.apk"
SINGLE = webbuild.SINGLE
MAX_FILE = 25 * 1024 * 1024      # Cloudflare Pages' per-file limit
MAX_FILES = 20000                # and its file count limit (free tier)
MAX_HEADER_LINE = 2000           # and the longest line _headers may have
SITE_URL = "https://lensbolt.com"
AUTHOR = {"name": "Akhil Dara", "url": "https://github.com/akhil-dara"}
REPOS = ["https://github.com/akhil-dara/lensbolt-core", "https://github.com/akhil-dara/lensbolt-web", "https://github.com/akhil-dara/lensbolt-android"]
# the pages a search engine should list beside the landing: their titles and descriptions in search results
SEO = {
    "/send": ("Send a file to a phone camera: LensBolt sender", "Send a file from this screen to a phone camera. No cable, no network, no account, and every byte checked with SHA-256."),
    "/receive": ("Receive a file with your phone camera: LensBolt receiver", "Receive a file from a LensBolt screen with this phone's camera or a webcam. Nothing is uploaded; every byte is checked."),
    "/privacy": ("Privacy: LensBolt", "LensBolt's privacy policy: the app and the website collect nothing."),
    "/downloads/": ("Downloads: LensBolt", "LensBolt's sender and receiver as single offline HTML files, and the Android app."),
}
# hosts that serve the same files and must not compete with lensbolt.com in search results
DUPLICATE_HOSTS = ["https://www.lensbolt.com", "https://lensbolt.pages.dev", "https://:version.lensbolt.pages.dev"]
PAGES_ON_DISK = {"/": "index.html", "/send": "send.html", "/receive": "receive.html", "/privacy": "privacy.html", "/downloads/": "downloads/index.html"}

LLMS = """# LensBolt

> Send a file from any screen to a phone camera. No cable, no network, no account: the file plays on the screen as a moving square of cells (up to 1024 by 1024 pixels, 30 frames a second), and a camera reads it. Every file is checked with SHA-256. Free and open source (AGPL-3.0), by {author}.

## Use it

- [Send a file]({site}/send): the sender, in any current browser.
- [Receive a file]({site}/receive): the receiver, with a phone camera, a webcam or a shared window.
- [Downloads]({site}/downloads/): both pages as single offline HTML files.
- [Android app](https://github.com/akhil-dara/lensbolt-android/releases/latest): the receiver for Android 10 or newer.

## How it works

- The sender splits the file into packets, adds Reed-Solomon error correction and a fountain code, and draws the packets as frames of black-and-white, grey or colour cells.
- The receiver finds the square by its four corner markers and timing border, corrects tilt, rotation and lens distortion, reads the cells and corrects errors. No particular frame is needed: enough frames rebuild the file.
- Nothing is uploaded: the pages run entirely in the browser and work offline after the first visit.

## Source

- [lensbolt-core](https://github.com/akhil-dara/lensbolt-core): the codec and decoder (Rust).
- [lensbolt-web](https://github.com/akhil-dara/lensbolt-web): the sender, the receiver and this site.
- [lensbolt-android](https://github.com/akhil-dara/lensbolt-android): the Android receiver.
- [Privacy]({site}/privacy): LensBolt collects nothing.
"""

_emitted = {}
_emitting = set()


def rel_out(path):
    return "/" + os.path.relpath(path, OUT).replace(os.sep, "/")


def short_hash(data):
    return hashlib.sha256(data).hexdigest()[:10]


def emit(src):
    """Copy a file the pages load into site/a/ (from web/) or site/i/ (the site's own, from web/site/) under a name
    that carries its content hash; returns its URL. A script's own references are rewritten first, so its hash
    covers what it loads (two scripts that load each other cannot both carry the other's hash: refused)."""
    src = os.path.normpath(src)
    if src in _emitted:
        return _emitted[src]
    if src in _emitting:
        raise SystemExit(f"site.py: {src} loads itself through its imports; hashed names cannot express a cycle")
    if not os.path.isfile(src):
        raise SystemExit(f"site.py: {src} is referenced but missing (run python web/build.py first?)")
    _emitting.add(src)
    data = open(src, "rb").read()
    stem, ext = os.path.splitext(os.path.basename(src))
    if ext in (".js", ".mjs"):
        data = rewrite_js(data.decode("utf-8"), os.path.dirname(src), relative=True).encode("utf-8")
    _emitting.discard(src)
    sub = "i" if src.startswith(SRC + os.sep) else "a"
    name = f"{stem}.{short_hash(data)}{ext}"
    os.makedirs(os.path.join(OUT, sub), exist_ok=True)
    open(os.path.join(OUT, sub, name), "wb").write(data)
    _emitted[src] = f"/{sub}/{name}"
    return _emitted[src]


def target(ref, base):
    """The file a page's or script's relative reference names, or None for URLs, anchors and the like."""
    if re.match(r"^(?:[a-z]+:|/|#)", ref) or not ref:
        return None
    path = os.path.normpath(os.path.join(base, ref.split("#")[0].split("?")[0]))
    return path if os.path.isfile(path) else None


def rewrite_js(code, base, relative):
    """import ... from './x.js', import('./x.js') and new URL('x', import.meta.url) (a query dropped: the hashed
    name already changes with the content) point at the hashed copies; inside site/a/ a sibling's name, in a
    page an absolute /a/ path."""
    def url(ref):
        t = target(ref, base)
        if not t:
            return None
        u = emit(t)
        return "./" + u.rsplit("/", 1)[1] if relative and u.startswith("/a/") else u

    def sub_from(m):
        u = url(m.group(3))
        return m.group(0) if u is None else f"{m.group(1)}{m.group(2)}{u}{m.group(2)}"

    code = re.sub(r"(\bfrom\s*)(['\"])(\.{1,2}/[^'\"]+)\2", sub_from, code)
    code = re.sub(r"(\bimport\s*\(\s*)(['\"])(\.{1,2}/[^'\"]+)\2", sub_from, code)

    def sub_url(m):
        u = url(m.group(3))
        return m.group(0) if u is None else f"{m.group(1)}'{u}'{m.group(5)}"
    code = re.sub(r"(new URL\(\s*)([`'\"])([^`'\"$?]+)(\?[^`'\"]*)?\2(\s*,\s*import\.meta\.url\s*\))", sub_url, code)
    return code


def rewrite_html(doc, base, pages=None):
    """A page's src/href/srcset references to files point at their hashed copies; links between the two app
    pages become their clean URLs."""
    pages = pages or {}

    def attr(m):
        name, ref = m.group(1), m.group(2)
        if ref in pages:
            return f'{name}="{pages[ref]}"'
        t = target(ref, base)
        assert not (t and t.endswith(".html")), f"a link to a page site.py does not map: {ref}"
        return f'{name}="{emit(t)}"' if t else m.group(0)
    doc = re.sub(r'\b(src|href)="([^"]*)"', attr, doc)

    def srcset(m):
        parts = []
        for item in m.group(1).split(","):
            ref, _, size = item.strip().partition(" ")
            t = target(ref, base)
            parts.append(f"{emit(t) if t else ref} {size}".strip())
        return f'srcset="{", ".join(parts)}"'
    doc = re.sub(r'\bsrcset="([^"]*)"', srcset, doc)
    doc = re.sub(r"\{\{asset:([^}]+)\}\}", lambda m: emit(os.path.join(base, m.group(1))), doc)
    return rewrite_js(doc, base, relative=False)


def lift_styles(doc):
    """style="..." attributes become classes with the same declarations (marked !important, as an inline style
    outranks the page's rules), so the CSP needs no 'unsafe-inline' for styles; the rules go into one <style>
    block, hashed like the others."""
    rules = {}

    def tag(m):
        t = m.group(0)
        sm = re.search(r'\sstyle="([^"]*)"', t)
        css = sm.group(1)
        cls = "lbs-" + hashlib.sha256(css.encode()).hexdigest()[:8]
        rules[cls] = css
        t = t[:sm.start()] + t[sm.end():]
        cm = re.search(r'\sclass="([^"]*)"', t)
        if cm:
            return t[:cm.start()] + f' class="{cm.group(1)} {cls}"' + t[cm.end():]
        return re.sub(r"^<([\w-]+)", lambda x: f'<{x.group(1)} class="{cls}"', t, count=1)
    doc = re.sub(r'<[a-zA-Z][\w-]*\b[^<>]*\sstyle="[^"]*"[^<>]*>', tag, doc)
    if rules:
        css = "\n".join(f"  .{c} {{ " + " ".join(f"{d.strip()} !important;" for d in decl.split(";") if d.strip()) + " }" for c, decl in sorted(rules.items()))
        doc = doc.replace("</head>", f"<style>\n{css}\n</style>\n</head>", 1)
    assert not re.search(r'\sstyle="', doc), "a style attribute left"
    return doc


def inline_scripts(doc):
    # a data block (JSON-LD) is never run: the CSP does not govern it, so it needs no hash
    return re.findall(r"<script\b(?![^>]*\bsrc=)(?![^>]*application/ld\+json)[^>]*>([\s\S]*?)</script>", doc)


def inline_styles(doc):
    return re.findall(r"<style\b[^>]*>([\s\S]*?)</style>", doc)


def hashes(blocks):
    return " ".join(f"'sha256-{base64.b64encode(hashlib.sha256(s.encode('utf-8')).digest()).decode()}'" for s in dict.fromkeys(blocks))


def write(rel, text):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w", encoding="utf-8", newline="\n").write(text)


def read(path):
    # LF only: the browser hashes an inline script after the HTML parser has turned CRLF into LF
    return open(path, encoding="utf-8").read().replace("\r\n", "\n")


def size_text(n):
    return f"{n / 1e6:.1f} MB" if n >= 1e5 else f"{max(1, round(n / 1e3))} KB"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check_dist(allow_stale):
    """web/dist's pages are published as they are: they must be what web/build.py made from today's sources."""
    path = os.environ.get("LENSBOLT_DIST_STAMP") or os.path.join(HERE, "dist", "stamp.json")
    problems = []
    try:
        stamp = json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        problems.append("web/dist has no build stamp (web/dist/stamp.json)")
    else:
        if stamp.get("inputs") != webbuild.inputs_hash():
            problems.append("web/dist was built from older sources")
        problems += [f"web/dist/{s} is not the file web/build.py wrote" for s in SINGLE if stamp.get(s) != webbuild.file_hash(os.path.join(HERE, "dist", s))]
    if problems:
        msg = "site.py: " + "; ".join(problems) + ": run python web/build.py first"
        if not allow_stale:
            raise SystemExit(msg)
        print("WARNING " + msg + " (--allow-stale-dist: building anyway)", flush=True)
    return not problems


# ---- the hosted site's additions to the app pages ----

REGISTER = '<script>if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));</script>'
# Android, including a tablet whose browser asks for desktop pages (its user agent then reads as Linux, but
# userAgentData still says Android)
ANDROID_JS = '(/Android/i.test(navigator.userAgent) || (navigator.userAgentData && navigator.userAgentData.platform === "Android"))'
# installing as an app is for the sender on desktops; phones and tablets get no manifest (on Android the app is
# the receiver)
DESKTOP_MANIFEST = ('<script>(() => { const ua = navigator.userAgent, d = navigator.userAgentData; '
                    f'if ({ANDROID_JS} || /iPhone|iPad|iPod|Mobile/i.test(ua) || (d && d.mobile) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))) return; '
                    'const l = document.createElement("link"); l.rel = "manifest"; l.href = "/manifest.webmanifest"; document.head.appendChild(l); })();</script>')


def android_banner(href, icon):
    # Hide is remembered in this browser (localStorage, in try/catch: without storage it hides for this visit)
    return f"""<aside class="lb-app" id="lb-app" aria-label="The LensBolt app" hidden>
  <img src="{icon}" alt="" width="40" height="40">
  <p><b>Faster in the LensBolt app</b><span>For Android, no internet needed.</span></p>
  <a href="{href}">Get the app</a>
  <button type="button" id="lb-app-x" aria-label="Hide"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
</aside>
<script>(() => {{ const el = document.getElementById("lb-app"); if (!el || !{ANDROID_JS}) return; let off = false; try {{ off = localStorage.getItem("lb-app-hidden") === "1"; }} catch (e) {{}} if (off) return; el.hidden = false; document.getElementById("lb-app-x").addEventListener("click", () => {{ el.hidden = true; try {{ localStorage.setItem("lb-app-hidden", "1"); }} catch (e) {{}} }}); }})();</script>
"""


BANNER_STYLE = """<style>
  .lb-app { display: flex; align-items: center; gap: 12px; margin: 0 0 16px; padding: 12px 8px 12px 12px; border: 1px solid var(--border, #E4ECFC); border-radius: 14px; background: var(--card, #fff); color: var(--fg, #0F172A); }
  .lb-app[hidden] { display: none; }
  .lb-app img { width: 40px; height: 40px; flex: none; }
  .lb-app p { margin: 0; display: grid; line-height: 1.3; font-size: 15px; min-width: 0; }
  .lb-app p span { color: var(--muted-fg, #475569); font-size: 13px; }
  .lb-app a { margin-left: auto; flex: none; padding: 9px 14px; border-radius: 10px; background: var(--btn, #2563EB); color: #fff; font-weight: 600; font-size: 14px; text-decoration: none; }
  .lb-app button { flex: none; width: 40px; height: 40px; display: grid; place-items: center; border: 0; background: none; color: var(--muted-fg, #475569); border-radius: 10px; }
  .lb-app button:focus-visible, .lb-app a:focus-visible { outline: 2px solid var(--ring, #2563EB); outline-offset: 2px; }
</style>
"""


def seo_head(path, title, description, image):
    """The canonical address and the social card of one page (every host's copy names lensbolt.com)."""
    url = SITE_URL + path
    e = html.escape
    return (f'<link rel="canonical" href="{url}">\n<meta property="og:type" content="website">\n<meta property="og:site_name" content="LensBolt">\n'
            f'<meta property="og:url" content="{url}">\n<meta property="og:title" content="{e(title)}">\n<meta property="og:description" content="{e(description)}">\n'
            f'<meta property="og:image" content="{SITE_URL}{image}">\n<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">\n'
            '<meta name="twitter:card" content="summary_large_image">\n')


def json_ld(image):
    """The landing's structured data: the site, its author and the app (free, open source, in a browser and on Android)."""
    graph = [
        {"@type": "WebSite", "@id": SITE_URL + "/#website", "url": SITE_URL + "/", "name": "LensBolt", "inLanguage": "en",
         "description": "Send a file from any screen to a phone camera. No cable, no network, no account.", "publisher": {"@id": SITE_URL + "/#author"}},
        {"@type": "Person", "@id": SITE_URL + "/#author", "name": AUTHOR["name"], "url": AUTHOR["url"], "sameAs": [AUTHOR["url"]]},
        {"@type": "WebApplication", "@id": SITE_URL + "/#app", "name": "LensBolt", "url": SITE_URL + "/",
         "description": "Moves a file from one screen to a camera as a moving pattern of cells: no cable, no network, no account. Every file is checked with SHA-256.",
         "applicationCategory": "UtilitiesApplication", "operatingSystem": "Any current web browser; Android 10 or newer",
         "browserRequirements": "JavaScript and WebAssembly; a camera to receive",
         "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}, "isAccessibleForFree": True,
         "license": "https://www.gnu.org/licenses/agpl-3.0.html", "image": SITE_URL + image, "author": {"@id": SITE_URL + "/#author"},
         "featureList": ["Works with no network connection", "Every file verified with SHA-256", "Receive with a phone camera, a webcam or a shared window",
                         "Runs in the browser; offline single-file pages", "Open source (AGPL-3.0)"], "sameAs": REPOS},
    ]
    body = json.dumps({"@context": "https://schema.org", "@graph": graph}, indent=1, ensure_ascii=False).replace("</", "<\\/")
    return f'<script type="application/ld+json">\n{body}\n</script>'


def app_page(name, out_name, extra_head, after_start="", title=None):
    doc = rewrite_html(read(os.path.join(HERE, name)), HERE, pages={"index.html": "/send", "receive.html": "/receive"})
    if title:
        # the hosted copy's title and description are the search result's; the page in the repository keeps its short ones
        doc, n = re.subn(r"<title>[^<]*</title>", lambda m: f"<title>{html.escape(title[0])}</title>", doc, count=1)
        doc, k = re.subn(r'<meta name="description" content="[^"]*">', lambda m: f'<meta name="description" content="{html.escape(title[1])}">', doc, count=1)
        assert n == 1 and k == 1, f"{name}: no title or description to replace"
    left = re.findall(r"""(?:from\s*|import\s*\(\s*|new URL\(\s*)['"`](\.{1,2}/[^'"`]+)""", doc) + re.findall(r'\b(?:src|href)="((?:\./)?(?:assets|pkg)/[^"]+)"', doc)
    assert not left, f"{name}: references site.py did not map: {left}"
    # the single file's loader placeholder: empty in the multi-file page (its development block loads the module)
    doc = doc.replace('<script type="module" id="loader"></script>\n', "")
    assert "</head>" in doc
    doc = doc.replace("</head>", extra_head + "</head>", 1)
    if after_start:
        m = re.search(r'<main id="start"[^>]*>\n?', doc) or re.search(r"<body[^>]*>\n?", doc)
        assert m, f"{name}: no place for the app banner"
        doc = doc[:m.end()] + after_start + doc[m.end():]
    doc = lift_styles(doc)
    write(out_name, doc)
    return doc


# ---- PRIVACY.md -> HTML (the few constructs it uses) ----

def inline_md(text):
    links = []

    def keep(html_text):
        links.append(html_text)
        return f"\x00{len(links) - 1}\x00"
    text = re.sub(r"<(https?://[^>\s]+)>", lambda m: keep(f'<a href="{html.escape(m.group(1))}" rel="noopener">{html.escape(m.group(1))}</a>'), text)
    text = re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", lambda m: keep(f'<a href="{html.escape(m.group(2))}">{html.escape(m.group(1))}</a>'), text)
    text = html.escape(text, quote=False)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: links[int(m.group(1))], text)


def markdown(md):
    md = re.sub(r"\A---\n.*?\n---\n", "", md.replace("\r\n", "\n"), flags=re.S)
    out, para, items = [], [], []

    def flush():
        if para:
            text = " ".join(para)
            cls = ' class="stamp"' if text.startswith("Last updated") else ""
            out.append(f"<p{cls}>{inline_md(text)}</p>")
            para.clear()
        if items:
            out.append("<ul>\n" + "\n".join(f"<li>{inline_md(i)}</li>" for i in items) + "\n</ul>")
            items.clear()
    for line in md.split("\n"):
        if not line.strip():
            flush()
        elif line.startswith("#"):
            flush()
            level = len(line) - len(line.lstrip("#"))
            out.append(f"<h{level}>{inline_md(line[level:].strip())}</h{level}>")
        elif line.startswith("- "):
            if para:
                flush()
            items.append(line[2:].strip())
        elif items and line.startswith("  "):
            items[-1] += " " + line.strip()
        else:
            para.append(line.strip())
    flush()
    return "\n".join(out)


SITE_PRIVACY = """## This website

This section covers the pages at lensbolt.com. They run entirely in your browser: a file you send or receive with
them never leaves your device. The sender shows it on the screen, and the receiver reads it with the camera and
keeps it in the browser's storage for this site only until you save it or start again. The receiver asks for
camera access only to read the screen, and the camera pictures stay on your device.

The site sets no cookies and has no accounts, analytics or advertising. The pages remember a few settings, such as
the theme, in your browser. The site is hosted on Cloudflare Pages, which handles the requests your browser makes
to load the pages (including your IP address) under Cloudflare's own privacy policy.
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--apk", help="the Android APK to offer at /downloads/lensbolt.apk (kept out of git)")
    ap.add_argument("--play-live", action="store_true", help="the Google Play listing is live: link it when there is no APK")
    ap.add_argument("--allow-stale-dist", action="store_true", help="publish web/dist even when its stamp does not match (a warning; for tests)")
    args = ap.parse_args()
    for f in [os.path.join(HERE, "pkg", "lensbolt_web.js"), os.path.join(HERE, "pkg", "lensbolt_web_bg.wasm")] + [os.path.join(HERE, "dist", s) for s in SINGLE]:
        if not os.path.isfile(f):
            raise SystemExit(f"site.py: {f} is missing: run python web/build.py first")
    check_dist(args.allow_stale_dist)

    # a clean site/, except an APK the owner dropped into site/downloads/
    keep = None
    old_apk = os.path.join(OUT, "downloads", APK)
    if os.path.isfile(old_apk):
        keep = open(old_apk, "rb").read()
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "downloads"))
    apk_path = os.path.join(OUT, "downloads", APK)
    if args.apk:
        shutil.copyfile(args.apk, apk_path)
    elif keep is not None:
        open(apk_path, "wb").write(keep)
    has_apk = os.path.isfile(apk_path)
    if has_apk and os.path.getsize(apk_path) >= MAX_FILE:
        raise SystemExit(f"site.py: the APK is {os.path.getsize(apk_path) / 2**20:.1f} MiB; Cloudflare Pages takes files under 25 MiB")
    app_href = f"/downloads/{APK}" if has_apk else PLAY_URL if args.play_live else None

    icon192, icon512, touch = (emit(os.path.join(SRC, "assets", n)) for n in ("icon-192.png", "icon-512.png", "apple-touch-icon.png"))
    touch_link = f'<link rel="apple-touch-icon" href="{touch}">\n<meta name="apple-mobile-web-app-title" content="LensBolt">\n'

    # the app pages (the banner only when there is an app to get)
    social = emit(os.path.join(SRC, "assets", "social.jpg"))
    send = app_page("index.html", "send.html", seo_head("/send", *SEO["/send"], social) + touch_link + DESKTOP_MANIFEST + "\n" + REGISTER + "\n", title=SEO["/send"])
    receive = app_page("receive.html", "receive.html", seo_head("/receive", *SEO["/receive"], social) + touch_link + (BANNER_STYLE if app_href else "") + REGISTER + "\n",
                       android_banner(app_href, icon192) if app_href else "", title=SEO["/receive"])

    # the site's own pages
    icons = read(os.path.join(SRC, "icons.svg"))
    footer = read(os.path.join(SRC, "footer.html"))

    def site_page(template, values):
        doc = read(os.path.join(SRC, template))
        for k, v in {"icons": icons, "footer": footer, **values}.items():
            doc = doc.replace("{{" + k + "}}", v)
        doc = rewrite_html(doc, SRC)
        assert "{{" not in doc, f"{template}: a placeholder left: {re.search(r'{{[^}]*}}', doc).group(0)}"
        return doc

    sizes = {s: size_text(os.path.getsize(os.path.join(HERE, "dist", s))) for s in SINGLE}
    apk_sha = sha256_file(apk_path) if has_apk else None
    if has_apk:
        android = f"""    <div class="get">
      <a class="btn primary" href="/downloads/{APK}" download><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Download the app</a>
      <small class="tnum">{APK}, {size_text(os.path.getsize(apk_path))}, Android 10 or newer</small>
    </div>
    <div class="sha" id="apk-sha">
      <p>Before you install it, you can check that the file is the one published here. Its SHA-256:</p>
      <code class="tnum">{apk_sha}</code>
      <p>On Windows: <code>certutil -hashfile {APK} SHA256</code>. On a Mac or Linux: <code>shasum -a 256 {APK}</code>.</p>
    </div>"""
    elif args.play_live:
        android = f"""    <div class="get">
      <a class="btn primary" href="{PLAY_URL}" rel="noopener">Get it on Google Play</a>
      <small>Free, with no ads and no account.</small>
    </div>"""
    else:
        android = """    <div class="get">
      <p class="soon" id="play-soon">Coming to Google Play</p>
      <a class="opt" href="https://github.com/akhil-dara/lensbolt-android/releases/latest" rel="noopener">Download the APK from GitHub Releases</a>
      <small>Until then, receive in the phone's browser at lensbolt.com/receive.</small>
    </div>"""
    # the landing and the privacy page register the worker too: a visit to lensbolt.com alone left nothing working
    # offline (2026-11-07); their only script, allowed by its hash
    registered = lambda doc: doc.replace("</head>", REGISTER + "\n</head>", 1)
    write("index.html", registered(site_page("index.html", {"android": android, "jsonld": json_ld(social), **{f"size:{s}": sizes[s] for s in SINGLE}})))

    privacy_md = read(os.path.join(ROOT, "PRIVACY.md"))
    privacy_md = privacy_md.replace("\n## Changes", "\n" + SITE_PRIVACY + "\n## Changes", 1) if "\n## Changes" in privacy_md else privacy_md + "\n" + SITE_PRIVACY
    write("privacy.html", registered(site_page("page.html", {"title": SEO["/privacy"][0], "description": SEO["/privacy"][1], "head": seo_head("/privacy", *SEO["/privacy"], social), "body": markdown(privacy_md)})))

    rows = []
    for s, what, note in [("lensbolt.html", "The sender", "Shows your files on this screen for a camera to read."),
                          ("lensbolt-receive.html", "The receiver", "Reads a LensBolt screen with a camera, or a window on the same screen.")]:
        shutil.copyfile(os.path.join(HERE, "dist", s), os.path.join(OUT, "downloads", s))
        rows.append((f"/downloads/{s[:-5]}", s, what, note, sizes[s], sha256_file(os.path.join(OUT, "downloads", s))))
    if has_apk:
        rows.append((f"/downloads/{APK}", APK, "The Android app", "The receiver for Android 10 or newer.", size_text(os.path.getsize(apk_path)), apk_sha))
    items = "\n".join(f"""<li><a href="{href}" download="{name}"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg><span class="what"><b>{what}</b><span>{note}</span></span><span class="size tnum">{size}</span></a>
  <p class="sha"><span class="mono">{name}</span> SHA-256<code class="tnum">{sha}</code></p></li>""" for href, name, what, note, size, sha in rows)
    play_line = "" if has_apk else (f'The Android app: <a href="{PLAY_URL}" rel="noopener">Google Play</a>. ' if args.play_live else "The Android app is coming to Google Play. ")
    body = f"""<h1>Downloads</h1>
<p>The sender and the receiver as single HTML files: everything is inside, so they run from a USB stick or a computer with no internet. Open them in any current browser.</p>
<ul class="files">
{items}
</ul>
<p>{play_line}The pages online: <a href="/send">Send</a> and <a href="/receive">Receive</a>.</p>"""
    write("downloads/index.html", site_page("page.html", {"title": SEO["/downloads/"][0], "description": SEO["/downloads/"][1], "head": seo_head("/downloads/", *SEO["/downloads/"], social), "body": body}))
    write("404.html", site_page("page.html", {"title": "Not found: LensBolt", "description": "This page does not exist.", "head": '<meta name="robots" content="noindex">\n',
                                              "body": '<h1>Nothing here</h1>\n<p>This page does not exist. Try the <a href="/">home page</a>, <a href="/send">Send</a> or <a href="/receive">Receive</a>.</p>'}))

    # search: robots.txt names the sitemap (Cloudflare puts its content-signals notice above it), the sitemap lists
    # the pages, llms.txt describes the site for language-model tools
    write("robots.txt", f"User-agent: *\nAllow: /\n\nSitemap: {SITE_URL}/sitemap.xml\n")
    # a favicon at the root, at an address that never changes: search engines' icon crawlers look there too (the
    # pages' icon link names a content-hashed copy). An ICO holding the 192 px PNG as it is (192 = 4 x 48, the
    # multiple of 48 px Google asks for)
    png = open(os.path.join(SRC, "assets", "icon-192.png"), "rb").read()
    ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 192, 192, 0, 0, 1, 32, len(png), 22) + png
    open(os.path.join(OUT, "favicon.ico"), "wb").write(ico)
    today = datetime.date.today().isoformat()
    urls = "".join(f"  <url><loc>{SITE_URL}{p}</loc><lastmod>{today}</lastmod></url>\n" for p in ["/", "/send", "/receive", "/downloads/", "/privacy"])
    write("sitemap.xml", f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n')
    write("llms.txt", LLMS.format(site=SITE_URL, author=AUTHOR["name"]))

    # the manifest (the sender, on desktops)
    write("manifest.webmanifest", json.dumps({
        "id": "/send", "name": "LensBolt", "short_name": "LensBolt",
        "description": "Send files from this screen to a phone camera. No cable, no network, no account.",
        "start_url": "/send", "scope": "/", "display": "standalone", "background_color": "#F8FAFC", "theme_color": "#2563EB",
        "icons": [{"src": icon192, "sizes": "192x192", "type": "image/png"}, {"src": icon512, "sizes": "512x512", "type": "image/png"}],
    }, indent=2) + "\n")

    # the service worker: the landing, the privacy page and the two apps, every file under a/ and under i/ (the
    # landing's styles and pictures, the icons: 276 KB), versioned by their hash and by the worker's own code
    sw_pages = ["/", "/privacy", "/receive", "/send"]
    hashed = sorted([rel_out(os.path.join(OUT, d, f)) for d in ("a", "i") for f in os.listdir(os.path.join(OUT, d))])
    precache = sorted(sw_pages + hashed)
    template = read(os.path.join(SRC, "sw.js"))
    h = hashlib.sha256(template.encode("utf-8"))
    for u in precache:
        h.update((u + "\n").encode())
        h.update(open(os.path.join(OUT, PAGES_ON_DISK.get(u, u.lstrip("/"))), "rb").read())
    version = h.hexdigest()[:16]
    write("sw.js", template.replace("{{version}}", version).replace("{{pages}}", json.dumps(sw_pages)).replace("{{hashed}}", json.dumps(hashed)))

    # _headers: one Cache-Control and one CSP per path (Pages joins a header named by several matching rules)
    common = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'"
    site_csp = f"{common}; img-src 'self'; style-src 'self'; form-action 'none'"
    # the landing and the privacy page: their one script (the worker's registration) and the worker
    reg_csp = f"{site_csp}; script-src {hashes(inline_scripts(REGISTER))}; worker-src 'self'"

    def app_csp(doc):
        return (f"{common}; script-src 'self' 'wasm-unsafe-eval' {hashes(inline_scripts(doc))}; style-src 'self' {hashes(inline_styles(doc))}; img-src 'self' blob:; "
                "media-src 'self' blob:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'")
    for name in ("index.html", "privacy.html", "downloads/index.html", "404.html"):
        doc = read(os.path.join(OUT, name))
        allowed = inline_scripts(REGISTER) if name in ("index.html", "privacy.html") else []
        assert inline_scripts(doc) == allowed and not inline_styles(doc) and not re.search(r'\sstyle="', doc), f"{name}: an inline script or style its CSP does not allow"
    rules = [
        ("/*", {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
                "Permissions-Policy": "camera=(self), display-capture=(self), microphone=(), geolocation=(), payment=(), usb=()",
                "Strict-Transport-Security": "max-age=31536000"}),
        ("/", {"Cache-Control": "no-store", "Content-Security-Policy": reg_csp}),
        ("/send", {"Cache-Control": "no-store", "Content-Security-Policy": app_csp(send)}),
        ("/receive", {"Cache-Control": "no-store", "Content-Security-Policy": app_csp(receive)}),
        ("/privacy", {"Cache-Control": "no-store", "Content-Security-Policy": reg_csp}),
        ("/downloads/", {"Cache-Control": "no-store", "Content-Security-Policy": site_csp}),
        ("/downloads/:file", {"Cache-Control": "no-store"}),
        ("/sw.js", {"Cache-Control": "no-store"}),
        ("/manifest.webmanifest", {"Cache-Control": "no-cache"}),
        ("/a/*", {"Cache-Control": "public, max-age=31536000, immutable"}),
        ("/i/*", {"Cache-Control": "public, max-age=31536000, immutable"}),
    ]
    for host in DUPLICATE_HOSTS:
        rules.append((host + "/*", {"X-Robots-Tag": "noindex"}))
    for p in ("/robots.txt", "/sitemap.xml", "/llms.txt"):
        rules.append((p, {"Cache-Control": "no-cache"}))
    # the offline pages download as files (opened from the site they would run without its CSP)
    for s in SINGLE:
        for p in (f"/downloads/{s[:-5]}", f"/downloads/{s}"):
            rules.append((p, {"Content-Disposition": f'attachment; filename="{s}"'}))
    if has_apk:
        rules.append((f"/downloads/{APK}", {"Content-Disposition": f'attachment; filename="{APK}"'}))
    headers = "# written by web/site.py\n" + "\n".join(p + "\n" + "\n".join(f"  {k}: {v}" for k, v in hd.items()) + "\n" for p, hd in rules)
    long = [line[:60] for line in headers.split("\n") if len(line) >= MAX_HEADER_LINE]
    assert not long, f"_headers lines of {MAX_HEADER_LINE} characters or more (Pages' limit): {long}"
    write("_headers", headers)
    # Pages already drops .html (/send.html -> /send); these keep the offline pages' old root names working
    write("_redirects", "# written by web/site.py\n/lensbolt.html /downloads/lensbolt 301\n/lensbolt-receive.html /downloads/lensbolt-receive 301\n")

    # the free tier's limits
    files = [os.path.join(d, f) for d, _, fs in os.walk(OUT) for f in fs]
    big = [(rel_out(f), os.path.getsize(f)) for f in files if os.path.getsize(f) >= MAX_FILE]
    assert not big, f"files over Cloudflare Pages' 25 MiB limit: {big}"
    assert len(files) < MAX_FILES, f"{len(files)} files: over Cloudflare Pages' limit"
    total = sum(os.path.getsize(f) for f in files)
    android_text = "the APK, SHA-256 " + apk_sha if has_apk else "the Play link" if args.play_live else "Coming to Google Play (no APK, no --play-live)"
    print(f"wrote {OUT}: {len(files)} files, {total / 1e6:.1f} MB; worker {version}, {len(precache)} precached; Android: {android_text}")


if __name__ == "__main__":
    sys.exit(main())
