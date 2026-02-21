// ── The Engine ──────────────────────────────────────────────
// Drains the task queue by pairing idle workers with pending tiles.

const state = require('./state');

/**
 * Match available workers to queued tasks and dispatch them.
 * Runs until either pool is exhausted.
 * @param {import('socket.io').Server} io
 */
function processQueue(io) {
  while (state.availableWorkers.length > 0 && state.taskQueue.length > 0) {
    const workerId = state.availableWorkers.shift();
    const task = state.taskQueue.shift();

    // Track in-flight work so we can re-queue if the worker drops
    state.activeTasks.set(workerId, task);

    io.to(workerId).emit('assign_tile', task);
  }
}

module.exports = { processQueue };
