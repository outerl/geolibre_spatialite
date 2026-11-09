// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import type { Database } from "sql.js";

export function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const versions = new WeakMap<Database, number>();

/**
 * Optional exact-BLOB endpoint lookup compatibility for synthetic network schemas.
 * This is NOT SpatiaLite's bounding-box SpatialIndex virtual table. Never shadow a
 * real SpatialIndex, modify the source schema, or silently claim index support.
 */
export function ensureSpatialIndexView(db: Database): void {
  const version = Number(db.exec("PRAGMA main.schema_version")[0]?.values[0]?.[0]);
  if (versions.get(db) === version) return;
  const existing = db.exec("SELECT 1 FROM main.sqlite_master WHERE lower(name) = 'spatialindex'");
  if (existing.length > 0) {
    versions.set(db, version);
    return;
  }
  const tables = db.exec(`
    SELECT m.name, p.name FROM main.sqlite_master AS m
    JOIN pragma_table_info(m.name) AS p
    WHERE m.type = 'table' AND m.sql NOT LIKE 'CREATE VIRTUAL TABLE%'
      AND lower(p.name) = 'geometry'
  `)[0]?.values ?? [];
  const selects = tables.map(([table, column]) => {
    if (typeof table !== "string" || typeof column !== "string") throw new Error("Invalid spatial table metadata.");
    return `SELECT ROWID, '${table.replace(/'/g, "''")}' AS f_table_name,
      '${column.replace(/'/g, "''")}' AS f_geometry_column, ${quoteIdentifier(column)} AS search_frame
      FROM main.${quoteIdentifier(table)}`;
  });
  db.run("DROP VIEW IF EXISTS temp.SpatialIndex");
  db.run(`CREATE TEMP VIEW SpatialIndex AS ${selects.join(" UNION ALL ") ||
    "SELECT NULL AS ROWID, NULL AS f_table_name, NULL AS f_geometry_column, NULL AS search_frame WHERE 0"}`);
  versions.set(db, version);
}
