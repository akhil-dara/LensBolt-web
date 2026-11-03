"""Package the portable sender.

    python web/make_portable.py   -> web/dist/LensBolt-portable.zip

Contents: lensbolt.html (the whole sender, offline), LensBolt.cmd (opens it in app mode), send.ps1,
README.txt. Runs web/build.py first so the HTML is current.
"""
import os
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

README = """LensBolt portable sender
========================
Double-click LensBolt.cmd (or open lensbolt.html in Chrome or Edge).
Choose a file, press Start, and point the LensBolt phone app at the screen.
When the phone shows two words, press Esc, type them into the sender and start again.

Nothing is installed and nothing leaves this computer except light from the screen.
"""


def main():
    subprocess.run([sys.executable, os.path.join(HERE, "build.py")], check=True)
    out = os.path.join(HERE, "dist", "LensBolt-portable.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(HERE, "dist", "lensbolt.html"), "LensBolt/lensbolt.html")
        z.write(os.path.join(HERE, "portable", "LensBolt.cmd"), "LensBolt/LensBolt.cmd")
        z.write(os.path.join(HERE, "send.ps1"), "LensBolt/send.ps1")
        z.writestr("LensBolt/README.txt", README)
    print(f"wrote {out} ({os.path.getsize(out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
