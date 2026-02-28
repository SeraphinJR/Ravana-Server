// ── The Engine ──────────────────────────────────────────────
// Drains the task queue by pairing idle workers with pending tiles.

const state = require('./state');

// Timeout for tile acknowledgment (30 seconds)
const TILE_TIMEOUT_MS = 30000;

// Store timeout IDs separately to avoid circular references
// Maps: workerId -> timeoutId
const tileTimeouts = new Map();

/**
 * Match available workers to queued tasks and dispatch them.
 * Runs until either pool is exhausted.
 * @param {import('socket.io').Server} io
 */
function processQueue(io) {
  let assigned = 0;
  
  while (state.availableWorkers.length > 0 && state.taskQueue.length > 0) {
    const workerId = state.availableWorkers.shift();
    const task = state.taskQueue.shift();
    
    // Defensive check: ensure workerId is valid
    if (!workerId) {
      console.error('[queue] Invalid workerId (null/undefined), skipping');
      // Put task back at front
      state.taskQueue.unshift(task);
      continue;
    }

    // Track in-flight work so we can re-queue if the worker drops
    state.activeTasks.set(workerId, task);
    
    // Set timeout for this task in case worker never responds
    const timeoutId = setTimeout(() => {
      const stuckTask = state.activeTasks.get(workerId);
      if (stuckTask && stuckTask.startX === task.startX && stuckTask.startY === task.startY) {
        console.error(`[queue] TIMEOUT: Worker ${workerId} failed to complete tile (${task.startX},${task.startY}) in ${TILE_TIMEOUT_MS}ms`);
        
        // Re-queue the tile at the front
        state.taskQueue.unshift(task);
        state.activeTasks.delete(workerId);
        tileTimeouts.delete(workerId);
        
        // Remove worker from available pool (it's probably dead/stuck)
        const idx = state.availableWorkers.indexOf(workerId);
        if (idx !== -1) {
          state.availableWorkers.splice(idx, 1);
          console.error(`[queue] Removed stuck worker ${workerId} from pool`);
        }
        
        // Try to assign to another worker
        processQueue(io);
      }
    }, TILE_TIMEOUT_MS);
    
    // Store timeout ID separately to avoid circular references when sending via Socket.IO
    tileTimeouts.set(workerId, timeoutId);

    console.log(`[queue] ${workerId} <- tile(${task.startX},${task.startY}) | remaining: ${state.taskQueue.length} tiles, ${state.availableWorkers.length} workers`);
    
    // Emit with acknowledgment callback
    io.to(workerId).emit('assign_tile', task, (ack) => {
      if (ack && ack.status === 'accepted') {
        console.log(`[queue] Worker ${workerId} accepted tile (${task.startX},${task.startY})`);
      } else if (ack && ack.status === 'rejected') {
        console.warn(`[queue] Worker ${workerId} rejected tile (${task.startX},${task.startY}): ${ack.reason || 'unknown'}`);
        
        // Worker rejected - put tile back at front of queue
        state.taskQueue.unshift(task);
        
        // Clear the task from activeTasks and timeout
        state.activeTasks.delete(workerId);
        clearTaskTimeout(workerId);
        
        // Don't put worker back in pool - if they're busy, they'll emit worker_ready when done
        // If they rejected for another reason (geometry not ready), they'll also emit worker_ready when ready
        
        console.log(`[queue] Tile (${task.startX},${task.startY}) re-queued, worker will signal ready when available`);
        
        // Try to assign to another worker after a brief delay
        setImmediate(() => processQueue(io));
      } else {
        console.warn(`[queue] Worker ${workerId} did not acknowledge tile assignment`);
      }
    });
    
    assigned++;
  }
  
  // Log queue status
  if (assigned > 0) {
    console.log(`[queue] Assigned ${assigned} tile(s)`);
  }
  
  if (state.taskQueue.length > 0 && state.availableWorkers.length === 0) {
    console.log(`[queue] STALLED: ${state.taskQueue.length} tile(s) waiting, 0 workers available, ${state.activeTasks.size} rendering`);
  } else if (state.taskQueue.length === 0 && state.activeTasks.size === 0 && assigned > 0) {
    console.log(`[queue] ✓ All tiles assigned/complete`);
  }
}

/**
 * Clear timeout for a worker's current task
 * @param {string} workerId 
 */
function clearTaskTimeout(workerId) {
  const timeoutId = tileTimeouts.get(workerId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    tileTimeouts.delete(workerId);
  }
}

module.exports = { processQueue, clearTaskTimeout };
