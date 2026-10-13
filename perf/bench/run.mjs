// Alternating benchmark runner: fresh process per run, variant order reversed every round
// (ABBA...), scene order rotated, results appended as JSON lines.
//
//   node perf/bench/run.mjs --rounds 5 --scenes drift500,contact \
//     --variant stock=<vecs root>[@<box2d entry.mjs>] --variant fork=<vecs root>@<entry.mjs> \
//     [--alloc] [--out perf/results/x.jsonl]
//
// Prints, per scene and variant: median, min, max of each timing and the max/min spread (noise).
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const variants = [];
args.forEach((arg, i) => {
  if (arg === "--variant") {
    const [name, spec] = args[i + 1].split("=");
    const [vecsRoot, entry] = spec.split("@");
    variants.push({ name, vecsRoot: resolve(vecsRoot), entry: entry && resolve(entry) });
  }
});
const rounds = Number(opt("rounds", 3));
const scenes = opt(
  "scenes",
  "drift500,drift2000,drift10000,contact,worlds25x19,rest2000,drive500"
).split(",");
const alloc = args.includes("--alloc");
const out = opt("out");
if (out) mkdirSync(dirname(resolve(out)), { recursive: true });

const results = [];
for (let round = 0; round < rounds; round++) {
  const order = round % 2 === 0 ? variants : [...variants].reverse();
  const sceneOrder = scenes.map((_, i) => scenes[(i + round) % scenes.length]);
  for (const scene of sceneOrder) {
    for (const variant of order) {
      const env = { ...process.env, BENCH_VECS_ROOT: variant.vecsRoot };
      if (variant.entry) env.BOX2D_ENTRY = variant.entry;
      else delete env.BOX2D_ENTRY;
      const nodeArgs = ["--import", resolve(here, "register.mjs")];
      if (alloc) {
        env.BENCH_MODE = "alloc";
        env.BENCH_TICKS = env.BENCH_TICKS ?? "50";
        nodeArgs.push("--expose-gc", "--min-semi-space-size=1024", "--max-semi-space-size=1024");
      }
      const stdout = execFileSync(
        process.execPath,
        [...nodeArgs, resolve(here, "vecs-tick.ts"), scene],
        { env, encoding: "utf8", maxBuffer: 1 << 26 }
      );
      const line = stdout.split("\n").find((l) => l.startsWith("TICK_RESULT "));
      const result = { variant: variant.name, round, ...JSON.parse(line.slice(12)) };
      results.push(result);
      if (out) appendFileSync(out, JSON.stringify(result) + "\n");
      console.error(
        `r${round} ${scene.padEnd(12)} ${variant.name.padEnd(10)} tick ${result.tickNs} pose ${result.poseNs} step ${result.stepNs} alloc ${result.allocBytesPerStep} ${result.checksum}`
      );
    }
  }
}

const keys = ["tickNs", "poseNs", "stepNs", "eventsNs", "otherNs"];
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
console.log("\nscene        variant     metric   median     min       max     spread  checksums");
for (const scene of scenes) {
  for (const variant of variants) {
    const rs = results.filter((r) => r.scene === scene && r.variant === variant.name);
    const sums = [...new Set(rs.map((r) => r.checksum))].join(",");
    const metrics = alloc ? ["allocBytesPerStep"] : keys;
    for (const key of metrics) {
      const xs = rs.map((r) => r[key]);
      const lo = Math.min(...xs);
      const hi = Math.max(...xs);
      console.log(
        `${scene.padEnd(12)} ${variant.name.padEnd(10)} ${key.padEnd(8)} ${median(xs).toFixed(1).padStart(8)} ${lo.toFixed(1).padStart(9)} ${hi.toFixed(1).padStart(9)} ${(lo > 0 ? ((hi / lo - 1) * 100).toFixed(1) + "%" : "-").padStart(7)}  ${key === metrics[0] ? sums : ""}`
      );
    }
  }
}
