// SPDX-License-Identifier: LGPL-2.1-or-later
// Copyright (c) 2026 Outer Loop Consulting

import nativeFactory from "virtual:spatialite-native";
import { NativeCReadOnlyDatabase, type PagedCursorBatch, type PagedFileStats } from "./readonly-worker-database.js";
import type { SpatialiteWasmModule, SqlValue } from "./c-wasm-adapter.js";

type WorkerRequest =
  | { id: number; type: "open"; blob: Blob; cacheMiB: number }
  | { id: number; type: "query"; sql: string; params: SqlValue[]; maxRows: number; maxBytes: number }
  | { id: number; type: "cursor-start"; sql: string; params: SqlValue[] }
  | { id: number; type: "cursor-next"; cursorId: number; batchSize: number; maxBytes: number }
  | { id: number; type: "cursor-more"; cursorId: number }
  | { id: number; type: "cursor-close"; cursorId: number }
  | { id: number; type: "stats" }
  | { id: number; type: "close" };

type WorkerResponse = {
  id: number;
  ok: true;
  value?: unknown;
} | {
  id: number;
  ok: false;
  error: string;
};

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
let database: NativeCReadOnlyDatabase | null = null;
let restoreBlobMeter: (() => void) | null = null;

function respond(id: number, value?: unknown): void {
  scope.postMessage({ id, ok: true, value });
}

function fail(id: number, cause: unknown): void {
  scope.postMessage({ id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
}

function installReadMeter(blob: Blob): { stats: PagedFileStats; restore: () => void } {
  const measured: PagedFileStats = {
    fileSize: blob.size, sliceBytesRequested: 0, sliceRequestCount: 0, cacheBytes: 0,
    nativeFactoryMs: 0, sqliteMountOpenMs: 0, openElapsedMs: 0,
  };
  const original = blob.slice.bind(blob);
  const meter = (start?: number, end?: number, contentType?: string): Blob => {
    const size = blob.size;
    const from = start === undefined ? 0 : Math.max(0, start < 0 ? size + Math.trunc(start) : Math.trunc(start));
    const to = end === undefined ? size : Math.max(from, Math.min(size, end < 0 ? size + Math.trunc(end) : Math.trunc(end)));
    measured.sliceBytesRequested += Math.max(0, to - from);
    measured.sliceRequestCount += 1;
    return original(start, end, contentType);
  };
  Object.defineProperty(blob, "slice", { value: meter, configurable: true });
  return {
    stats: measured,
    restore: () => { if (blob.slice === meter) Reflect.deleteProperty(blob, "slice"); },
  };
}

async function openDatabase(request: Extract<WorkerRequest, { type: "open" }>): Promise<void> {
  const factory: (() => Promise<SpatialiteWasmModule>) | null = nativeFactory;
  if (factory === null) throw new Error("Native SpatiaLite is unavailable; paged file reads require the compiled native runtime.");
  if (!(request.blob instanceof Blob)) throw new Error("openFile expects a Blob or File.");
  const meter = installReadMeter(request.blob);
  restoreBlobMeter = meter.restore;
  const measured = meter.stats;
  const startupStarted = performance.now();
  const mod: SpatialiteWasmModule = await factory();
  measured.nativeFactoryMs = performance.now() - startupStarted;
  const openStarted = performance.now();
  database = await NativeCReadOnlyDatabase.open(mod, request.blob, request.cacheMiB, measured);
  measured.sqliteMountOpenMs = performance.now() - openStarted;
  respond(request.id, { stats: database.stats });
}

function executeBounded(request: Extract<WorkerRequest, { type: "query" }>): { columns: string[]; rows: Record<string, SqlValue>[]; truncated: boolean } {
  if (!database) throw new Error("Paged database is not open.");
  const cursor = database.startQuery(request.sql, request.params);
  const rows: Record<string, SqlValue>[] = [];
  try {
    let bytes = 0;
    while (rows.length < request.maxRows && bytes < request.maxBytes) {
      const batch: PagedCursorBatch = database.readBatch(
        cursor.cursorId,
        Math.min(512, request.maxRows - rows.length),
        request.maxBytes - bytes,
      );
      rows.push(...batch.rows);
      bytes += batch.bytes;
      if (batch.done) return { columns: cursor.columns, rows, truncated: false };
    }
    const hasMore = database.hasMore(cursor.cursorId);
    return { columns: cursor.columns, rows, truncated: hasMore };
  } finally {
    database.closeCursor(cursor.cursorId);
  }
}

scope.onmessage = (event): void => {
  const request = event.data;
  const dispatch = async (): Promise<void> => {
    try {
      switch (request.type) {
        case "open":
          await openDatabase(request);
          return;
        case "query":
          respond(request.id, executeBounded(request));
          return;
        case "cursor-start": {
          if (!database) throw new Error("Paged database is not open.");
          respond(request.id, database.startQuery(request.sql, request.params));
          return;
        }
        case "cursor-next":
          if (!database) throw new Error("Paged database is not open.");
          respond(request.id, database.readBatch(request.cursorId, request.batchSize, request.maxBytes));
          return;
        case "cursor-more":
          if (!database) throw new Error("Paged database is not open.");
          respond(request.id, database.hasMore(request.cursorId));
          return;
        case "cursor-close":
          if (!database) throw new Error("Paged database is not open.");
          database.closeCursor(request.cursorId);
          respond(request.id);
          return;
        case "stats":
          if (!database) throw new Error("Paged database is not open.");
          respond(request.id, { ...database.stats });
          return;
        case "close":
          database?.close();
          database = null;
          restoreBlobMeter?.();
          restoreBlobMeter = null;
          respond(request.id);
          scope.close();
          return;
      }
    } catch (cause) {
      if (request.type === "open") {
        try { database?.close(); } catch { /* Preserve the opening error. */ }
        database = null;
        restoreBlobMeter?.();
        restoreBlobMeter = null;
      }
      fail(request.id, cause);
    }
  };
  void dispatch();
};
