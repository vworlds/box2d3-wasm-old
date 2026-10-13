# Report: a box2d3-wasm fork for a cheaper vecs physics tick

**Fork:** `vworlds/box2d3-wasm`, branch `claude/youthful-edison-uyuukr`, package
`@vworlds/box2d3-wasm` **5.2.0-vworlds.1** (upstream box2d3-wasm 5.2.0 + fast path).
**Context:** vworlds/vecs#273 (pose copy-out was 49% of a Space Rocks server tick), PR #274.
**Rule kept throughout:** every result is bit-identical to stock 5.2.0.

## Summary

- The vecs physics tick is **10.1–10.6× cheaper** per body on always-moving scenes of 500–2,000
  bodies, **5.2×** at 10,000, **6.1×** for 25 small worlds (the Space Rocks shape), **3.7×** on a
  contact-heavy pile and **22×** for awake bodies at rest, on the machine of the baseline. Copy-out
  is **12.5–14.2×** cheaper at 500–2,000 bodies.
- On the machine of the audit, to which the container moved, the same build gives **8.3× / 6.4× /
  4.1×** on the tick (500 / 2,000 / 10,000 bodies) and 7.0× for 25 worlds. The remaining cost is
  vecs's memory-bound ECS work, which that host runs slower.
- **Simulation results are unchanged.** In every scene, per-step traces of every body's pose and
  velocities are identical to stock, and contact events are identical too. vecs's own benchmark
  reproduces its checksums (N=500 `11c76fa7`, N=2,000 `a66a94ee`), and the vecs suites pass
  unchanged, including `motion_accuracy.test.ts`.
- **How:**
  - a zero-allocation **fast path** of plain wasm exports (`b2x_`) next to the unchanged embind API;
  - a runtime switch for Box2D's **profile timers** (each timed section made a JS call);
  - **LTO** across Box2D and the glue.
  - Embind was 53–73% of the stock tick; it is now 0.0–0.3%.
- **What the vecs adapter must change:** one bulk export call per world per step for poses and
  velocities, event spans, raw per-body calls, timers off. All in
  [docs/vecs-migration.md](docs/vecs-migration.md), with a working reference implementation
  ([perf/adapter/](perf/adapter/)).
- **What remains:** vecs's own ECS work (45–55% of moving ticks) and Box2D's step. Neither can
  shrink without changing vecs semantics or simulation results.

## Deliverables

| what | where |
|---|---|
| the fork (build scripts, fast path, Box2D patch) | `box2d3-wasm/` ([PATCHES.md](PATCHES.md) lists every change vs upstream) |
| API reference with TypeScript declarations | [box2d3-wasm/docs/fastpath.md](box2d3-wasm/docs/fastpath.md), `box2d3-wasm/src/fastpath.d.ts`, `src/fastpath_body.gen.d.ts` |
| migration guide for vecs | [docs/vecs-migration.md](docs/vecs-migration.md) |
| reference vecs adapter (local scratch branch, as patches on vecs `2d58dd7`) | [perf/adapter/](perf/adapter/) |
| benchmarks, proof kit, raw results, profiles | [perf/](perf/), `perf/results/` |
| working log (all phases, every round) | [CHECKPOINT.md](CHECKPOINT.md) |

## Final table (audited build, same session)

Timings are ns per body per step: **copy-out** is the `PhysicsPoseSyncOut` system including
its deferred flush, **step** is `PhysicsStep`, **tick** is `world.progress` of all worlds. Stock is
npm `box2d3-wasm@5.2.0` with unmodified vecs `2d58dd7`; final is the fork with the reference
adapter. Medians of alternating fresh-process rounds in one session; "spread" is max/min of the
final runs. All checksums are identical to stock in every run.

**The container moved to a different host during the audit** (it rebooted mid-Phase 4), so the
final comparison exists on two machines. Results are identical on both; speedups are not (see
"Host dependence" below).

### Host A: the machine of Phases 1–3 and of the baseline

Final = the Phase 3 build: the same sources the audit rebuilt, plus the adapter at round 9.
5 alternating rounds:

| scene | copy-out stock → final | step | events | whole tick stock → final | tick spread (final) | alloc B/body/step stock → final |
|---|---|---:|---:|---|---:|---:|
| drift500 | 6,809 → 480 (**14.2×**) | 248 → 158 | 51 → 9 | 7,171 → 678 (**10.6×**) | 31% | 3,782 → 407 |
| drift2000 | 7,815 → 624 (**12.5×**) | 248 → 166 | 27 → 4 | 8,131 → 807 (**10.1×**) | 17% | 3,751 → 394 |
| drift10000 | 7,745 → 1,289 (**6.0×**) | 259 → 244 | 9 → 3 | 8,020 → 1,541 (**5.2×**) | 5% | 3,764 → 385 |
| contact | 8,776 → 1,112 (7.9×) | 2,092 → 1,743 | 432 → 147 | 11,366 → 3,067 (**3.7×**) | 18% | 4,274 → 840 |
| worlds25x19 | 7,258 → 676 (10.7×) | 1,124 → 227 | 278 → 40 | 9,621 → 1,564 (**6.1×**) | 17% | 4,432 → 691 |
| rest2000 | 6,412 → 200 (32.1×) | 138 → 89 | 19 → 4 | 6,601 → 295 (**22.4×**) | 25% | 3,306 → 5.4 |
| drive500 | 7,838 → 877 (8.9×) | 617 → 448 | 66 → 12 | 10,296 → 1,639 (**6.3×**) | 16% | 4,876 → 788 |

For reference, the Phase 1 baseline on this host (stock, 10 runs; single-run noise 13–40%, A/A
medians within 6%): copy-out 4,862 / 5,337 / 5,551 / 5,887 / 5,162 and tick
5,130 / 5,532 / 5,787 / 7,813 / 6,751 (drift 500 / 2,000 / 10,000, contact, 25 worlds).

### Host B: the audit, on the audited clean-checkout build (`f72cf60`)

All seven scenes, 5 alternating rounds (`perf/results/phase4-final-*`):

| scene | copy-out stock → final | step | events | whole tick stock → final | tick spread (final) | alloc B/body/step stock → final |
|---|---|---:|---:|---|---:|---:|
| drift500 | 11,364 → 888 (12.8×) | 426 → 207 | 119 → 13 | 12,063 → 1,153 (10.5×) | 71% | 3,783 → 406 |
| drift2000 | 11,467 → 2,769 (4.1×) | 357 → 324 | 43 → 16 | 11,906 → 3,147 (3.8×) | 85% | 3,751 → 393 |
| drift10000 | 10,675 → 2,510 (4.3×) | 365 → 349 | 12 → 4 | 11,058 → 2,874 (3.8×) | 9% | 3,756 → 385 |
| contact | 12,077 → 3,212 (3.8×) | 3,178 → 2,942 | 588 → 302 | 15,998 → 6,540 (**2.4×**) | 19% | 4,274 → 840 |
| worlds25x19 | 9,890 → 878 (11.3×) | 1,600 → 296 | 429 → 50 | 13,590 → 1,932 (**7.0×**) | 46% | 4,431 → 691 |
| rest2000 | 9,001 → 514 (17.5×) | 188 → 138 | 25 → 6 | 9,241 → 676 (**13.7×**) | 101% | 3,306 → 7.2 |
| drive500 | 11,617 → 1,360 (8.5×) | 840 → 553 | 124 → 18 | 16,068 → 2,410 (**6.7×**) | 17% | 4,876 → 874 |

The drift scenes rerun with 10 alternating rounds, because host B is noisy
(`perf/results/phase4-drift10.*`):

| scene | copy-out stock → final | whole tick stock → final | final copy-out runs (sorted) |
|---|---|---|---|
| drift500 | 9,444 → 927 (**10.2×**) | 10,011 → 1,207 (**8.3×**) | 799 … 1,227 |
| drift2000 | 10,919 → 1,494 (**7.3×**) | 11,336 → 1,774 (**6.4×**) | 1,102 … 3,228 |
| drift10000 | 10,184 → 2,253 (**4.5×**) | 10,558 → 2,599 (**4.1×**) | 2,154 … 2,642 |

Control (`perf/results/phase4-control.*`, 5 rounds on host B): the audited build and the
Phase 3 build are equal within noise (drift10000 tick 2,685 vs 2,725). The difference between
the two tables comes from the host, not the build.

### Host dependence

The fork removes the embind data path: ≈ 5,600 ns of work per body became ≈ 50 ns (export plus
reading a record). What remains is vecs's ECS, which is object-graph traversal and allocation,
and therefore memory-latency-bound. Host B penalizes that much more than host A:
- vecs plus the adapter loop went from 74% to 84–86% of the final drift2000 tick;
- Box2D's share fell from 21% to 13–14%;
- stock (embind-bound) runs 1.3–1.4× slower on host B; final (ECS-bound) runs 1.2–2.3× slower.

Simulation results are identical on both hosts (checksums and per-step traces).

### Targets (from the Phase 2 plan)

| target | host A | host B (10 rounds) |
|---|---|---|
| copy-out ≥ 5× (drift 500 / 2,000 / 10,000) | **met**: 14.2× / 12.5× / 6.0× | met at 500 and 2,000 (10.2× / 7.3×), **not at 10,000 (4.5×)** |
| copy-out stretch 10× | met at 500 and 2,000 | met at 500 |
| whole tick ≥ 3× (drift scenes) | **met**: 10.6× / 10.1× / 5.2× | **met**: 8.3× / 6.4× / 4.1× |
| zero JS allocations per body on the read path | **met**: rest2000 3,306 → 5.4 B/body/step, all fixed per-step bytes (vecs's system runner, harness) | met (7.2 B/body/step, fixed per step) |
| contact-heavy, many-small-worlds | reported: 3.7× / 6.1× | reported: 2.4× / 7.0× |

At 10,000 bodies on host B, ≈ 98% of the remaining copy-out is JavaScript in vecs and the
adapter loop: vecs's `entity.set` flush and update routing, `entity.get`, and the loop's per-body
lookups. The fork's export is 1.2–1.8% of the tick. Getting past 5× there
needs the vecs-side changes in [docs/vecs-migration.md](docs/vecs-migration.md) → "What the fork
cannot remove".

## How "bit-identical" was proven

- **Stock build:** rebuilt from source, byte-identical to the npm 5.2.0 package (`.wasm` and
  `.mjs`, both flavours, built under CI's paths).
- **Fast path, by construction:** every `b2x_` function calls the same public Box2D C function(s)
  as the embind binding, with the same arguments. Floats cross as `f32`, rounding exactly like
  embind's conversion.
- **Differential test** (`perf/tests/fastpath-differential.mjs`): 5,473,096 fast-path values
  compared with `Object.is` against their embind twins, on deluxe (shared memory) and compat
  builds. It covers:
  - every move record and event record, every step;
  - every generated getter and the composites;
  - setters, by driving twin worlds through embind and through `b2x_` with the same random
    doubles and comparing full state bitwise every step;
  - a forced memory growth.
- **Checksums.** Seven scenes (vecs's two plus 10,000 bodies, a contact-heavy pile, 25 small
  worlds, bodies at rest and force-driven bodies), checked after every round with the scratch
  adapter **and** with unmodified vecs on the fork build.
- **Per-step traces** (`BENCH_TRACE=1`), stock against final: identical in all seven scenes. The
  build-flag variants were also traced against the previous build.
- **vecs suites:** `@vworlds/vecs-physics` 536/536, `@vworlds/vecs-phaser-server` 154/154,
  `@vworlds/vecs-phaser` 119/119, in both setups, every round, and again from a clean checkout.
  The only test changes are two tests that counted embind handles, rewritten to assert the
  fast-path contract.
- **Clean-checkout audit:** fresh clone, fresh build, fresh vecs checkouts from the patches;
  everything above re-run (`perf/prove.sh`).

## What changed in the fork

| change | effect (same-session, ns per body per step) |
|---|---|
| `b2x_World_ExportMoves`: one call per world-step writes every moved body's index, user data, transform, Box2D angle and velocities into a caller-owned buffer | copy-out per body ≈ 5,600 ns of embind work → ≈ 48 ns; round 1 alone made the tick 8.5–8.7× cheaper at 500–2,000 bodies |
| zero-copy contact, hit and sensor event spans | events 432 → 147 (contact), 278 → 40 (25 worlds) |
| profile-timer switch (Box2D patch, default on) | empty-world step 3,202 → 100 ns; 25-world step 4× cheaper |
| generated `b2x_Body_*` (60 functions) + composites | per call 190–4,100 ns → 23–135 ns; force-driven tick 1.7× cheaper |
| LTO for the Box2D library | small-world step 1.29× cheaper (Box2D-only benchmark) |
| exported `wasmMemory`, layout JSON (`sizeof`/`offsetof`), `box2d3-wasm/fastpath` helper and types | the API surface |

Adapter-side rounds (in the reference adapter, recommended in the migration guide):
- numeric component ids for `entity.get` (−11 to −17% tick);
- entity objects cached by body index (−6 to −10% on three scenes);
- reused per-step sets and no iteration of empty collections (allocation).

## Rounds (Phase 3)

| round | change | whole-tick effect vs previous round | counted |
|---|---|---|---|
| R1 | fast-path foundation, bulk move export, raw step | vs stock: 8.7× / 8.5× / 4.4× (drift 500 / 2,000 / 10,000), 3.3× contact, 3.4× 25 worlds | gain |
| R2 | event spans, reused sets | 25 worlds −8%, contact −4% | gain |
| R3 | profile timers off, no empty iteration | 25 worlds −33% | gain |
| R4 | per-body raw calls (pose-in, forces, impulses, kinematic, `bodyMotion`) | drive500 −42% | gain |
| R5 | numeric component ids in pose-out | −11% to −17% (4 scenes) | gain |
| R6 | build variants; LTO adopted | step −4% to −18%, tick within noise | < 5% |
| R7 | entity objects by body index | −6% to −10% (3 scenes) | gain |
| R8 | threaded step (opt-in) | identical results, slower in the tick here; dropped | < 5% |
| R9 | one span fetch and memory sync per events step | ±4% | < 5% (stop) |

## What the remaining cost is made of

Final profile, self time share of the tick:

| category | drift 2,000 | drift 10,000 | contact | 25 worlds | rest | drive |
|---|---:|---:|---:|---:|---:|---:|
| vecs ECS core | 44.8% | 54.7% | 24.7% | 54.5% | 15.6% | 48.6% |
| adapter loop (incl. inlined vecs `get`/`set`) | 28.8% | 25.7% | 16.9% | 25.1% | 44.8% | 17.5% |
| Box2D step + export | 21.0% | 17.2% | 56.2% | 13.5% | 37.6% | 29.3% |
| GC | 4.6% | 1.6% | 1.4% | 1.3% | 0.3% | 2.9% |
| embind + wasm allocator | 0.1% | 0.0% | 0.3% | 0.2% | 0.1% | 0.3% |

- **Box2D's step** is the simulation. Cheaper means different algorithms, solver settings or
  sub-steps, and therefore different results. Every result-neutral build option was tried.
- **vecs's `entity.set` path** (deferred command, `_set`, update routing, GC of the per-set
  literal and command) is required by vecs semantics: one modification per changed component.
- **vecs's `entity.get` compare** must stay exact.
- **vecs runs every system per world per tick** (≈ 28% of the 25-worlds tick).

All of these are vecs core, outside the fork. The fork's own remaining cost is the export,
≈ 1.8% of the tick.

## Left on the table

- Angle via `Math.atan2` in JS (to read Box2D's move events zero-copy): changes `Rotation` values (probe checksum `5420605b` vs `11c76fa7`). Dropped: changes results.
- Fast-math, FMA contraction, relaxed SIMD: not attempted; they change float results.
- Box2D solver settings, sub-step counts, broadphase or solver code changes: not attempted; they change results.
- Skipping the per-body `Body.type` component read via the export's type flag: can disagree with the component within a frame. Not done.
- Exporting only bodies whose state changed since the last step: changes vecs writes when a user write rounds to the body's current `f32` value. Not done.
- Fused step+export in the adapter: would read velocities before postStep systems. The API exists; the adapter keeps them separate.
- Cross-world batched step/export: ≤ 2 ns/body, needs vecs phase reordering. Not built.
- Threaded step (enkiTS, 1–4 workers): identical results; slower inside the vecs tick on a shared 4-vCPU host. Dropped; may pay off on many-core servers with very large worlds.
- `-sSTACK_OVERFLOW_CHECK=0`: ~1% on the step beyond LTO. Not adopted, to keep upstream's safety check.
- Reading Box2D's internal body arrays in the export: about half of its 1.8%. Not done, to avoid private headers.
- Faster embind handle construction: changes handle semantics (`$$` attributes) and only helps unmigrated call sites. Not done.
- Allocator swap (emmalloc/mimalloc): not measured; malloc is no longer on the per-step path.
- Other optimisation levels (`-O4`, `-Oz`): not tried.
- vecs ECS write, read and per-system costs (45–55% of moving ticks): vecs API and core work, outside the fork.

## Publishing

**Version: `@vworlds/box2d3-wasm` 5.2.0-vworlds.1. Not yet in a registry.** This session has no
npm credentials (`npm whoami`: "need auth"). GitHub Actions are disabled on the fork, and a
`workflow_dispatch` workflow must exist on the default branch. So the package could not be
published to npmjs.org or GitHub Packages from here.

What is ready:
- **Tarball:** [`release/vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz`](release/), `npm pack` of the
  audited clean-checkout build (24 files, 470.5 kB, SHA-256 in `release/SHA256SUMS`). It installs
  and runs under both the scoped name and the `box2d3-wasm` alias (smoke test: fast-path values
  equal embind's). It can be installed today from this repository:

  ```bash
  npm install "box2d3-wasm@https://github.com/vworlds/box2d3-wasm/raw/{{RELEASE_COMMIT}}/release/vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz"
  ```

- **To publish to npm** (needs publish rights on the `@vworlds` scope):
  `npm publish release/vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz` (the package sets
  `publishConfig.access: public`).
- **Or via CI:** enable Actions on `vworlds/box2d3-wasm`, merge
  `.github/workflows/publish-vworlds.yml` to the default branch, add an `NPM_TOKEN` secret, then
  run "Publish @vworlds/box2d3-wasm" with `action=publish`, `registry=npmjs`. `registry=github`
  publishes to GitHub Packages with the workflow token instead. The workflow rebuilds both
  flavours, checks the generated code and runs the differential test before publishing.
- **vecs then depends on** `"box2d3-wasm": "npm:@vworlds/box2d3-wasm@5.2.0-vworlds.1"`, or on the
  tarball URL above until then. No import changes are needed.

## Reproduce

[CHECKPOINT.md](CHECKPOINT.md) → "How to rebuild and re-run everything from a clean checkout"
(toolchain, both builds, the vecs checkouts via `perf/setup-vecs-checkout.sh`, `perf/prove.sh`,
`perf/bench/run.mjs`).
