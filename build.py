"""Build the browser sender.

    python web/build.py            -> web/pkg/* (wasm + JS glue) and web/dist/lensbolt.html (single file, offline)

The single file inlines the JS glue and the .wasm (base64) into index.html, so it works from a USB stick,
an email attachment or file:// with no server and no network.

web/dist/stamp.json records a hash of the files the two pages are made from and of the pages themselves;
web/site.py refuses to publish web/dist when it no longer matches (the pages are then older than their sources).
"""
import base64
import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def run(cmd, cwd=HERE):
    print("+", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def main():
    # SIMD: the decoder's sampling loops (Chrome 91+, Safari 16.4+, Firefox 89+). The source paths the wasm keeps
    # (panic locations) are remapped: the repository to "lensbolt", Cargo's home (the crates' sources) to "cargo", so
    # the pages carry no build machine's user or folder names. Both found here, never written in; passed as
    # CARGO_ENCODED_RUSTFLAGS (the RUSTFLAGS list, one flag per field) so a path with spaces stays one flag
    root = HERE
    cargo_home = os.environ.get("CARGO_HOME") or os.path.join(os.path.expanduser("~"), ".cargo")
    flags = ["-C", "target-feature=+simd128", f"--remap-path-prefix={root}=lensbolt", f"--remap-path-prefix={os.path.abspath(cargo_home)}=cargo"]
    env = dict(os.environ, CARGO_ENCODED_RUSTFLAGS="\x1f".join(flags))
    env.pop("RUSTFLAGS", None)
    print("+ cargo build --release --target wasm32-unknown-unknown (simd128, paths remapped)", flush=True)
    subprocess.run(["cargo", "build", "--release", "--target", "wasm32-unknown-unknown"], cwd=HERE, check=True, env=env)
    wasm = os.path.join(HERE, "target", "wasm32-unknown-unknown", "release", "lensbolt_web.wasm")
    run(["wasm-bindgen", "--target", "web", "--out-dir", "pkg", wasm])
    html = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    js = open(os.path.join(HERE, "pkg", "lensbolt_web.js"), encoding="utf-8").read()
    wasm_b64 = base64.b64encode(open(os.path.join(HERE, "pkg", "lensbolt_web_bg.wasm"), "rb").read()).decode()
    # the glue is an ES module; inside the single file it becomes plain module-scope code (the wasm bytes
    # are handed to the init function instead of being fetched by URL)
    js = re.sub(r"export\s*\{[^}]*\}\s*;?", "", js)
    js = re.sub(r"^export default [^;]+;", "", js, flags=re.M)
    js = re.sub(r"^export ", "", js, flags=re.M)
    assert not re.search(r"^export", js, flags=re.M), "unhandled export in the wasm-bindgen glue"
    logo = base64.b64encode(open(os.path.join(HERE, "assets", "logo-mark-128.png"), "rb").read()).decode()
    html = html.replace('src="assets/logo-mark-128.png"', f'src="data:image/png;base64,{logo}"')
    html = inline_pictures(html)
    # the development fallback (loads ./pkg) is not needed in the single file
    html = re.sub(r'<script type="module">\n// development:.*?</script>\n', "", html, flags=re.S)
    html = inline_module(html, "finish-logic.js")
    html = inline_module(html, "send-list.js")
    html = inline_module(html, "screen-fit.js")
    html = inline_module(html, "sha-text.js")
    loader = f"""<script type="module">
{js}
const __wasmBytes = Uint8Array.from(atob("{wasm_b64}"), c => c.charCodeAt(0));
await __wbg_init({{ module_or_path: __wasmBytes }});
window.LensBolt = {{ WebSender, WebFiles, describe_code, bytes_per_second, suggest_word, check_finish_words, finish_context, describe_finish, finish_code }};
window.dispatchEvent(new Event("lensbolt-ready"));
</script>"""
    marker = '<script type="module" id="loader"></script>'
    assert marker in html, "index.html needs the loader placeholder"
    out = html.replace(marker, loader)
    os.makedirs(os.path.join(HERE, "dist"), exist_ok=True)
    path = os.path.join(HERE, "dist", "lensbolt.html")
    open(path, "w", encoding="utf-8", newline="\n").write(out)
    print(f"wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")
    build_receiver(open(os.path.join(HERE, "pkg", "lensbolt_web.js"), encoding="utf-8").read(), wasm_b64, logo)
    write_stamp()


SINGLE = ["lensbolt.html", "lensbolt-receive.html"]


def dist_inputs():
    """The files web/dist's pages are made from, relative to web/: this script, the two pages, the decode worker,
    the modules it inlines (read from its own inline_module calls), the wasm and its glue, the pictures."""
    src = open(os.path.abspath(__file__), encoding="utf-8").read()
    mods = sorted(set(re.findall(r'inline_module\(html, "([\w.-]+)"\)', src)))
    pics = sorted("assets/" + f for f in os.listdir(os.path.join(HERE, "assets")) if f.endswith(".webp"))
    return ["build.py", "index.html", "receive.html", "receive-worker.js", "pkg/lensbolt_web.js", "pkg/lensbolt_web_bg.wasm", "assets/logo-mark-128.png"] + mods + pics


def file_hash(path):
    """SHA-256 of a file, text with LF line ends (a checkout may turn LF into CRLF; the hash must not change)."""
    data = open(path, "rb").read()
    if not path.endswith((".wasm", ".png", ".webp")):
        data = data.replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def inputs_hash():
    h = hashlib.sha256()
    for name in dist_inputs():
        h.update(f"{name} {file_hash(os.path.join(HERE, name))}\n".encode())
    return h.hexdigest()


def stamp():
    return {"inputs": inputs_hash(), **{s: file_hash(os.path.join(HERE, "dist", s)) for s in SINGLE}}


def write_stamp():
    import json
    path = os.path.join(HERE, "dist", "stamp.json")
    open(path, "w", encoding="utf-8", newline="\n").write(json.dumps(stamp(), indent=2) + "\n")
    print(f"wrote {path}")


def inline_module(html, name):
    """A page's rules kept in a module of their own (for the node tests): its import line in the page becomes the
    module's code, exports dropped (the page's module script then uses the names directly)."""
    imp = re.search(r"^import \{[^}]*\} from './" + re.escape(name) + r"';\n", html, flags=re.M)
    assert imp, f"the page imports {name}"
    code = open(os.path.join(HERE, name), encoding="utf-8").read()
    code = re.sub(r"^export ", "", code, flags=re.M)
    assert not re.search(r"^\s*export\b", code, flags=re.M), f"unhandled export in {name}"
    return html[:imp.start()] + code + "\n" + html[imp.end():]


def inline_pictures(html):
    """The pages' pictures (web/assets/*.webp: the sender's hero, the receiver's three ways in, the empty list) as
    data URIs, so the single file shows them offline."""
    def data(m):
        raw = open(os.path.join(HERE, "assets", m.group(1)), "rb").read()
        return f'src="data:image/webp;base64,{base64.b64encode(raw).decode()}"'
    html = re.sub(r'src="assets/([\w.-]+\.webp)"', data, html)
    assert 'src="assets/' not in html, "a picture the single file does not inline"
    return html


def build_receiver(glue, wasm_b64, logo):
    """web/dist/lensbolt-receive.html: the receiver page with its decode worker, the wasm-bindgen glue and the
    wasm inlined. The worker is a module worker made from a Blob (glue + worker code in one module); the page
    hands it the wasm bytes. The camera still needs a secure context (https:// or localhost)."""
    html = open(os.path.join(HERE, "receive.html"), encoding="utf-8").read()
    worker = open(os.path.join(HERE, "receive-worker.js"), encoding="utf-8").read()
    imp = "import init, { WebReceiver, WebReader, WebSender, WebFiles } from './pkg/lensbolt_web.js';"
    assert imp in worker, "receive-worker.js import line changed"
    glue = re.sub(r"export\s*\{[^}]*\}\s*;?", "", glue)
    glue = re.sub(r"^export ", "", glue, flags=re.M)
    worker_src = glue + "\nconst init = __wbg_init;\n" + worker.replace(imp, "")
    html = html.replace('src="assets/logo-mark-128.png"', f'src="data:image/png;base64,{logo}"')
    html = inline_pictures(html)
    # the page's rules (guidance, zoom, focus, banner) are a module of their own for the node tests: inlined here
    html = inline_module(html, "receive-logic.js")
    html = inline_module(html, "batch-logic.js")
    html = inline_module(html, "receive-pool.js")
    html = inline_module(html, "sha-text.js")
    dev = re.search(r'<script type="module">\n// development:.*?</script>\n', html, flags=re.S)
    assert dev, "receive.html needs the development worker block"
    import json
    inline = f"""<script>
window.lensboltWasm = Uint8Array.from(atob("{wasm_b64}"), c => c.charCodeAt(0));
const __workerUrl = URL.createObjectURL(new Blob([{json.dumps(worker_src)}], {{ type: "text/javascript" }}));
window.lensboltWorker = () => new Worker(__workerUrl, {{ type: "module" }});
</script>
"""
    out = html[:dev.start()] + inline + html[dev.end():]
    path = os.path.join(HERE, "dist", "lensbolt-receive.html")
    open(path, "w", encoding="utf-8", newline="\n").write(out)
    print(f"wrote {path} ({os.path.getsize(path) / 1024:.0f} KB)")


if __name__ == "__main__":
    sys.exit(main())
