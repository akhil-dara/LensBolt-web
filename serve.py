"""Development server for web/: like `python -m http.server`, but every response forbids caching.

A browser that heuristically caches a module worker keeps running an old receive-worker.js next to a new page; the
page's new messages then go unanswered and the receiver freezes (seen on a phone, 2026-10-30). The single-file
builds in web/dist inline the worker and are not affected.

    python web/serve.py [port]        (default 8765, bound to 127.0.0.1; `adb reverse tcp:8765 tcp:8765` for a phone)
"""
import functools
import http.server
import os
import sys


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoStoreHandler, directory=os.path.dirname(os.path.abspath(__file__)))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving web/ on http://localhost:{port} (no-store)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
