// ── The Traffic Cop ─────────────────────────────────────────
// Routes data between the Master Dashboard and Mobile Workers.
// The dashboard is ALSO a worker — every device renders tiles.
// Does zero math — just moves bytes around as fast as possible.

const state = require('./state');
const { processQueue } = require('./queue');

const TILE_SIZE = 64; // pixels per chunk edge

/**
 * Wire up every Socket.io event the system cares about.
 * @param {import('socket.io').Server} io
 */
function setupSockets(io) {
  io.on('connection', (socket) => {
    console.log(`[+] connected: ${socket.id}`);

    // ── Dashboard Registration (also joins the worker pool) ─
    socket.on('register_dashboard', () => {
      state.dashboardSocketId = socket.id;
      state.availableWorkers.push(socket.id);
      console.log(`[dashboard+worker] registered: ${socket.id}  (pool: ${state.availableWorkers.length})`);
      processQueue(io);
    });

    // ── Worker Registration ─────────────────────────────────
    socket.on('register_worker', () => {
      state.availableWorkers.push(socket.id);
      console.log(`[worker] registered: ${socket.id}  (pool: ${state.availableWorkers.length})`);
      processQueue(io);
    });

    // ── Scene Sync (ScenePayload broadcast) ────────────────
    // Dashboard sends { json: ScenePayload, buffer: ArrayBuffer }
    //
    // ScenePayload.camera:  { position, rotation, target, fov, near, far } | null
    // ScenePayload.geometry: { meshCount, totalVertices, totalIndices, meshes[] }
    //   Each mesh has byte offsets into the binary buffer:
    //     positions, normals, uvs, indices, ao, vertexColors, bvh
    //   Plus flags: hasNormals, hasUvs, hasBakedData, hasBvhData
    //
    // Server does NOT parse any of this — just relays it verbatim.
    socket.on('sync_geometry', (payload) => {
      const meshCount = payload?.geometry?.meshCount ?? '?';
      const totalVerts = payload?.geometry?.totalVertices ?? '?';
      console.log(`[geometry] broadcasting scene (${meshCount} meshes, ${totalVerts} verts) to all workers`);
      socket.broadcast.emit('sync_geometry', payload);
    });

    // ── Kick Off a Render ───────────────────────────────────
    // Camera comes from the ScenePayload already synced, but the
    // dashboard can override it here. sunDir is a lighting hint.
    socket.on('start_render', ({ canvasWidth, canvasHeight, camera, sunDir }) => {
      console.log(`[render] start ${canvasWidth}x${canvasHeight}`);

      // Slice the canvas into a grid of TILE_SIZE × TILE_SIZE chunks
      // Each tile carries the full context a worker's Web Worker needs
      // (scene geometry is already on each device via sync_geometry)
      for (let y = 0; y < canvasHeight; y += TILE_SIZE) {
        for (let x = 0; x < canvasWidth; x += TILE_SIZE) {
          state.taskQueue.push({
            startX: x,
            startY: y,
            width: Math.min(TILE_SIZE, canvasWidth - x),
            height: Math.min(TILE_SIZE, canvasHeight - y),
            canvasWidth,
            canvasHeight,
            camera,
            sunDir,
          });
        }
      }

      console.log(`[render] queued ${state.taskQueue.length} tiles`);
      processQueue(io);
    });

    // ── Worker Finished a Tile ──────────────────────────────
    socket.on('tile_finished', (payload) => {
      // This worker delivered — clear its in-flight record
      state.activeTasks.delete(socket.id);

      // Forward the rendered pixels straight to the dashboard
      if (state.dashboardSocketId) {
        io.to(state.dashboardSocketId).emit('render_update', payload);
      }

      // Return the worker to the pool and keep draining
      state.availableWorkers.push(socket.id);
      processQueue(io);
    });

    // ── Disconnect Cleanup ──────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.error(`[-] disconnected: ${socket.id}  reason: ${reason}`);

      const wasDashboard = socket.id === state.dashboardSocketId;
      const wasWorker = state.availableWorkers.includes(socket.id);

      if (wasDashboard) {
        state.dashboardSocketId = null;
        console.error('[dashboard] unregistered — master lost!');
      }

      // Remove ALL occurrences from worker pool (handles dashboard dual-role)
      let idx;
      while ((idx = state.availableWorkers.indexOf(socket.id)) !== -1) {
        state.availableWorkers.splice(idx, 1);
      }

      // ── Rescue orphaned tile ──────────────────────────────
      // If this worker was mid-render, push the tile back to the
      // FRONT of the queue so it gets picked up next.
      const orphanedTask = state.activeTasks.get(socket.id);
      if (orphanedTask) {
        state.activeTasks.delete(socket.id);
        state.taskQueue.unshift(orphanedTask);
        console.error(`[rescue] tile (${orphanedTask.startX},${orphanedTask.startY}) re-queued — queue: ${state.taskQueue.length}`);
        processQueue(io);  // immediately try to assign it to another worker
      }

      if (wasWorker || orphanedTask) {
        console.error(`[worker] ${socket.id} dropped — pool now: ${state.availableWorkers.length}`);
      }

      // Notify the dashboard so the frontend can show a warning
      if (state.dashboardSocketId && (wasWorker || orphanedTask)) {
        io.to(state.dashboardSocketId).emit('worker_disconnected', {
          workerId: socket.id,
          reason,
          tileRescued: orphanedTask ? { startX: orphanedTask.startX, startY: orphanedTask.startY } : null,
          remainingWorkers: state.availableWorkers.length,
          pendingTiles: state.taskQueue.length,
        });
      }
    });
  });
}

module.exports = { setupSockets };
