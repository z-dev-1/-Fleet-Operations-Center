'use strict';
// Test-only worker that never replies and spins forever (a synchronous infinite loop),
// to prove the host kills it at PARSE_TIMEOUT_MS. The production worker has no
// test-only job types.
// (It must not send anything on startup: the host would take it for a malformed reply.)
process.on('message', () => {
  // eslint-disable-next-line no-constant-condition
  while (true) { /* spin */ }
});
