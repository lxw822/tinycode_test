const test = require("node:test");
const assert = require("node:assert");
const { add, multiply } = require("./math.js");

test("add sums two numbers", () => {
  assert.strictEqual(add(2, 3), 5);
  assert.strictEqual(add(-1, 1), 0);
});

test("multiply multiplies two numbers", () => {
  assert.strictEqual(multiply(3, 4), 12);
});
