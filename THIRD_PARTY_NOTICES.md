# Third-Party Notices and Upstream Licensing Information

This document details the copyright notices, licenses, and legal terms governing third-party libraries, algorithms, and upstream projects integrated into, referenced by, or distributed with **GeoLibre SpatiaLite Engine** (`geolibre-spatialite`).

---

## 1. Primary License & Architecture Policy

**GeoLibre SpatiaLite Engine** is developed by **Outer Loop Consulting** and released under the **GNU Lesser General Public License, Version 2.1 or later** (`LGPL-2.1-or-later`). See the [LICENSE](LICENSE) file for the full text of the LGPL 2.1.

### 1.1 Upstream Tri-License Election
Upstream **SpatiaLite** (`libspatialite`) is tri-licensed under:
- The **Mozilla Public License (MPL)**, Version 1.1 or later,
- The **GNU General Public License (GPL)**, Version 2.0 or later, or
- The **GNU Lesser General Public License (LGPL)**, Version 2.1 or later.

Under this tri-license structure, **Outer Loop Consulting** explicitly elects the **GNU Lesser General Public License (LGPL), Version 2.1 or later** for `geolibre-spatialite`.

### 1.2 Isolation from GPL Copyleft (`librttopo` Exclusion Policy)
Upstream `libspatialite` includes optional integrations with `librttopo` (the RTTopology library derived from PostGIS). `librttopo` is strictly licensed under **GPL-2.0-or-later** (without Lesser GPL exceptions). 

To prevent viral copyleft from forcing GPL terms onto the entire compiled binary and compromising compatibility with permissive consumer plugins:
- **`geolibre-spatialite` strictly excludes `librttopo`** (configured via `--disable-rttopo` in all C/WASM build scripts and CI pipelines).
- No GPL-only code is incorporated into the distribution.
- This ensures the distributed engine remains cleanly under **LGPL-2.1-or-later**.

### 1.3 Consumer Plugins & LGPL 2.1 Section 5/6 Compliance
Under Section 5 and Section 6 of the GNU Lesser General Public License v2.1:
- A separate application or plugin (such as the **AequilibraE** GeoLibre plugin, which is licensed under the permissive **MIT License**) that communicates with `geolibre-spatialite` via documented public interfaces (`window.geolibreSpatialite` or GeoLibre's service registry `app.getService('spatialite')`) constitutes a **"work that uses the Library"**.
- Such consumer plugins **remain independent works** and may be licensed under terms of their authors' choice (including the MIT License or commercial terms).
- Users receive the complete source code of `geolibre-spatialite` within every distributed plugin ZIP under `source/`, allowing them to modify, recompile, and relink `geolibre-spatialite` at will using `npm ci && npm run build`.

---

## 2. Upstream SpatiaLite (`libspatialite`)

- **Author**: Alessandro Furieri (`a.furieri@lqt.it`) and contributors
- **Project URL**: [https://www.gaia-gis.it/fossil/libspatialite/index](https://www.gaia-gis.it/fossil/libspatialite/index)
- **License**: Tri-licensed (MPL 1.1 / GPL 2.0+ / LGPL 2.1+)
- **Elected License**: GNU Lesser General Public License (LGPL) v2.1 or later

### Upstream Notice
```text
Copyright (c) 2008-2024 Alessandro Furieri

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

Alternatively, you may distribute and/or modify this software under the
terms of any of the following licenses:

- the GNU General Public License as published by the Free Software Foundation;
  either version 2 of the License, or (at your option) any later version.
- the GNU Lesser General Public License as published by the Free Software
  Foundation; either version 2.1 of the License, or (at your option) any
  later version.
- the Mozilla Public License Version 1.1; either version 1.1 of the License,
  or (at your option) any later version.
```

---

## 3. SQLite Database Engine

- **Authors**: D. Richard Hipp and SQLite contributors
- **Project URL**: [https://www.sqlite.org](https://www.sqlite.org)
- **License**: Dedicated to the Public Domain

### SQLite Public Domain Dedication
```text
2001 September 15

The author disclaims copyright to this source code. In place of
a legal notice, here is a blessing:

   May you do good and not evil.
   May you find forgiveness for yourself and forgive others.
   May you share freely, never taking more than you give.
```

---

## 4. sql.js (SQLite WebAssembly)

- **Authors**: Alon Zakai and sql.js contributors
- **Project URL**: [https://github.com/sql-js/sql.js](https://github.com/sql-js/sql.js)
- **License**: MIT License

### MIT License Text
```text
Copyright (c) 2017 sql.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 5. Proj4js, mgrs, and wkt-parser (Projection & Coordinate Systems)

- **Authors**: Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral, Calvin Metcalf
- **Project URLs**:
  - Proj4js: [https://github.com/proj4js/proj4js](https://github.com/proj4js/proj4js)
  - mgrs: [https://github.com/proj4js/mgrs](https://github.com/proj4js/mgrs)
  - wkt-parser: [https://github.com/proj4js/wkt-parser](https://github.com/proj4js/wkt-parser)
- **License**: MIT License

### MIT License Text
```text
Copyright (c) 2014, Mike Adair, Richard Greenwood, Didier Richard, Stephen Irons, Olivier Terral and Calvin Metcalf

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

---

## 6. GEOS (Geometry Engine Open Source)

- **Authors**: Open Source Geospatial Foundation (OSGeo), Sandro Santilli, Martin Davis (JTS)
- **Project URL**: [https://libgeos.org](https://libgeos.org)
- **License**: GNU Lesser General Public License (LGPL), Version 2.1
- **Role**: Upstream geometric computational engine used by C `libspatialite` builds.

---

## 7. PROJ (Cartographic Projections and Coordinate Transformations)

- **Authors**: Frank Warmerdam, OSGeo, and PROJ contributors
- **Project URL**: [https://proj.org](https://proj.org)
- **License**: MIT / X11 Style Open Source License
- **Role**: Upstream geodetic transformation engine used by C `libspatialite` builds.

```text
Copyright (c) 2000, Frank Warmerdam
Copyright (c) 2018-2024, OSGeo

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

---

## 8. Geodesic Algorithms

The geodesic calculations implemented in `src/spatialite/geodesic.ts` (Vincenty's inverse and direct formulae on the WGS 84 reference ellipsoid) are based on public-domain mathematical formulations published by Thaddeus Vincenty (1975):
* *Vincenty, T. (1975). "Direct and Inverse Solutions of Geodesics on the Ellipsoid with Application of Nested Equations", Survey Review, XXIII (176): 88–93.*

---

## 9. Dependency Tracking

Full dependency license files are bundled into every released plugin package under `licenses/`:
- `licenses/sql.js.txt`
- `licenses/proj4.txt`
- `licenses/mgrs.txt`
- `licenses/wkt-parser.txt`

The exact installed package versions are captured in `DEPENDENCIES.json` inside the distribution artifact. Source code is bundled under `source/` in accordance with LGPL 2.1 Section 6.
