// Runs the eval suite in sequence and summarizes PASS/FAIL. Each eval is its own
// process (its own throwaway collection, its own cleanup), so one failure never
// leaves state behind for the next.
//
// The latency eval is intentionally excluded: it writes to the LIVE fraud_demo
// collection. Run it on its own when you want the p95 number:
//   npx tsx --env-file=.env evals/latency.ts
//
// Run: npm run evals   (or: npx tsx evals/run-all.ts)

import { spawnSync } from "node:child_process";

const SUITES = [
  "api-contract",
  "motif-detection",
  "cold-start",
  "determinism",
  "tenant-isolation",
  "janitor",
];

const results: { suite: string; ok: boolean }[] = [];
for (const suite of SUITES) {
  console.log(`\n${"=".repeat(60)}\n  ${suite}\n${"=".repeat(60)}`);
  const r = spawnSync("npx", ["tsx", "--env-file=.env", `evals/${suite}.ts`], {
    stdio: "inherit",
  });
  results.push({ suite, ok: r.status === 0 });
}

console.log(`\n${"=".repeat(60)}\n  Summary\n${"=".repeat(60)}`);
for (const { suite, ok } of results) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${suite}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed === 0
    ? "\nAll evals passed. (latency eval excluded; it writes to the live collection.)"
    : `\n${failed} eval(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
