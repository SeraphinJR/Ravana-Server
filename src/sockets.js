// ── The Traffic Cop ─────────────────────────────────────────
// Routes data between the Master Dashboard and Mobile Workers.
// The dashboard is ALSO a worker — every device renders tiles.
// Does zero math — just moves bytes around as fast as possible.

const state = require('./state');
const { processQueue, clearTaskTimeout } = require('./queue');

const TILE_SIZE = 64; // pixels per chunk edge

/**
 * Wire up every Socket.io event the system cares about.
 * @param {import('socket.io').Server} io
 */
function setupSockets(io) {
  io.on('connection', (socket) => {
    console.log(`[+] connected: ${socket.id}`);

    // ── Dashboard Registration ──────────────────────────
    socket.on('register_dashboard', () => {
      state.dashboardSocketIds.add(socket.id);
      // Dashboard does NOT join the worker pool — it only receives render_update results
      console.log(`[dashboard] registered: ${socket.id}  (masters: ${state.dashboardSocketIds.size}, pool: ${state.availableWorkers.length})`);

      // Send all cached geometries so late-joining dashboards see the scene
      for (const [masterSocketId, geocache] of state.geocache) {
        socket.emit('sync_geometry', geocache);
        console.log(`[geocache] sent to dashboard ${socket.id} (from master ${masterSocketId})`);
      }
    });

    // ── Worker Registration ─────────────────────────────────
    // Workers register to one or more masters by passing { masterSocketId }.
    // Call multiple times with different masterSocketIds to serve several masters.
    // Each tile carries its masterSocketId so the worker always knows the owner.
    // NOTE: Workers are NOT added to availableWorkers until they send 'worker_ready'
    socket.on('register_worker', (data) => {
      const masterSocketId = data?.masterSocketId || null;

      // Initialize worker tracking (but don't add to available pool yet)
      if (!state.workerMasterMap.has(socket.id)) {
        state.workerMasterMap.set(socket.id, new Set());
      }

      const masters = state.workerMasterMap.get(socket.id);

      if (masterSocketId) {
        const isNew = !masters.has(masterSocketId);
        masters.add(masterSocketId);

        console.log(`[worker] ${socket.id} registered → master ${masterSocketId}  (serving ${masters.size} master(s))`);

        // Send only the new master's geocache (avoid re-sending ones already delivered)
        if (isNew && state.geocache.has(masterSocketId)) {
          socket.emit('sync_geometry', state.geocache.get(masterSocketId));
          console.log(`[geocache] sent to worker ${socket.id} (from master ${masterSocketId})`);
        }
      } else {
        console.log(`[worker] ${socket.id} registered → all masters`);

        // No specific master — send every cached geocache
        for (const [mId, geocache] of state.geocache) {
          socket.emit('sync_geometry', geocache);
          console.log(`[geocache] sent to worker ${socket.id} (from master ${mId})`);
        }
      }

      // Don't call processQueue here - wait for worker_ready event
    });

    // ── Worker Ready Acknowledgment ─────────────────────────
    // Worker signals it has fully processed geometry and is ready for tasks
    // This also serves as the completion signal after rendering a tile
    socket.on('worker_ready', () => {
      // Remove from any existing position (the worker might have been in activeTasks)
      const wasActive = state.activeTasks.has(socket.id);
      state.activeTasks.delete(socket.id);
      
      // Remove from available workers if present (for clean re-add)
      const existingIndex = state.availableWorkers.indexOf(socket.id);
      if (existingIndex !== -1) {
        state.availableWorkers.splice(existingIndex, 1);
      }
      
      // Add to available workers pool (at the end for round-robin)
      state.availableWorkers.push(socket.id);
      
      console.log(`[worker] ${socket.id} ready (was: ${wasActive ? 'rendering' : 'idle'}) — pool: ${state.availableWorkers.length}, queue: ${state.taskQueue.length}`);
      
      // Process queue to assign any pending tiles
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
    // ScenePayload.emission: { strength, texture, useEmission } | null
    //   Emissive data per mesh, controls self-illumination
    // ScenePayload.diffuse: { bsdf, albedo, roughness, metallic } | null
    //   BSDF parameters for material properties
    // ScenePayload.lighting: { ambientIntensity, shadowsEnabled, globalIllumination }
    //   Scene-level lighting configuration
    // ScenePayload.shading: { shadingModel, normalMaps, parallaxMapping }
    //   Shading techniques and normal/parallax mapping flags
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
    socket.on('start_render', ({ canvasWidth, canvasHeight, camera, sunDir, lights, samples, tileSize }) => {
      console.log(`[render] start ${canvasWidth}x${canvasHeight} from master ${socket.id}, ${(lights || []).length} lights, ${samples || 16} samples, ${tileSize || TILE_SIZE}px tiles`);

      // Use custom tile size if provided, otherwise default
      const activeTileSize = tileSize || TILE_SIZE;
      
      // Serialize camera data to prevent circular references from Three.js objects
      const serializedCamera = camera ? {
        cameraPos: camera.cameraPos,
        viewMatrix: camera.viewMatrix,
        fov: camera.fov,
        sunDir: camera.sunDir,
        exposure: camera.exposure,
        lightScale: camera.lightScale,
        samples: camera.samples
      } : null;
      
      // Serialize lights array to prevent circular references
      const serializedLights = (lights || []).map(light => ({
        type: light.type,
        position: light.position,
        intensity: light.intensity,
        color: light.color,
        // Only copy serializable properties
      }));
      
      // Slice the canvas into a grid of activeTileSize × activeTileSize chunks
      // Each tile carries the full context a worker's Web Worker needs
      // (scene geometry is already on each device via sync_geometry)
      // masterSocketId tags each tile so results route to the correct master
      for (let y = 0; y < canvasHeight; y += activeTileSize) {
        for (let x = 0; x < canvasWidth; x += activeTileSize) {
          state.taskQueue.push({
            startX: x,
            startY: y,
            width: Math.min(activeTileSize, canvasWidth - x),
            height: Math.min(activeTileSize, canvasHeight - y),
            canvasWidth,
            canvasHeight,
            camera: serializedCamera,
            sunDir: sunDir ? { x: sunDir.x, y: sunDir.y, z: sunDir.z } : null,
            lights: serializedLights,
            samples: samples || 16,
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
    // Worker sends rendered tile data. Worker will emit worker_ready when truly ready for next tile.
    socket.on('tile_finished', (payload, acknowledgeFn) => {
      const logPrefix = `[tile:${payload.startX},${payload.startY}]`;
      console.log(`${logPrefix} ${socket.id} finished`);
      
      // Retrieve the in-flight task for validation and master lookup
      const task = state.activeTasks.get(socket.id);
      
      // Clear timeout if task exists
      if (task) {
        clearTaskTimeout(socket.id);
      }
      
      // Validate tile coordinates match assigned task
      if (task && (task.startX !== payload.startX || task.startY !== payload.startY)) {
        console.error(`${logPrefix} Coordinate mismatch! Expected (${task.startX},${task.startY}), got (${payload.startX},${payload.startY})`);
      }
      
      // Remove from active tasks (worker is no longer rendering this task)
      state.activeTasks.delete(socket.id);

      // If the payload is a skip (e.g., dashboard can't render), re-queue the tile
      if (payload.skip && task) {
        state.taskQueue.unshift(task);
        console.log(`${logPrefix} dashboard ${socket.id} skipped — re-queued`);
        // Don't add to available workers to avoid dashboard rendering its own tiles
        processQueue(io);
        
        // Send acknowledgment
        if (acknowledgeFn && typeof acknowledgeFn === 'function') {
          acknowledgeFn({ status: 'skipped', requeued: true });
        }
        return;
      }

      // Route rendered pixels to the correct master
      const masterSocketId = payload.masterSocketId || task?.masterSocketId;
      
      if (!masterSocketId) {
        console.error(`${logPrefix} No masterSocketId! Worker: ${socket.id}, Task: ${!!task}`);
        if (acknowledgeFn && typeof acknowledgeFn === 'function') {
          acknowledgeFn({ status: 'error', error: 'No master ID' });
        }
        return;
      }
      
      // Send tile to master dashboard with acknowledgment
      if (masterSocketId && state.dashboardSocketIds.has(masterSocketId)) {
        io.to(masterSocketId).emit('render_update', payload, (dashboardAck) => {
          if (dashboardAck && dashboardAck.status === 'received') {
            console.log(`${logPrefix} Delivered to master ${masterSocketId}`);
          } else {
            console.warn(`${logPrefix} Master ${masterSocketId} did not acknowledge receipt`);
          }
        });
      } else if (state.dashboardSocketIds.size > 0) {
        // Fallback: broadcast to all dashboards
        console.warn(`${logPrefix} Master ${masterSocketId} not found, broadcasting`);
        for (const dashId of state.dashboardSocketIds) {
          io.to(dashId).emit('render_update', payload);
        }
      } else {
        console.error(`${logPrefix} No dashboards connected!`);
      }
      
      // Send acknowledgment to worker
      if (acknowledgeFn && typeof acknowledgeFn === 'function') {
        acknowledgeFn({ status: 'received' });
      }
      
      // Note: Worker will emit worker_ready when truly ready for next tile
      // This prevents assigning the next tile before worker has finished cleanup
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
            clearTaskTimeout(workerId);
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
        clearTaskTimeout(socket.id);
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
