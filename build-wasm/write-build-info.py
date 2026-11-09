# SPDX-License-Identifier: LGPL-2.1-or-later
import hashlib
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
files = sorted(p for p in root.rglob('*') if p.is_file())
manifest = {
    'format': 1,
    'engine': 'native-c-wasm',
    'singleFile': True,
    'wasmBigInt': True,
    'capabilities': {'workerFS': True, 'sqliteOpenV2': True},
    'components': {'emscripten': '3.1.64', 'sqlite': '3.46.1', 'spatialite': os.environ['SPATIALITE_VER'],
                   'geos': os.environ['GEOS_VER'], 'proj': os.environ['PROJ_VER'], 'zlib': os.environ['ZLIB_VER']},
    'files': {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
}
(root / 'build-info.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
