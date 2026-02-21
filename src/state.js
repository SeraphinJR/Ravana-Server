// ── The Ledger ──────────────────────────────────────────────
// Global in-memory state. No database, no persistence.
// Everything lives and dies with the process.

module.exports = {
  /** @type {Set<string>} Socket IDs of connected Master Dashboards */
  dashboardSocketIds: new Set(),

  /** @type {string[]} Pool of idle worker socket IDs ready to receive tiles */
  availableWorkers: [],

  /** @type {{ startX: number, startY: number, width: number, height: number, canvasWidth: number, canvasHeight: number, camera: object, sunDir: object, masterSocketId: string }[]} */
  taskQueue: [],

  /** @type {Map<string, object>} Maps workerId → the tile it's currently rendering */
  activeTasks: new Map(),

  /** @type {Map<string, Set<string>>} Maps workerId → Set of masterSocketIds it serves */
  workerMasterMap: new Map(),

  /**
   * Maps masterSocketId → geometry payload.
   * Each master's geocache is stored separately so workers and late-joiners
   * can receive the correct scene data for each master.
   * @type {Map<string, object>}
   */
  geocache: new Map(),
};
