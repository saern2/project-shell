'use strict';

/**
 * tests/globalTeardown.js
 * Jest global teardown — runs once after all test suites complete.
 */

module.exports = async function globalTeardown() {
  // Nothing needed — individual test suites close their own Redis connections
};
