'use strict';

// Format: "req_" + 8 random hex chars → e.g. "req_a3f7c21b"
// Math.random() is sufficient — this is a tracing ID, not a security token.
function generateRequestId() {
  return 'req_' + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
}

module.exports = { generateRequestId };
