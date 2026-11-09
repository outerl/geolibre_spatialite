# Third-party notices

The distributable includes SQLite compiled to WebAssembly through sql.js and JavaScript projection support from Proj4js. It does not include the C libspatialite or GEOS libraries.

Full dependency license texts are included under `licenses/` in the plugin ZIP:

- sql.js: MIT; SQLite core is in the public domain. https://github.com/sql-js/sql.js
- Proj4js: MIT. https://github.com/proj4js/proj4js
- mgrs: MIT. https://github.com/proj4js/mgrs
- wkt-parser: MIT. https://github.com/proj4js/wkt-parser

See `DEPENDENCIES.json` in the ZIP for the exact installed versions. The plugin source and build inputs are included under `source/`; install its pinned dependencies with `npm ci` and rebuild with `npm run build`.

The plugin's own code is licensed under LGPL-2.1-or-later; see LICENSE. Dependency licenses remain applicable to their respective code.
