// SPDX-License-Identifier: LGPL-2.1-or-later
import { describe, expect, it } from "vitest";

import { PagedSpatialiteConnection } from "../src/spatialite/paged-connection.js";

class ProtocolWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly requests: string[] = [];
  terminated = false;
  failedOpen = false;
  private nextCursor = 1;
  private cursors = new Map<number, number>();

  postMessage(message: { id: number; type: string; [key: string]: unknown }): void {
    this.requests.push(message.type);
    queueMicrotask(() => {
      if (message.type === "open" && this.failedOpen) {
        this.emit({ id: message.id, ok: false, error: "synthetic open failure" });
        return;
      }
      let value: unknown;
      switch (message.type) {
        case "open": value = { stats: {} }; break;
        case "query": value = { columns: ["id"], rows: [{ id: 1 }], truncated: false }; break;
        case "cursor-start": {
          const cursorId = this.nextCursor++;
          this.cursors.set(cursorId, 0);
          value = { cursorId, columns: ["id"] };
          break;
        }
        case "cursor-next": {
          const cursorId = message.cursorId as number;
          const offset = this.cursors.get(cursorId) ?? 0;
          const batchSize = message.batchSize as number;
          const rowCount = Math.min(batchSize, 3 - offset);
          const rows = Array.from({ length: rowCount }, (_, index) => ({ id: offset + index + 1 }));
          this.cursors.set(cursorId, offset + rowCount);
          value = { columns: ["id"], rows, bytes: rowCount * 8, done: offset + rowCount >= 3 };
          break;
        }
        case "cursor-more": value = (this.cursors.get(message.cursorId as number) ?? 3) < 3; break;
        case "cursor-close": this.cursors.delete(message.cursorId as number); break;
        case "stats": value = { fileSize: 1000, sliceBytesRequested: 128, sliceRequestCount: 2, cacheBytes: 1024 }; break;
        case "close": this.cursors.clear(); break;
      }
      this.emit({ id: message.id, ok: true, value });
    });
  }

  private emit(response: WorkerResponse): void {
    this.onmessage?.(new MessageEvent<WorkerResponse>("message", { data: response }));
  }

  terminate(): void { this.terminated = true; }
}

interface WorkerResponse { id: number; ok: boolean; value?: unknown; error?: string }

describe("paged connection worker protocol", () => {
  it("pulls bounded batches, closes an early cursor, and keeps the read-only connection alive", async () => {
    const worker = new ProtocolWorker();
    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    const rows = connection.streamQuery<{ id: number }>("SELECT id FROM places", [], { batchSize: 1 });
    expect(worker.requests).toEqual(["open"]);
    expect((await rows.next()).value).toEqual([{ id: 1 }]);
    expect(worker.requests.filter((type) => type === "cursor-next")).toHaveLength(1);
    await rows.return?.();
    expect(worker.requests).toContain("cursor-close");
    expect(await connection.query("SELECT id FROM places")).toEqual([{ id: 1 }]);
    await connection.close();
    expect(worker.terminated).toBe(true);
  });

  it("hard-cancels the worker and rejects subsequent and pending requests", async () => {
    const worker = new ProtocolWorker();
    const connection = await PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => worker);
    const controller = new AbortController();
    const iterator = connection.streamQuery("SELECT id FROM places", [], { batchSize: 1, signal: controller.signal });
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toThrow("aborted");
    expect(worker.terminated).toBe(true);
    await expect(connection.query("SELECT 1")).rejects.toThrow("aborted");
  });

  it("cleans up a worker when opening fails or is aborted during worker creation", async () => {
    const failedWorker = new ProtocolWorker();
    failedWorker.failedOpen = true;
    await expect(PagedSpatialiteConnection.open(new Blob(["database"]), {}, () => failedWorker)).rejects.toThrow("synthetic open failure");
    expect(failedWorker.terminated).toBe(true);

    const controller = new AbortController();
    const abortedWorker = new ProtocolWorker();
    const opening = PagedSpatialiteConnection.open(new Blob(["database"]), { signal: controller.signal }, async () => {
      await Promise.resolve();
      return abortedWorker;
    });
    controller.abort();
    await expect(opening).rejects.toThrow("aborted");
    expect(abortedWorker.terminated).toBe(true);
  });
});
