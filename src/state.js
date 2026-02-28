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
   * Maps masterSocketId → geometry payload with extended rendering properties.
   * Each master's geocache is stored separately so workers and late-joiners
   * can receive the correct scene data for each master.
   *
   * Payload structure:
   *   - camera: { position, rotation, target, fov, near, far } | null
   *   - geometry: { meshCount, totalVertices, totalIndices, meshes[] }
   *       Each mesh includes: positions, normals, uvs, indices, ao, vertexColors, bvh
   *       Plus flags: hasNormals, hasUvs, hasBakedData, hasBvhData
   *   - emission: { strength, texture, useEmission } | null (per-mesh emissive data)
   *   - diffuse: { bsdf, albedo, roughness, metallic } | null (BSDF parameters)
   *   - lighting: { ambientIntensity, shadowsEnabled, globalIllumination } (scene lighting config)
   *   - shading: { shadingModel, normalMaps, parallaxMapping } (shading techniques)
   *
   * @type {Map<string, object>}
   */
  geocache: new Map(),
};
