const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const source = fs.readFileSync(path.join(__dirname, "../components/AllocationSimulation.jsx"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
function harness(initial = []) {
  const state = [], effects = [], requests = [];
  const imports = {
    react: { ...React, useEffect: fn => effects.push(fn), useState: value => {
      const index = state.length;
      state.push(index in initial ? initial[index] : value);
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    } },
    "@/lib/quant": { simulationWeights: () => ({ xlm: .3, ustry: .7 }),
      quantRequest: (endpoint, body, signal) => new Promise((resolve, reject) => requests.push({ endpoint, body, signal, resolve, reject })) },
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => imports[name] ?? require(name), module, module.exports);
  return { ...module.exports, state, effects, requests };
}
function nodes(node) {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const text = node => nodes(node).filter(n => typeof n === "string" || typeof n === "number").join("");
const flush = () => new Promise(resolve => setImmediate(resolve));

test("one request loads all allocation metrics and both curves, ignoring a cancelled response", async () => {
  const h = harness();
  h.default({ allocation: { positions: {}, market_snapshot_id: "a".repeat(64) } });
  const cleanup = h.effects[0]();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].endpoint, "builder/simulation");
  assert.deepEqual(h.requests[0].body, { weights: { xlm: .3, ustry: .7 }, market_snapshot_id: "a".repeat(64) });
  cleanup();
  h.requests[0].resolve({ status: "available" });
  await flush();
  assert.equal(h.state[0], null);
  h.effects[0]();
  h.requests[1].resolve({ status: "unavailable", reason: "Missing history" });
  await flush();
  assert.equal(h.state[0].reason, "Missing history");
});

test("unavailable simulation shows its reason without fabricating a curve", () => {
  const tree = harness([{ status: "unavailable", reason: "Market data changed; rebuild" }]).default({ allocation: {} });
  assert.match(text(tree), /Simulation unavailable: Market data changed; rebuild/);
  assert.equal(nodes(tree).filter(n => n.type === "table").length, 0);
  const failed = harness([null, "API unavailable"]).default({ allocation: {} });
  assert.match(text(failed), /API unavailable/);
  assert.match(text(failed), /Retry simulation/);
});

test("equity chart plots both series with keyboard-accessible daily values", () => {
  const h = harness();
  const points = [{ date: "2025-09-18", portfolio: 100, xlm: 100 },
    { date: "2026-03-18", portfolio: 105, xlm: 80 }, { date: "2026-09-18", portfolio: 110, xlm: 95 }];
  const tree = h.EquityChart({ points });
  const lines = nodes(tree).filter(n => n.type === "path");
  assert.equal(lines.length, 2);
  assert.ok(lines.every(n => !/NaN|Infinity/.test(n.props.d)));
  assert.match(text(tree), /Portfolio 110.00 · XLM 95.00/);
  const slider = nodes(tree).find(n => n.type === "input");
  assert.equal(slider.props["aria-label"], "Explore historical equity by day");
  slider.props.onChange({ target: { value: "1" } });
  assert.equal(h.state[0], 1);
});
