// ── The Ledger ──────────────────────────────────────────────
// Global in-memory state. No database, no persistence.
// Everything lives and dies with the process.

module.exports = {
  /** @type {string|null} Socket ID of the connected Master Dashboard */
  dashboardSocketId: null,

  /** @type {string[]} Pool of idle worker socket IDs ready to receive tiles */
  availableWorkers: [],

  /** @type {{ startX: number, startY: number, width: number, height: number, canvasWidth: number, canvasHeight: number, camera: object, sunDir: object }[]} */
  taskQueue: [],

  /** @type {Map<string, object>} Maps workerId → the tile it's currently rendering */
  activeTasks: new Map(),
};
