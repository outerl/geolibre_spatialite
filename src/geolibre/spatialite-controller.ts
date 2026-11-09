import type { GeoLibreAppAPI } from "./host-api.js";
import { SpatialiteDatabase, type SqlRow } from "../spatialite/database.js";
import { addSpatialiteLayerToMap } from "./layer-manager.js";

export const PANEL_ID = "spatialite-explorer";
export const MENU_ID = "spatialite-menu";

export class SpatialiteController {
  private db: SpatialiteDatabase | null = null;
  private currentDbName = "";
  private container: HTMLElement | null = null;
  private lastQueryResult: SqlRow[] | null = null;
  private sqlText = "SELECT * FROM sqlite_master WHERE type='table';";
  private notice = "";
  private operation = 0;
  private disposed = false;
  private loadAbort: AbortController | null = null;
  private loadTask: Promise<void> | null = null;

  constructor(private readonly app: GeoLibreAppAPI) {}

  render(container: HTMLElement): () => void {
    this.container = container;
    this.updateUI();
    return () => {
      if (this.container === container) this.container = null;
    };
  }

  getDatabase(): SpatialiteDatabase | null {
    return this.db;
  }

  async openDatabaseFromBuffer(data: Uint8Array | ArrayBuffer, name = "database.sqlite"): Promise<void> {
    const operation = ++this.operation;
    this.loadAbort?.abort();
    await this.loadTask;
    const next = await SpatialiteDatabase.open(data);
    if (this.disposed || operation !== this.operation) { next.close(); return; }
    // Keep the working database if the replacement fails validation.
    this.db?.close();
    this.db = next;
    this.currentDbName = name;
    this.lastQueryResult = null;
    this.notice = "";
    this.updateUI();
    this.app.openRightPanel?.(PANEL_ID);
  }

  dispose(): void {
    this.disposed = true;
    this.operation++;
    this.loadAbort?.abort();
    const db = this.db;
    this.db = null;
    this.container = null;
    if (this.loadTask) void this.loadTask.finally(() => db?.close());
    else db?.close();
  }

  private showError(error: unknown): void {
    this.notice = error instanceof Error ? error.message : String(error);
    this.updateUI();
  }

  async promptOpenDatabase(): Promise<void> {
    if (typeof window !== "undefined" && "showOpenFilePicker" in window) {
      try {
        const picker = window.showOpenFilePicker as (options?: unknown) => Promise<FileSystemFileHandle[]>;
        const [handle] = await picker({
          types: [
            {
              description: "SQLite / SpatiaLite Database (*.sqlite, *.db, *.spatialite)",
              accept: {
                "application/x-sqlite3": [".sqlite", ".db", ".spatialite", ".sqlite3"],
              },
            },
          ],
          multiple: false,
        });

        if (handle) {
          const file = await handle.getFile();
          const buffer = await file.arrayBuffer();
          await this.openDatabaseFromBuffer(buffer, file.name);
          return;
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
        this.showError(err);
        return;
      }
    }

    // Fallback: file input
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sqlite,.db,.spatialite,.sqlite3";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) {
        void file.arrayBuffer().then((buffer) => this.openDatabaseFromBuffer(buffer, file.name)).catch((error: unknown) => { this.showError(error); });
      }
    };
    input.click();
  }

  private updateUI(): void {
    if (!this.container) return;
    this.container.innerHTML = "";

    const panel = document.createElement("div");
    panel.className = "spatialite-panel";

    // Header
    const header = document.createElement("div");
    header.className = "spatialite-header";
    header.innerHTML = `
      <h3 class="spatialite-title">SpatiaLite</h3>
      <p class="spatialite-subtitle">Spatial SQL Database Engine</p>
    `;
    panel.appendChild(header);

    // Database Status & Open Action
    const dbSection = document.createElement("div");
    dbSection.className = "spatialite-section";

    const openBtn = document.createElement("button");
    openBtn.className = "spatialite-btn spatialite-btn-primary";
    openBtn.textContent = this.db ? "Open Another Database…" : "Open SQLite / SpatiaLite Database…";
    openBtn.onclick = () => {
      void this.promptOpenDatabase();
    };
    dbSection.appendChild(openBtn);

    if (this.db) {
      const statusAlert = document.createElement("div");
      statusAlert.className = "spatialite-alert spatialite-alert-info";
      statusAlert.textContent = `Connected: ${this.currentDbName}`;
      dbSection.appendChild(statusAlert);
    }
    panel.appendChild(dbSection);

    if (this.notice) {
      const notice = document.createElement("div");
      notice.className = "spatialite-alert spatialite-alert-info";
      notice.setAttribute("role", "status");
      notice.textContent = this.notice;
      panel.appendChild(notice);
    }
    if (this.loadAbort) {
      const cancel = document.createElement("button");
      cancel.className = "spatialite-btn";
      cancel.textContent = "Cancel loading";
      cancel.onclick = () => this.loadAbort?.abort();
      panel.appendChild(cancel);
    }

    if (this.db) {
      // Tables Section
      const tableSection = document.createElement("div");
      tableSection.className = "spatialite-section";
      tableSection.innerHTML = `<h4 class="spatialite-section-title">Spatial Layers & Tables</h4>`;

      const geomCols = this.db.getGeometryColumns();
      const allTables = this.db.getTableNames();

      const tableList = document.createElement("div");
      tableList.className = "spatialite-table-list";

      for (const table of allTables) {
        const geomInfo = geomCols.find((g) => g.tableName === table);
        const item = document.createElement("div");
        item.className = "spatialite-table-item";

        const nameSpan = document.createElement("span");
        nameSpan.className = "spatialite-table-name";
        nameSpan.textContent = table;
        item.appendChild(nameSpan);

        if (geomInfo) {
          const badge = document.createElement("span");
          badge.className = "spatialite-table-badge";
          badge.textContent = `${geomInfo.type} (${geomInfo.srid})`;
          item.appendChild(badge);

          const addBtn = document.createElement("button");
          addBtn.className = "spatialite-btn";
          addBtn.style.padding = "2px 8px";
          addBtn.style.fontSize = "11px";
          addBtn.textContent = "Add to Map";
          addBtn.onclick = () => {
            this.loadTask = this.loadTableToMap(table, geomInfo.columnName);
          };
          item.appendChild(addBtn);
        }

        tableList.appendChild(item);
      }
      tableSection.appendChild(tableList);
      panel.appendChild(tableSection);

      // SQL Query Console
      const sqlSection = document.createElement("div");
      sqlSection.className = "spatialite-section";
      sqlSection.innerHTML = `<h4 class="spatialite-section-title">Spatial SQL Console</h4>`;

      const textarea = document.createElement("textarea");
      textarea.className = "spatialite-sql-editor";
      textarea.placeholder = "SELECT * FROM links LIMIT 10;";
      textarea.value = this.sqlText;
      textarea.setAttribute("aria-label", "SQL query");
      textarea.oninput = () => { this.sqlText = textarea.value; };
      sqlSection.appendChild(textarea);

      const btnRow = document.createElement("div");
      btnRow.style.display = "flex";
      btnRow.style.gap = "8px";

      const runBtn = document.createElement("button");
      runBtn.className = "spatialite-btn spatialite-btn-primary";
      runBtn.textContent = "Run SQL";
      runBtn.onclick = () => {
        this.runQuery(textarea.value);
      };
      btnRow.appendChild(runBtn);

      const exportBtn = document.createElement("button");
      exportBtn.className = "spatialite-btn";
      exportBtn.textContent = "Export DB File";
      exportBtn.onclick = () => {
        this.exportDatabase();
      };
      btnRow.appendChild(exportBtn);

      sqlSection.appendChild(btnRow);

      const resultsDiv = document.createElement("div");
      resultsDiv.id = "spatialite-query-results";
      if (this.lastQueryResult) this.renderQueryResults(resultsDiv, this.lastQueryResult);
      sqlSection.appendChild(resultsDiv);

      panel.appendChild(sqlSection);
    }

    this.container.appendChild(panel);
  }

  private async loadTableToMap(tableName: string, geomCol: string): Promise<void> {
    if (!this.db || this.loadAbort) return;
    const db = this.db;
    const abort = new AbortController();
    this.loadAbort = abort;
    this.notice = `Loading ${tableName}…`;
    this.updateUI();
    try {
      const geojson = await db.getTableGeoJsonAsync(tableName, geomCol, undefined, {
        signal: abort.signal,
        onProgress: (count) => {
          const status = this.container?.querySelector('[role="status"]');
          if (status) status.textContent = `Loading ${tableName}: ${count.toLocaleString()} features…`;
        },
      });
      if (abort.signal.aborted || this.disposed) return;
      addSpatialiteLayerToMap(this.app, `${this.currentDbName} — ${tableName}`, geojson);
      this.notice = `Added ${geojson.features.length.toLocaleString()} features from ${tableName}.`;
    } catch (err: unknown) {
      this.notice = abort.signal.aborted ? "Loading cancelled." : `Failed to load table: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.loadAbort = null;
      this.loadTask = null;
      this.updateUI();
    }
  }

  private runQuery(sql: string): void {
    if (!this.db) return;
    const container = this.container?.querySelector<HTMLElement>("#spatialite-query-results");
    if (!container) return;
    container.innerHTML = "";

    try {
      this.sqlText = sql;
      const rows = this.db.executePreview(sql);
      if (rows) {
        this.lastQueryResult = rows;
        this.renderQueryResults(container, rows);
      } else {
        this.lastQueryResult = null;
        this.notice = "Statement executed successfully.";
        this.updateUI();
      }
    } catch (err: unknown) {
      const message = document.createElement("div");
      message.className = "spatialite-alert spatialite-alert-error";
      message.textContent = err instanceof Error ? err.message : String(err);
      container.appendChild(message);
    }
  }

  private renderQueryResults(container: HTMLElement, rows: SqlRow[]): void {
    if (rows.length === 0) {
      container.innerHTML = `<div class="spatialite-alert spatialite-alert-info">0 rows returned.</div>`;
      return;
    }

    const firstRow = rows[0];
    if (!firstRow) return;
    const cols = Object.keys(firstRow);

    const wrapper = document.createElement("div");
    wrapper.className = "spatialite-results-container";

    const table = document.createElement("table");
    table.className = "spatialite-results-table";

    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    for (const col of cols) {
      const th = document.createElement("th");
      th.textContent = col;
      trHead.appendChild(th);
    }
    thead.appendChild(trHead);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const displayRows = rows.slice(0, 100);
    for (const row of displayRows) {
      const tr = document.createElement("tr");
      for (const col of cols) {
        const td = document.createElement("td");
        const val = row[col];
        if (val instanceof Uint8Array) {
          td.textContent = `[BLOB ${val.length}B]`;
        } else {
          td.textContent = String(val ?? "");
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);

    container.appendChild(wrapper);
    if (rows.length > 100) {
      const more = document.createElement("p");
      more.textContent = "Showing the first 100 rows. Use LIMIT and WHERE to narrow the query.";
      container.appendChild(more);
    }
  }

  private exportDatabase(): void {
    if (!this.db) return;
    try {
    const bytes = this.db.export();
    const blob = new Blob([new Uint8Array(bytes)], { type: "application/x-sqlite3" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = this.currentDbName || "database.sqlite";
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); }, 0);
    } catch (error) { this.showError(error); }
  }
}
