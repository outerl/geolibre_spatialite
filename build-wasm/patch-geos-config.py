#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-or-later
# Copyright (c) 2026 Outer Loop Consulting
"""Patch geos-config for static WebAssembly linking with Emscripten.

GEOS installs geos-config with --ldflags and --clibs returning only -L${libdir} or
-L${libdir} -lgeos_c. For static WebAssembly builds, libgeos_c.a requires libgeos.a
and the C++ standard library runtime (-lc++ -lc++abi -lm). Without these dependencies,
Autoconf checks (like SpatiaLite's AC_SEARCH_LIBS for GEOSCoveredBy) fail during
compilation because SpatiaLite replaces LIBS with the output of geos-config --ldflags.
"""
from pathlib import Path
import sys

def main() -> None:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/wasm/bin/geos-config")
    if not target.is_file():
        raise SystemExit(f"geos-config not found at {target}")

    text = target.read_text(encoding="utf-8")
    # Replace the --ldflags output
    text = text.replace(
        "echo -L${libdir}\n",
        "echo -L${libdir} -lgeos -lc++ -lc++abi -lm\n",
    )
    # Replace the --clibs output
    text = text.replace(
        "echo -L${libdir} -lgeos_c\n",
        "echo -L${libdir} -lgeos_c -lgeos -lc++ -lc++abi -lm\n",
    )
    target.write_text(text, encoding="utf-8")
    print(f"Successfully patched {target} with static GEOS linker dependencies.")

if __name__ == "__main__":
    main()
