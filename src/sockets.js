// ── The Traffic Cop ─────────────────────────────────────────
// Routes data between the Master Dashboard and Mobile Workers.
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

    // ── Dashboard Registration ──────────────────────────────
    socket.on('register_dashboard', () => {
      state.dashboardSocketId = socket.id;
      console.log(`[dashboard] registered: ${socket.id}`);
    });

    // ── Worker Registration ─────────────────────────────────
    socket.on('register_worker', () => {
      state.availableWorkers.push(socket.id);
      console.log(`[worker] registered: ${socket.id}  (pool: ${state.availableWorkers.length})`);
      processQueue(io);
    });

    // ── Geometry Sync (heavy Float32Array broadcast) ────────
    socket.on('sync_geometry', (payload) => {
      console.log('[geometry] broadcasting to all workers');
      socket.broadcast.emit('sync_geometry', payload);
    });

    // ── Kick Off a Render ───────────────────────────────────
    socket.on('start_render', ({ canvasWidth, canvasHeight, camera }) => {
      console.log(`[render] start ${canvasWidth}x${canvasHeight}`);

      // Slice the canvas into a grid of TILE_SIZE × TILE_SIZE chunks
      for (let y = 0; y < canvasHeight; y += TILE_SIZE) {
        for (let x = 0; x < canvasWidth; x += TILE_SIZE) {
          state.taskQueue.push({
            startX: x,
            startY: y,
            width: Math.min(TILE_SIZE, canvasWidth - x),
            height: Math.min(TILE_SIZE, canvasHeight - y),
            camera,
          });
        }
      }

      console.log(`[render] queued ${state.taskQueue.length} tiles`);
      processQueue(io);
    });

    // ── Worker Finished a Tile ──────────────────────────────
    socket.on('tile_finished', (payload) => {
      // Forward the rendered pixels straight to the dashboard
      if (state.dashboardSocketId) {
        io.to(state.dashboardSocketId).emit('render_update', payload);
      }

      // Return the worker to the pool and keep draining
      state.availableWorkers.push(socket.id);
      processQueue(io);
    });

    // ── Disconnect Cleanup ──────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[-] disconnected: ${socket.id}`);

      if (socket.id === state.dashboardSocketId) {
        state.dashboardSocketId = null;
        console.log('[dashboard] unregistered');
      }

      const idx = state.availableWorkers.indexOf(socket.id);
      if (idx !== -1) {
        state.availableWorkers.splice(idx, 1);
        console.log(`[worker] removed (pool: ${state.availableWorkers.length})`);
      }
    });
  });
}

module.exports = { setupSockets };
