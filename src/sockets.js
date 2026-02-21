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
      state.dashboardSocketIds.add(socket.id);
      state.availableWorkers.push(socket.id);
      console.log(`[dashboard+worker] registered: ${socket.id}  (masters: ${state.dashboardSocketIds.size}, pool: ${state.availableWorkers.length})`);

      // Send all cached geometries so the dashboard worker is render-ready immediately
      for (const [masterSocketId, geocache] of state.geocache) {
        socket.emit('sync_geometry', geocache);
        console.log(`[geocache] sent to dashboard ${socket.id} (from master ${masterSocketId})`);
      }

      processQueue(io);
    });

    // ── Worker Registration ─────────────────────────────────
    // Workers register to one or more masters by passing { masterSocketId }.
    // Call multiple times with different masterSocketIds to serve several masters.
    // Each tile carries its masterSocketId so the worker always knows the owner.
    socket.on('register_worker', (data) => {
      const masterSocketId = data?.masterSocketId || null;

      // Only add to available pool on first registration
      if (!state.workerMasterMap.has(socket.id)) {
        state.availableWorkers.push(socket.id);
        state.workerMasterMap.set(socket.id, new Set());
      }

      const masters = state.workerMasterMap.get(socket.id);

      if (masterSocketId) {
        const isNew = !masters.has(masterSocketId);
        masters.add(masterSocketId);

        console.log(`[worker] ${socket.id} registered → master ${masterSocketId}  (serving ${masters.size} master(s), pool: ${state.availableWorkers.length})`);

        // Send only the new master's geocache (avoid re-sending ones already delivered)
        if (isNew && state.geocache.has(masterSocketId)) {
          socket.emit('sync_geometry', state.geocache.get(masterSocketId));
          console.log(`[geocache] sent to worker ${socket.id} (from master ${masterSocketId})`);
        }
      } else {
        console.log(`[worker] ${socket.id} registered → all masters  (pool: ${state.availableWorkers.length})`);

        // No specific master — send every cached geocache
        for (const [mId, geocache] of state.geocache) {
          socket.emit('sync_geometry', geocache);
          console.log(`[geocache] sent to worker ${socket.id} (from master ${mId})`);
        }
      }

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
      console.log(`[geometry] broadcasting scene (${meshCount} meshes, ${totalVerts} verts) from master ${socket.id} to all workers`);

      // Tag the geocache with the master's socket ID
      payload.masterSocketId = socket.id;

      // Cache per-master so late-joining workers get the correct scene
      state.geocache.set(socket.id, payload);

      socket.broadcast.emit('sync_geometry', payload);
    });

    // ── Kick Off a Render ───────────────────────────────────
    // Camera comes from the ScenePayload already synced, but the
    // dashboard can override it here. sunDir is a lighting hint.
    socket.on('start_render', ({ canvasWidth, canvasHeight, camera, sunDir }) => {
      console.log(`[render] start ${canvasWidth}x${canvasHeight} from master ${socket.id}`);

      // Slice the canvas into a grid of TILE_SIZE × TILE_SIZE chunks
      // Each tile carries the full context a worker's Web Worker needs
      // (scene geometry is already on each device via sync_geometry)
      // masterSocketId tags each tile so results route to the correct master
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
            masterSocketId: socket.id,
          });
        }
      }

      console.log(`[render] queued ${state.taskQueue.length} tiles for master ${socket.id}`);
      processQueue(io);
    });

    // ── Worker Missing Geocache ─────────────────────────────
    // If a worker reports it doesn't have the geocache, re-send it.
    socket.on('request_geocache', () => {
      const masters = state.workerMasterMap.get(socket.id);
      let sent = 0;

      if (masters && masters.size > 0) {
        // Send only geocaches for masters this worker is registered to
        for (const mId of masters) {
          if (state.geocache.has(mId)) {
            socket.emit('sync_geometry', state.geocache.get(mId));
            console.log(`[geocache] re-sent to ${socket.id} (from master ${mId}, on request)`);
            sent++;
          }
        }
      }

      // Fallback: if no master-specific caches found, send all
      if (sent === 0 && state.geocache.size > 0) {
        for (const [mId, geocache] of state.geocache) {
          socket.emit('sync_geometry', geocache);
          console.log(`[geocache] re-sent to ${socket.id} (from master ${mId}, on request, fallback)`);
        }
      } else if (sent === 0) {
        console.warn(`[geocache] ${socket.id} requested geocache but none is cached`);
      }
    });

    // ── Worker Finished a Tile ──────────────────────────────
    socket.on('tile_finished', (payload) => {
      // Retrieve the in-flight task to find the owning master
      const task = state.activeTasks.get(socket.id);
      state.activeTasks.delete(socket.id);

      // Route rendered pixels to the correct master using masterSocketId
      const masterSocketId = payload.masterSocketId || task?.masterSocketId;
      if (masterSocketId && state.dashboardSocketIds.has(masterSocketId)) {
        io.to(masterSocketId).emit('render_update', payload);
      } else if (state.dashboardSocketIds.size > 0) {
        // Fallback: send to all masters if we can't determine the owner
        for (const dashId of state.dashboardSocketIds) {
          io.to(dashId).emit('render_update', payload);
        }
      }

      // Return the worker to the pool and keep draining
      state.availableWorkers.push(socket.id);
      processQueue(io);
    });

    // ── Disconnect Cleanup ──────────────────────────────────
    socket.on('disconnect', (reason) => {
      console.error(`[-] disconnected: ${socket.id}  reason: ${reason}`);

      const wasDashboard = state.dashboardSocketIds.has(socket.id);
      const wasWorker = state.availableWorkers.includes(socket.id);

      if (wasDashboard) {
        state.dashboardSocketIds.delete(socket.id);

        // ── Purge ALL data belonging to this master ─────────
        // 1. Remove geocache
        state.geocache.delete(socket.id);

        // 2. Remove queued tiles that belong to this master
        const beforeQueue = state.taskQueue.length;
        state.taskQueue = state.taskQueue.filter(t => t.masterSocketId !== socket.id);
        const purgedQueued = beforeQueue - state.taskQueue.length;

        // 3. Cancel in-flight tasks belonging to this master
        let purgedActive = 0;
        for (const [workerId, task] of state.activeTasks) {
          if (task.masterSocketId === socket.id) {
            state.activeTasks.delete(workerId);
            // Return the worker to the pool since its task is now void
            state.availableWorkers.push(workerId);
            purgedActive++;
          }
        }

        // 4. Remove this master from every worker's master set
        for (const [workerId, masters] of state.workerMasterMap) {
          masters.delete(socket.id);
        }

        // 5. Notify all remaining sockets that this master is gone
        socket.broadcast.emit('master_disconnected', { masterSocketId: socket.id });

        console.error(`[dashboard] master ${socket.id} disconnected — purged ${purgedQueued} queued tiles, ${purgedActive} active tasks, geocache removed — remaining masters: ${state.dashboardSocketIds.size}`);

        // Freed-up workers may be able to pick up other masters' tiles
        if (purgedActive > 0) {
          processQueue(io);
        }
      }

      // Remove ALL occurrences from worker pool (handles dashboard dual-role)
      let idx;
      while ((idx = state.availableWorkers.indexOf(socket.id)) !== -1) {
        state.availableWorkers.splice(idx, 1);
      }

      // Clean up worker → masters mapping
      state.workerMasterMap.delete(socket.id);

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

      // Notify all masters so the frontend can show a warning
      if (state.dashboardSocketIds.size > 0 && (wasWorker || orphanedTask)) {
        const disconnectPayload = {
          workerId: socket.id,
          reason,
          tileRescued: orphanedTask ? { startX: orphanedTask.startX, startY: orphanedTask.startY } : null,
          remainingWorkers: state.availableWorkers.length,
          pendingTiles: state.taskQueue.length,
        };
        for (const dashId of state.dashboardSocketIds) {
          io.to(dashId).emit('worker_disconnected', disconnectPayload);
        }
      }
    });
  });
}

module.exports = { setupSockets };
