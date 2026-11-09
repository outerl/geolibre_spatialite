import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import sqlWasmBase64 from "virtual:sql-wasm-base64";

import { registerSpatialFunctions } from "./spatial-functions.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function decodeInlineWasm(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function loadSqliteWasm(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({ wasmBinary: decodeInlineWasm(sqlWasmBase64) });
  return sqlJsPromise.catch((error: unknown) => {
    sqlJsPromise = null;
    throw error;
  });
}

/**
 * Initializes a SpatiaLite-enabled database from raw SQLite file bytes or creates a new empty one.
 */
export async function createSpatialiteDatabase(data?: Uint8Array | ArrayBuffer): Promise<Database> {
  const SQL = await loadSqliteWasm();
  // sql.js copies into its virtual filesystem. Do not make another full-size JS copy.
  const db = data ? new SQL.Database(data instanceof Uint8Array ? data : new Uint8Array(data)) : new SQL.Database();
  try {
    // Force header validation now, before replacing an existing connection in the UI.
    db.exec("PRAGMA schema_version");
    registerSpatialFunctions(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
