// Arithmetic helpers for the fixture project.
// BUG: add() was reported to subtract instead of add — fix it here.

function add(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };
