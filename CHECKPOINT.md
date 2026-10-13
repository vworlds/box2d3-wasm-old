# CHECKPOINT: box2d3-wasm fork for a cheaper vecs physics tick

Fork: `vworlds/box2d3-wasm`, branch `claude/youthful-edison-uyuukr`, based on upstream
box2d3-wasm **5.2.0** (`ee2a63b`). Reference consumer: `vworlds/vecs` (read-only; issue #273, PR #274).

## Status

| Phase | State |
| --- | --- |
| 1. Setup and baseline | **done** (BREAKPOINT A) |
| 2. Plan and API design | **done** (BREAKPOINT B) |
| 3. Iterate | **done** (BREAKPOINT C): 9 rounds, stopped after R8 and R9 each gained < 5% |
| 4. Final analysis | **done**: audit passed; report, API reference, patches, migration guide written; release tarball ready; registry publish pending credentials |

Hard rule for every later phase: results stay bit-identical to stock 5.2.0. Proof per build: the
seven scene checksums (five from Phase 1, two added in Phase 2), the fast-path differential test,
plus vecs's real-WASM suites (`motion_accuracy.test.ts` among them). See §2.5.

---

## Phase 1 results

### 1.1 Stock build is byte-identical to the published package

- Toolchain: emsdk **4.0.18** (as in `.github/workflows`), Node 24.15.0 for running. emcc's
  `--emit-tsd` breaks with TypeScript 6 (`TS5101 outFile deprecated`), so put TypeScript **5.9**
  first on `PATH` when building (CI got TS 5 from `npm i -g typescript` at the time).
- Built `FLAVOUR=deluxe` and `compat`, `TARGET_TYPE=Release`, with the repo's own scripts.
- Built in `/home/user/...`, the `.mjs` and `.d.ts` are byte-identical to npm `box2d3-wasm@5.2.0`.
  The `.wasm` differs only in embedded `__FILE__`/include path strings (`/home/runner/work/...`
  vs. the local path), so ~100 bytes of data.
- Rebuilt under CI's exact paths (`/home/runner/work/box2d3-wasm/box2d3-wasm` and
  `EM_CACHE=/home/runner/work/_temp/281a1663-ccee-4526-a311-3d27de0b31ad/emsdk-main/upstream/emscripten/cache`):
  **`Box2D.deluxe.wasm`, `Box2D.compat.wasm`, `Box2D.deluxe.mjs`, `Box2D.compat.mjs` are all
  byte-identical (`cmp`) to the npm package.** The build is reproducible; our stock baseline is the
  published artifact.
- In Node, `entry.mjs` loads the **deluxe** flavour (SIMD + pthreads); vecs creates worlds with the
  default `workerCount` (1), so the step runs single-threaded.
- The checksums of the stock build from source equal those of the npm package in all five scenes
  (table below).

### 1.2 Baseline (stock 5.2.0, vecs at `2d58dd7` = PR #274's benchmark commit with unmodified vecs code)

Harness: `perf/bench/vecs-tick.ts` (one scene per fresh process). `drift500` / `drift2000` are
exactly vecs's `bench/physics-pose-out.ts` scene and reproduce its checksums `11c76fa7` /
`a66a94ee`. Added scenes:

- `drift10000`: same scene, 10,000 bodies (300 warmup + 300 measured steps).
- `contact`: 1,000 dynamic circles/boxes piled in a static box under gravity, sleep disabled, a
  kinematic paddle stirring the pile; ContactEvents on 1/4, HitEvents on 1/8, Detectable on 1/2 of
  the shapes plus one sensor strip. Per step ≈ 26 contact begins, 26 ends, 11 hits, 1.2 sensor
  events. Checksum hashes final poses and velocities **plus every event (other entity, hit point,
  normal, speed) of every measured step**: `5db7f953`.
- `worlds25x19`: 25 independent vecs worlds × 19 drifting bodies (Space Rocks shape):
  `a8a0671e`.

All bodies carry Position, Rotation, LinearVelocity and AngularVelocity. 30 Hz, 4 substeps.
Timings are **ns per body per step**: copy-out = `PhysicsPoseSyncOut` system, step =
`PhysicsStep` system, whole tick = `world.progress` of all worlds. Medians of 10 fresh-process runs
(5 rounds alternating the npm package and the from-source build, ABBA order, scenes rotated):

| scene | bodies | copy-out | step | events | whole tick | noise (tick max/min) | A/A npm vs src | alloc / step | alloc / body / step | checksum |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 500 | 4862 | 203 | 30 | 5130 | 35% | +1.0% | 1.89 MB | 3782 B | 11c76fa7 |
| drift2000 | 2000 | 5337 | 175 | 12 | 5532 | 13% | -1.2% | 7.50 MB | 3751 B | a66a94ee |
| drift10000 | 10000 | 5551 | 226 | 5 | 5787 | 40% | +5.4% | 37.76 MB | 3776 B | 70623967 |
| contact | 1000 | 5887 | 1692 | 240 | 7813 | 25% | -3.5% | 4.27 MB | 4274 B | 5db7f953 |
| worlds25x19 | 475 | 5162 | 840 | 195 | 6751 | 20% | +6.0% | 2.10 MB | 4429 B | a8a0671e |

Noise: this is a shared 4-vCPU VM. Single runs of the same build vary 13–40% (max/min), and the
A/A medians of two identical builds differ by up to 6%. Only differences well above ~10% are
meaningful from a single round; later comparisons use ≥5 alternating rounds and medians.
Allocation is deterministic (identical across rounds): bytes of JS heap growth per step over a
GC-free window (`BENCH_MODE=alloc`, 1 GB semi-space, separate runs because that flag distorts timing).

Raw data: `perf/results/phase1-baseline.{jsonl,txt}`, `perf/results/phase1-alloc.{jsonl,txt}`.

### 1.3 CPU profile: where the tick goes

Profiled with `node --cpu-prof --cpu-prof-interval 250` against a stock build linked with
`--profiling-funcs` (wasm function names). That build has the same 1,321 functions, the same
`.mjs` apart from minified import names, and the same checksums; binaryen orders types and
functions differently, so it is used for attribution only. Only samples under the measured tick
loop count. Categories: **embind-js** = JS glue in `Box2D.deluxe.mjs`; **embind-wasm** = C++
binding thunks in wasm; **wasm-alloc** = malloc/free + the allocator's pthread mutex (embind's
temporaries); **box2d** = Box2D's own C code; **vecs-physics** = the adapter; **vecs** = ECS core.

Self time, share of the whole tick (GC samples sit at the profile root, outside any JS stack;
those inside the tick loop's time window are counted as `gc` — corrected in Phase 2):

| category | drift500 | drift2000 | drift10000 | contact | worlds25x19 |
|---|---:|---:|---:|---:|---:|
| embind-js | 59.8% | 59.6% | 57.6% | 44.3% | 54.3% |
| embind-wasm | 6.2% | 4.8% | 5.8% | 4.0% | 5.5% |
| wasm-alloc | 5.2% | 4.8% | 4.9% | 3.7% | 4.0% |
| gc | 1.6% | 1.2% | 1.2% | 1.5% | 0.9% |
| **embind / marshalling / GC total** | **72.8%** | **70.4%** | **69.6%** | **53.4%** | **64.7%** |
| box2d | 5.3% | 4.4% | 5.3% | 22.1% | 5.6% |
| vecs-physics | 8.0% | 7.7% | 9.5% | 8.3% | 8.8% |
| vecs | 11.7% | 15.7% | 13.8% | 14.7% | 15.7% |
| engine (V8 internals) + harness | 2.2% | 1.8% | 1.8% | 1.5% | 5.2% |

Note on "copy-out": vecs runs every system inside `world.defer(...)` and drains the command queue
in `endDefer()`, so the deferred flush of pose-out's `entity.set` calls runs **inside**
`PhysicsPoseSyncOut._run`. The copy-out timer (and vecs's own benchmark number) therefore includes
the flush. The profile shows the flush under "other", because its frames are not under
`pose_out.js`.

By system (system totals include GC as its own row; the indented category rows come from the
first, GC-free pass and are within ±0.3 points):

| system / category | drift500 | drift2000 | drift10000 | contact | worlds25x19 |
|---|---:|---:|---:|---:|---:|
| **PhysicsPoseSyncOut** | **86.5%** | **85.2%** | **89.1%** | **62.9%** | **70.9%** |
| &nbsp;&nbsp;embind-js + embind-wasm + wasm-alloc | 71.6% | 69.8% | 69.1% | 50.8% | 57.9% |
| &nbsp;&nbsp;vecs-physics (loop, compares) | 7.8% | 7.7% | 9.6% | 7.1% | 6.0% |
| &nbsp;&nbsp;vecs (`entity.get`, `entity.set` enqueue) | 5.1% | 5.7% | 8.2% | 3.6% | 5.5% |
| &nbsp;&nbsp;box2d (`b2Atan2`, velocity getters) | 1.7% | 1.4% | 1.7% | 1.1% | 1.1% |
| **PhysicsStep** | **4.3%** | **3.2%** | **3.8%** | **21.5%** | **12.6%** |
| &nbsp;&nbsp;box2d | 3.6% | 3.0% | 3.8% | 21.4% | 4.6% |
| &nbsp;&nbsp;embind + `b2GetTicks`→`performance.now` (engine) | 0.7% | 0.2% | 0.0% | 0.4% | 8.0% |
| **PhysicsEvents** | **0.4%** | **0.2%** | **0.1%** | **3.1%** | **2.7%** |
| **other** (deferred flush, empty systems: vecs) | **7.2%** | **10.3%** | **5.8%** | **11.0%** | **12.8%** |
| **(garbage collector)** | **1.6%** | **1.2%** | **1.2%** | **1.5%** | **0.9%** |

Top self-time functions (drift2000; the others are in `perf/results/profiles/stock-*.txt`):

| share | function | what it is |
|---:|---|---|
| 43.5% | `makeClassHandle` (embind) | builds every class handle with `Object.create(proto, {$$: {value, writable}})`, V8's slow descriptor path, plus a `count: {value: 1}` box |
| 7.1% | `_executeCommand` (vecs) | deferred `entity.set` flush |
| 5.7% | `get` (embind property getter) | `move.transform`, `.p`, `.q`, `.x`… |
| 4.5% | `RegisteredPointer_fromWireType` (embind) | wraps returned pointers into handles |
| 4.5% | `get` (vecs `entity.get`) | four pose components per body |
| 4.2% + 3.5% | `writePose`, pose-out loop (vecs-physics) | compares and writes |
| 2.6% | `toWireType` (embind value_object) | marshalling `bodyId` / `worldId` arguments (`for…in` over fields) |
| 2.0% | `validateThis` (embind) | `this` check on every method/getter |
| 3.2% | `pthread_mutex_lock` + `malloc` (wasm) | value_object temporaries and by-value returns |

Profile findings that drive Phase 2:

1. **Handle creation dominates.** About 6 handles per body per step (`GetMoveEvent`, `.transform`,
   `.p`, `.q`, `b2Body_GetLinearVelocity`, plus `.bodyId` as a value-object read). Each costs
   ~420–460 ns, and most of the **~3.8 KB allocated per body per step** comes from them.
2. **value_object marshalling.** Every `b2BodyId` / `b2WorldId` argument costs a wasm `malloc`,
   one wasm call per field, and a `free` (`toWireType` + `rawConstructor` + setters + destructor);
   every returned id costs a getter call per field plus a `free`. A scalar `bodyId` call
   (`b2Body_GetAngularVelocity`) costs ~130 ns, almost all marshalling.
3. **Box2D itself is small.** On no-contact scenes the step is 3–4% of the tick. On the contact
   scene it is 21%, and it is the only cost that must remain.
4. **Many small worlds pay fixed per-world costs:** the `b2World_Step` crossing, ~2.0 µs per call on
   an empty world. That includes Box2D's `b2GetTicks` profiling timers, which call out to JS
   `clock_time_get` → `performance.now()` several times per step (≈ 4% of the worlds25x19 tick;
   timing-only, never feeds results). Also the event headers, and vecs running empty systems
   (13% "other").
5. **vecs itself (~12–16%)**, mostly the deferred `entity.set` flush and `entity.get`. A fork cannot
   remove that cost, but the adapter's design decides how much of it is paid (e.g. no `set`
   for unchanged values, which vecs already does).

### 1.4 Every Box2D call vecs makes per step, with its marshalling cost

Per-op prices from `perf/bench/embind-ops.mjs` (stock, 2,000-body world; two runs agree to ~5%).
"handle" means an embind class handle: JS object + `$$` record + wasm-side copy for by-value.

**Every step, per world (fixed):**

| site | call | marshalling | ns / call |
|---|---|---|---:|
| `core/step.ts` | `b2World_Step(worldId, dt, subSteps)` | worldId value_object (malloc + 2 setters + free); includes Box2D's fixed per-step work and `b2GetTicks` JS calls | 1,990 (empty world) |
| `body/pose_out.ts` | `b2World_GetBodyEvents(worldId)` → handle, `.delete()` | worldId marshal + by-value struct copy + handle | 564 |
| | `bodyEvents.moveCount` | getter + `validateThis` | 31 |
| `events/publish.ts` | `b2World_GetContactEvents(worldId)` + 3 counts + delete | as above | 731 |
| | `b2World_GetSensorEvents(worldId)` + 2 counts + delete | as above | 680 |

**Every step, per moved body** (`PhysicsPoseSyncOut`; all awake bodies are in the move events):

| call | marshalling | ns |
|---|---|---:|
| `bodyEvents.GetMoveEvent(i)` + `move.delete()` | by-value copy (malloc) + handle | 461 |
| `move.bodyId` | value_object read: 3 getter calls + free + JS object | 143 |
| `move.transform` | reference handle | 418 |
| `transform.p` | reference handle | 414 |
| `transform.q` | reference handle | 444 |
| `p.x`, `p.y` | 2 float getters | 2 × 33 |
| `q.GetAngle()` | method → `b2Rot_GetAngle` (`b2Atan2`) | 23 |
| `b2Body_GetLinearVelocity(bodyId)` + `.x/.y` + delete (if LinearVelocity present) | bodyId marshal + by-value b2Vec2 + handle | 747 |
| `b2Body_GetAngularVelocity(bodyId)` (if AngularVelocity present) | bodyId marshal | 132 |
| **sum of crossings, fully populated body** | about 6 handles, 2 bodyId marshals | **≈ 2,850** |

The measured copy-out is ~4,900–5,600 ns per body. The rest is GC of the ~3.8 KB, the vecs
`get`/`set` calls and the loop.

**Every step, per event** (`PhysicsEvents`; only shapes with opt-in components emit):

| call | marshalling |
|---|---|
| `GetBeginEvent(i)` + delete | handle (class_) + `shapeIdA`, `shapeIdB` value_object reads (~145 ns each) |
| `GetEndEvent(i)` | value_object (by value; 2 nested shapeIds) |
| `GetHitEvent(i)` + delete | handle + 2 shapeId reads + `point`, `normal` reference handles (~420 ns each) + 5 float getters |
| sensor `GetBeginEvent(i)` / `GetEndEvent(i)` | value_object with 2 nested shapeIds |

Also, `PhysicsEvents` allocates three `Set`s per step (vecs-side).

**Only when something changes (not per step in steady state):**

| site | call | ns |
|---|---|---:|
| `body/pose_in.ts` (user writes Position / Rotation) | `b2Body_GetRotation`/`GetPosition` (handle) + `b2MakeRot` (handle) + `vec.Set` + `b2Body_SetTransform` | ≈ 1,500–2,000 |
| `body/pose_in.ts` (user writes velocities) | `vec.Set` (400: it returns a handle) + `b2Body_SetLinearVelocity`; `b2Body_SetAngularVelocity` | 1,430; 243 |
| `forces/gather.ts` (per entity with non-zero Force/Torque, every step while set) | `vec.Set` + `b2Body_ApplyForceToCenter`; `b2Body_ApplyTorque` | 588; ~130 |
| `forces/impulses.ts` (per impulse) | `vec.Set` + `b2Body_ApplyLinearImpulseToCenter`; `b2Body_ApplyAngularImpulse` | ~590; ~130 |
| `kinematic/targets.ts` (per kinematic body with a target, every step) | `b2Body_GetType` + `GetPosition` (handle) + `GetRotation` (handle) + `GetAngle` + `SetLinearVelocity` + `SetAngularVelocity` (+`SetAwake`) | ≈ 3,000 |
| `body/mass.ts` (dirty bodies only) | `ApplyMassFromShapes`, `GetMassData` (handle), `ComputeAABB` (handle), `SetMassData` | rare |
| `core/reaper.ts`, `*/lifecycle.ts` | create/destroy bodies, shapes, joints | rare |
| `vecs-phaser-server/dead_reckoned.ts` per DR entity | `isAwake` → `b2Body_IsAwake` when the pose is unchanged; at baseline writes `bodyMotion` → `IsAwake`, `GetLinearVelocity` (handle), `GetAngularVelocity`, `GetLinearDamping`, `GetAngularDamping`, `GetLocalCenterOfMass` (handle), `GetMass`, `GetGravityScale` | 125; ≈ 2,400 per baseline |

---

## Decisions taken in Phase 1

- Baseline vecs = commit `2d58dd7` of vecs `perf/273-pose-out-bulk-read` (the PR's benchmark on
  unmodified vecs code). The PR's `c61c2f0` supported-API tweak is not the baseline.
- Timing runs use default V8 flags. Allocation is measured in separate runs.
- The harness lives in the fork under `perf/` (not published: the npm package is `box2d3-wasm/`).
- `shell/1_build_wasm.sh` gained an `EXTRA_EMCC_OPTS` hook. With it empty the output is
  byte-identical (verified with `cmp`).

---

## Phase 2: plan and API design

### 2.0 New evidence gathered for the design (measurement-only probes)

The probes live in `perf/spikes/` (`raw-crossing.mjs`, `step-fixed-cost.mjs`,
`ideal-reader.pose_out.js`). The ideal-reader probe replaces the compiled `pose_out.js` in a *copy*
of the built vecs (header comment says how). It uses a private embind pointer and `Math.atan2`, so
it is never shipped and its checksums differ from stock. Same-session numbers; the host drifted between sessions (stock drift2000 copy-out was
5,337 ns in Phase 1 and 8,202–8,419 ns during Phase 2), so only ratios within one alternating
session are compared.

| question | finding |
|---|---|
| Price of a raw (non-embind) wasm export call | **9 ns** (`_free(0)`), vs ~130 ns for an embind call taking a `bodyId` and ~420–460 ns for one returning a class handle. A typed-array read is a few ns. |
| What happens to views when memory grows? | Deluxe memory is a `SharedArrayBuffer`: after growth `Module.HEAPU8` is replaced (in the growing thread only), views created before growth **stay valid for their old range** (reads and writes hit the same memory), and new regions need a new view. Compat (non-shared) detaches the old buffer, so old views become length 0. `wasmMemory` is not exported today. |
| How fast can copy-out get if the data were free? | Ideal-reader probe: move events read straight from wasm memory (no handles, `Math.atan2` as a timing proxy for a wasm-computed angle). Copy-out **6,410 → 622 ns** (drift500, 10.3×) and **8,202 → 724 ns** (drift2000, 11.3×). Whole tick **6,723 → 909** (7.4×) and **8,502 → 927** (9.2×). 3 alternating rounds each. |
| What does the ideal path still allocate? | drift2000: **449 B/body/step**, all from vecs's `entity.set` (the `{x, y}` literal, the deferred command, update routing), because Position and Rotation change every step. rest2000 (no writes): 25 B/body/step, from V8 boxing fractional doubles passed to a non-inlined helper. That is avoidable with an in-place compare. |
| Why is a small-world step so expensive? | Profile of `b2World_Step` on 0- and 19-body worlds: **≈70% is Box2D's profiling timers**. `b2GetTicks` → `clock_gettime` → JS imports `_clock_time_get` / `_emscripten_get_now` → `performance.now()`, plus BigInt conversion and a heap-view check, many times per step (per stage, per substep). In the worlds25x19 tick this clock chain is **8.5%** (≈575 ns/body); in the single-world scenes 0.2–0.3%. |
| Do the timers ever affect results? | No. All 44 call sites write `world->profile.*` (`physics_world.c`, `solver.c`, `island.c`) or the `B2_SNOOP_TOI_COUNTERS` statistics (`distance.c`). |
| Box2D facts used by the design | Move events are written in `b2FinalizeBodiesTask` and already carry `body->userData`. Embind's `GetAngle` is `b2Atan2(s, c)`, i.e. `b2Rot_GetAngle`. The glue never touches body or shape `userData` (only callback contexts). vecs EIDs are safe integers from id pools (entities from 1000, recycled), so normally `< 2^32`. Box2D's `test_determinism.c` asserts an identical hash for 1–5 workers. |

Two scenes were added to the harness to make the read path and the force path measurable:

| scene (Phase 2 session, stock, 3 rounds × npm/src) | copy-out | step | forces | whole tick | alloc / body / step | checksum |
|---|---:|---:|---:|---:|---:|---|
| `rest2000`: 2,000 awake bodies at rest, sleep off; all in the move events every step, nothing changes | 6,498 | 139 | – | 6,681 | 3,306 B (no writes at all) | `17fc310b` |
| `drive500`: 500 drifting bodies with a constant Force and Torque | 6,973 | 576 | 1,484 | 9,157 | 4,877 B | `fd7cc876` |
| `drift2000` in the same session (host-speed reference) | 8,419 | 255 | – | 8,725 | 3,751 B | `a66a94ee` |

Noise in that session: 1–17% max/min. Raw data: `perf/results/phase2-extra-*`.

### 2.1 The fork's data API ("fast path", prefix `b2x_`)

All of it is **additive**: the embind API stays byte-for-byte as it is, so vecs can migrate one
call site at a time. The fast path is plain C exports (`EMSCRIPTEN_KEEPALIVE`) taking and
returning only `i32`/`f32`, called as `Module._b2x_*`. That costs ~9 ns per call with no
marshalling, no handle and no allocation. Every function calls the same public Box2D C function(s)
that the embind binding calls, with the same arguments, at the moment the caller chooses. That is
why its results are identical by construction (proof in §2.5).

**A. Ids.** Box2D ids are packed into 32-bit integers, so no value_object marshalling:

- world: `w = index1 | generation << 16` (both `uint16`);
- body, shape, chain, joint: two arguments `(index1, rev)` with `rev = world0 | generation << 16`;
- JS helpers `fp.world(worldId)`, `fp.rev(id)` convert the embind id objects vecs already holds.
  The adapter stores `index1`/`rev` next to `Body._bodyId` once, at creation.

**B. Layout descriptor, never handwritten.** `const char* b2x_GetLayout(void)` returns a JSON
string built once from an X-macro list of `sizeof` / `offsetof` expressions. It covers every
struct the fast path exposes: the export record, Box2D's own `b2BodyMoveEvent`,
`b2ContactBeginTouchEvent`, `b2ContactEndTouchEvent`, `b2ContactHitEvent`,
`b2SensorBeginTouchEvent`, `b2SensorEndTouchEvent`, the span headers, the motion and pose
out-structs. It also carries a `version`. A `static_assert` requires every exposed field to be
4-byte aligned, so JS can address fields as `base + offset/4` in `Float32Array`/`Int32Array`
views. JS parses the layout once at preload; nothing else in JS hardcodes an offset.

**C. Bulk move export, the copy-out replacement.**

```c
typedef struct b2xMove {   // 48 bytes; real offsets come from b2x_GetLayout()
  int32_t  bodyIndex;      // bodyId.index1
  uint32_t rev;            // bodyId.world0 | bodyId.generation << 16
  uint32_t userData;       // (uint32_t)(uintptr_t) body user data (see E)
  uint32_t flags;          // bit0 fellAsleep, bits1-2 b2BodyType, bit3 body valid
  float x, y;              // transform.p
  float c, s;              // transform.q
  float angle;             // b2Rot_GetAngle(q): the same b2Atan2(s, c) embind's GetAngle runs
  float vx, vy, w;         // b2Body_GetLinearVelocity / b2Body_GetAngularVelocity (flag)
} b2xMove;

int b2x_World_GetMoveCount(int world);
int b2x_World_ExportMoves(int world, b2xMove* out, int capacity, int flags);
//   flags: B2X_EXPORT_VELOCITY (1), B2X_EXPORT_DYNAMIC_ONLY (2)
//   Writes one record per move event, in Box2D's event order (the order vecs iterates today).
//   Returns the number of records; if it exceeds `capacity`, only `capacity` were written and
//   the caller grows its buffer and calls again (events stay valid until the next step).
void b2x_World_GetMoveEventSpan(int world, b2xSpan* out);   // zero-copy b2BodyMoveEvent[]
```

The buffer is caller-owned wasm memory: the adapter `_malloc`s it once, grows it rarely, and
reads it through whole-memory typed views. In one crossing per world per step, JS gets the
position, angle, both velocities, the body index and the user data of every moved body, with
zero allocations. `B2X_EXPORT_VELOCITY` reads velocities with the same public getters vecs calls
today, at the same simulation moment (after the step, before any other mutation).

**D. Step and event spans.**

```c
void b2x_World_Step(int world, float dt, int subSteps);
int  b2x_World_StepAndExportMoves(int world, float dt, int subSteps,
                                  b2xMove* out, int capacity, int flags);   // fused variant
typedef struct b2xSpan { uint32_t ptr; int32_t count; } b2xSpan;
typedef struct b2xContactSpans { b2xSpan begin, end, hit; } b2xContactSpans;
typedef struct b2xSensorSpans  { b2xSpan begin, end; } b2xSensorSpans;
void b2x_World_GetContactSpans(int world, b2xContactSpans* out);
void b2x_World_GetSensorSpans(int world, b2xSensorSpans* out);
```

Contact, sensor and hit events need no copy. The spans point into Box2D's own event arrays
(valid until the next step or world mutation), and JS reads `shapeIdA.index1`, `point.x`,
`approachSpeed`… at layout offsets. One crossing replaces the header handle, three count getters
and a handle (or value object) per event.

**E. Integer user data.** `b2x_Body_SetUserData(i, r, u32)` / `b2x_Shape_SetUserData(i, r, u32)`
store an integer in Box2D's existing `void* userData`; move records carry it (Box2D copies it into
every move event). vecs can store the EID there and skip its reverse map when `eid < 2^32`, falling
back to `bodyIndex` otherwise. This is optional: the reverse `ArrayMap` lookup costs ~3.5 ns.

**F. Scalar / out-parameter variants of every per-body getter and setter.** These are
**generated** from `box2d.h` by `tools/gen_fastpath.py`, for all 65 `b2Body_*` functions.
Scalars pass and return as-is. `b2Vec2`/`b2Rot`/`b2Transform`/`b2AABB`/`b2MassData` arguments
are flattened to floats, and returns go to a caller out-pointer. Id arrays (`GetShapes`,
`GetJoints`) become packed `(index1, rev)` pairs, and names and contact data are skipped. The
TypeScript declarations are generated in the same pass. A few hand-written composites each
reproduce, in one crossing, an exact call sequence vecs makes today:

| composite | equivalent to (today, in vecs) |
|---|---|
| `b2x_Body_SetPosition(i, r, x, y)` | `b2Body_SetTransform(id, {x, y}, b2Body_GetRotation(id))` (pose-in Position) |
| `b2x_Body_SetAngle(i, r, angle)` | `b2Body_SetTransform(id, b2Body_GetPosition(id), b2MakeRot(angle))` (pose-in Rotation) |
| `b2x_Body_GetPose(i, r, out)` | position, rotation and `b2Rot_GetAngle` (kinematic targets) |
| `b2x_Body_GetMotion(i, r, out)` | the 8 getters of `physics(world).bodyMotion` (dead reckoning) |

Float arguments cross the boundary as `f32`, which rounds exactly as embind's float conversion
does (round to nearest even from the JS double). So `vec.Set(x, y)` + `SetLinearVelocity` and
`b2x_Body_SetLinearVelocity(i, r, x, y)` hand Box2D the same bits.

**G. Exported memory and the growth rule.** The build exports `wasmMemory` (plus `HEAPF32` /
`HEAP32`). The rule, documented in the API reference:

1. *Calls that may grow memory:* creating or destroying worlds, bodies, shapes, joints and
   chains; `b2World_Step` / `b2x_World_Step` (contact, pair and island arrays grow); any embind
   call that returns a class by value or marshals a value_object; `_malloc`.
2. *Calls that never grow memory:* every `b2x_Body_*` / `b2x_Shape_*` getter and setter,
   `b2x_World_ExportMoves` into a caller buffer, `b2x_World_GetMoveCount`, `b2x_World_Get*Spans`,
   `b2x_GetLayout` after the first call.
3. *JS:* keep whole-memory views; after a call from list 1 and before reading memory, call
   `fp.sync()`. It compares `memory.buffer` with the views' buffer and rebuilds them on change
   (deluxe: a new `SharedArrayBuffer` object after growth; compat: the old buffer is detached).
   One check per step costs ~40 ns.

**H. JS helper `box2d3-wasm/fastpath`** (new package export with `.d.ts`):
`createFastPath(module)` returns `{ layout, memory, f32, i32, u32, sync(), world(id), rev(id),
alloc(bytes), free(ptr) }`, plus a small move-exporter that owns a growable record buffer. The
helper has no per-call allocation. The vecs hot loop reads `fp.f32` / `fp.i32` directly.

**I. Profile-timer switch.** A ~20-line patch to `box2d/src/timer.c` (emscripten branch), kept as
`box2d3-wasm/patches/box2d/0001-runtime-switch-for-profile-timers.patch` and applied idempotently
by `shell/0_build_makefile.sh`. It adds `b2SetProfileTimers(bool)`, exported as
`b2x_SetProfileTimers(int)`. When off, `b2GetTicks` returns 0 and `b2GetMilliseconds*` return 0
without reading the clock, so `b2World_GetProfile` reports zeros. The default stays **on**
(stock behavior); vecs turns it off at preload. It is the only patch to Box2D's C sources.

**J. Many small worlds.** `b2x_Worlds_Step(const int32_t* worlds, int n, float dt, int subSteps)`
and a matching batched export would save `n−1` crossings (~10 ns each) per call type per tick, at
most ~2 ns/body. Using them would also force vecs to step every world inside one world's phase,
reordering phases. So this is **deferred**: implemented only if, after Round 3, per-world crossings
are still more than 5% of the worlds25x19 tick. The fixed per-world costs that matter (timers,
three event headers, embind step marshalling) are removed per world by C, D and I instead.

**K. Legacy embind speed-up (optional).** `makeClassHandle` builds every handle through
`Object.create(proto, {$$: {value, writable: true}})`, V8's slow descriptor path (32–44% of the
stock tick). A post-processing patch of the generated JS could speed up every not-yet-migrated
call site. It is acceptable only if `$$` keeps its exact attributes (non-enumerable,
non-configurable, writable); for example, `JSON.stringify(handle)` must still give `"{}"`.

### 2.2 Ideas: expected gain, risk, effort, proof

Gains are tied to the Phase 1 profile lines (drift2000 numbers in ns/body/step of a 5,532 ns tick
unless stated).

| # | idea | profile lines it removes | expected gain | risk | effort | bit-identity proof |
|---|---|---|---|---|---|---|
| 1 | Bulk move export (C) + typed-array pose-out loop | In `PhysicsPoseSyncOut`: `makeClassHandle` 43.5% (2,406), embind `get` 5.7% (315), `RegisteredPointer_fromWireType` 4.5% (249), `toWireType` 2.6% (144), `validateThis` 2.0% (111), `fromWireType` 1.2% (66), embind-wasm 4.8% (266), wasm-alloc 4.8% (266), GC 1.2% (66), most of the 7.7% loop: **≈3,900 ns/body** | copy-out ~7–10×, tick ~5–8× on drift (the probe reached 10–11× / 7–9×); rest2000 read path ~15×, allocation → 0 | low: public getters in C, same order and moment | M | differential test (every field of every body every step vs embind, `Object.is`), 7 checksums, vecs suites |
| 2 | Raw step + zero-copy contact/sensor/hit spans | `b2World_Step` worldId marshal; `GetBodyEvents` 564, `GetContactEvents` 731, `GetSensorEvents` 680 ns per world-step; per event: begin handle + 2 shapeIds ≈ 750 ns, hit ≈ 1,600 ns (contact `PhysicsEvents` 3.1% ≈ 240 ns/body; worlds25x19 2.7% + headers) | contact events 240 → ~60 ns/body; worlds25x19 −~100 ns/body of per-world headers | low | M | contact checksum hashes every event (other entity, hit point, normal, speed) every step; differential test of spans vs embind events |
| 3 | Profile-timer switch | clock chain: worlds25x19 8.5% of tick (≈575 ns/body, ~70% of its step); 0.2–0.3% elsewhere | worlds25x19 step 840 → ~250 ns/body | low: only `world->profile` and TOI stats read the timers; profile reads 0 when off | S | 7 checksums with the switch off and on; `BENCH_TRACE=1` per-step trace |
| 4 | Generated scalar/out-param body API + composites; migrate pose-in, forces, impulses, kinematic targets, `bodyMotion`, `isAwake` | drive500 forces 1,484 ns/body (16% of its tick); per op: `bodyMotion` ≈2,400 → ~40, `ApplyForceToCenter`+`vec.Set` ≈1,000 → ~15, pose-in ≈1,500–2,000 → ~20, kinematic target ≈3,000 → ~60 ns | drive500 tick −~1,400 ns/body; ~0 on the other scenes (change-driven paths) | low | M (generator) | differential setter test: two identical worlds driven through embind and through `b2x_`, full state compared bitwise every step; drive500 checksum |
| 5 | Integer user data in move records | reverse `ArrayMap` lookup ~3.5 ns | ~0 (completeness) | low; EIDs ≥ 2^32 need the index fallback | S | covered by 1 |
| 6 | Fused step+export; batched multi-world calls | ~10 ns per crossing | ≤ 2 ns/body | fused export reads velocities before any postStep mutation; batching reorders vecs phases | S | 1, 2 |
| 7 | Faster embind handle construction (legacy) | `makeClassHandle` on unmigrated paths | stock-adapter copy-out maybe −30–40%; 0 on migrated paths | medium: embind internals and visible handle semantics | M | vecs suites with the *unmodified* adapter; checksums |
| 8 | Build variants: `-sSTACK_OVERFLOW_CHECK=2` → off in Release, LTO for the Box2D library, wasm-opt level, allocator | box2d self time 4.4% (drift) / 22% (contact) | 0–10% of the step | medium: any result change disqualifies | S each | checksums + per-step trace; dropped with one log line on any change |
| 9 | Threads for big worlds (`b2CreateThreadedWorld`, enkiTS, already in the deluxe glue) | contact `PhysicsStep` 21.5% | contact step maybe 1.5–2.5× | medium: must give the same hash (Box2D tests 1–5 workers); small worlds get slower | S to measure | checksums at 1, 2, 4 workers; reported as an optional vecs setting |
| 10 | Scratch adapter only (vecs side): reuse `PhysicsEvents`' three `Set`s per step, keep doubles unboxed in the loop | allocation | read path to 0 B/step | low | S | vecs suites |

### 2.3 Rounds

Each round: implement, then the proof kit (§2.5), then ≥5 alternating timing rounds against
stock, then a round entry in this file.

| round | content | expected effect (vs Phase 1) |
|---|---|---|
| **R1** | Fast-path foundation (ids, layout JSON, memory export, `fastpath` helper, d.ts), `b2x_World_Step`, `b2x_World_ExportMoves`, user data; differential test; scratch adapter pose-out + step | drift copy-out ~7–10×, tick ~5–8×; rest2000 read path ~0 B/step; contact tick ~2.5×; worlds25x19 ~2.8× |
| **R2** | Event spans + adapter `PhysicsEvents` on spans with reused sets; drop the per-world `GetBodyEvents` header | contact events 240 → ~60; worlds25x19 −~100 ns/body |
| **R3** | Profile-timer patch and switch; adapter turns timers off | worlds25x19 step 840 → ~250; tick ~4× |
| **R4** | Generated `b2x_Body_*` API + composites; adapter migrates pose-in, forces, impulses, kinematic targets, `bodyMotion`, `isAwake` | drive500 ~5×; other scenes unchanged |
| **R5** | Build variants (item 8), each gated; threads for the contact scene (item 9) | 0–10% on the step; contact maybe more with threads |
| **R6** | Whatever the R5 profile ranks first; legacy embind speed-up (item 7) if its semantics can be kept exactly | – |

Stop rule (from the mission): stop after two consecutive rounds that each gain < 5% on the whole
tick. Then record what the remaining cost is made of. Expected: vecs's own `entity.get` / `set` /
flush, the Box2D step, and the vecs systems that run per world per tick.

### 2.4 Targets (committed floors, relative to the Phase 1 baseline)

Measured as same-session alternating ratios against stock (≥5 rounds, medians), and also reported
in absolute ns.

| metric | scene(s) | floor (committed) | stretch | expected |
|---|---|---|---|---|
| copy-out (`PhysicsPoseSyncOut` incl. its flush) | drift500 / drift2000 / drift10000 | **≥ 5× cheaper** | ≥ 10× | 7–10× |
| JS allocations per step on the physics read path | rest2000 (reads every body, writes nothing) | **0 B per body per step**, with any fixed per-step bytes attributed | 0 B per step | 0 |
| whole tick per body | drift500 / drift2000 / drift10000 (no contacts) | **≥ 3× cheaper** | ≥ 6× | 5–8× |
| reported separately | contact | – | – | tick ~2.5–3× (Box2D's step is 22% of baseline and stays, unless threads) |
| reported separately | worlds25x19 | – | – | tick ~4× after R3 |
| reported separately | drive500, rest2000 | – | – | ~5× / ~15× |

On drift scenes, allocations after R1 are expected to be only vecs's `entity.set` path
(~450 B/body/step, measured by the probe). That is vecs-owned and reported with its breakdown.
Zero there would need a vecs API change and is listed in the migration guide, not promised here.

### 2.5 Verification protocol (every round, every build)

1. **Checksums**, all 7 scenes (drift500 `11c76fa7`, drift2000 `a66a94ee`, drift10000 `70623967`,
   contact `5db7f953`, worlds25x19 `a8a0671e`, rest2000 `17fc310b`, drive500 `fd7cc876`). They must
   match stock in the same run, with the scratch adapter *and* with the unmodified adapter on the
   fork build. Build-flag variants also run `BENCH_TRACE=1` (state folded every step).
2. **Differential test** `perf/tests/fastpath-differential.mjs` (box2d only, no vecs), over drift,
   contact and sensor scenes:
   - every exported move record is compared field by field with embind's `GetMoveEvent` /
     `transform` / `GetAngle` / velocity getters with `Object.is`, every body, every step;
   - spans are compared with embind's contact, hit and sensor events;
   - every generated getter is compared with its embind twin;
   - setters: two identical worlds, one driven through embind and one through `b2x_` with the
     same inputs, compared bitwise every step;
   - it runs on deluxe **and** compat, and includes a forced memory-growth phase.
3. **vecs suites**: `@vworlds/vecs-physics` (537 tests), `@vworlds/vecs-phaser-server` (154, incl.
   `motion_accuracy.test.ts` real-WASM DR), `@vworlds/vecs-phaser` (119). They run (a) unmodified
   against the fork build (embind compatibility) and (b) with the scratch adapter.
4. **Timing**: `perf/bench/run.mjs`, ≥5 alternating rounds stock vs fork, medians plus max/min
   spread; allocation pass; a profile for the next round's ranking.

### 2.6 Scratch adapter and migration order (preview of the Phase 4 guide)

The scratch adapter is a local-only branch `scratch/fork-adapter` in the `../vecs-scratch`
worktree (based on `2d58dd7`, never pushed). Call sites in migration order:

1. `adapter/runtime.ts`: create the fast path at preload, allocate scratch/record buffers, turn
   profile timers off (R3).
2. `core/step.ts`: `b2World_Step` → `b2x_World_Step`.
3. `body/pose_out.ts`: header + `GetMoveEvent` + `transform`/`p`/`q` + velocity getters →
   `b2x_World_ExportMoves` + typed-array loop. Same order, same compare-before-write, same
   Dynamic/destroyed checks.
4. `events/publish.ts`: contact/sensor headers and events → spans; reuse the three `Set`s.
5. `body/lifecycle.ts`, `shapes/lifecycle.ts`: keep the packed id on the component; optional
   user data.
6. `adapter/queries.ts`: `bodyMotion` → `b2x_Body_GetMotion`, `isAwake` → raw.
7. `body/pose_in.ts`, `forces/*.ts`, `kinematic/targets.ts`: raw setters and getters.
8. Rare paths (mass, joints, shapes, queries): stay on embind.

### 2.7 Decisions taken in Phase 2

- The fast path is additive and C-level, with no embind changes in R1–R6 except the optional,
  semantics-preserving item 7.
- Copy into a caller-owned buffer for moves (the angle and velocities must come from wasm).
  Zero-copy spans for contact, sensor and hit events (all fields are raw Box2D data).
- The adapter keeps step and export as separate calls (step phase vs postStep). The fused call is
  provided and measured, but not used by default.
- Cross-world batching is deferred (§2.1 J).
- The profile timers default to on; vecs opts out.
- Ids are passed as packed integers; EIDs may ride in user data, with a fallback.
- The per-body API is generated from `box2d.h`, not hand-written.

### 2.8 Risks and open questions for the reviewer

- **Publishing** `@vworlds/box2d3-wasm` needs credentials for the `@vworlds` npm scope (or GitHub
  Packages or a release tarball). It will be checked in Phase 4. Proposed version:
  `5.2.0-vworlds.1`, consumed by vecs as an npm alias (`"box2d3-wasm": "npm:@vworlds/box2d3-wasm@…"`),
  so imports stay unchanged.
- Host noise (13–40% single runs, slow drift between sessions) is handled by same-session
  alternating comparisons only.
- Stale typed views after memory growth are the main correctness hazard of the new API. They are
  covered by the documented rule, `fp.sync()`, and a forced-growth phase in the differential test
  on both flavours.

---

## Phase 3 rounds

Setup used by every round (all local, never pushed to vecs):

- `../vecs-stock`: vecs `2d58dd7`, unmodified, built. Proves the embind API still works on fork builds.
- `../vecs-scratch`: vecs `2d58dd7` + the scratch adapter on local branch `scratch/fork-adapter`.
  One commit per round; the same commits are exported to `perf/adapter/*.patch` in this repo
  (`git am` them onto `2d58dd7` to rebuild it).
- Each checkout has its own `node_modules` whose `box2d3-wasm` entry is a symlink
  (`/home/user/pkg/<checkout>/build/dist/es` → a build dir), so vitest runs against any build.
- `perf/prove.sh <build>` is the proof kit: the differential test on deluxe and compat, the 7
  checksums with the scratch adapter and with unmodified vecs, and the 3 vecs suites in both
  checkouts.
- Round timings: `perf/bench/run.mjs`, 5 alternating rounds, fresh process per run, medians;
  `perf/bench/summarize.py` prints the tables below.

### Round 1: fast-path foundation, bulk move export, raw step

Fork (`box2d3-wasm/`):

- `csrc/fastpath.cpp`:
  - packed ids;
  - layout JSON generated from `sizeof`/`offsetof`, with alignment `static_assert`s;
  - `b2x_World_Step`, `b2x_World_GetMoveCount`, `b2x_World_ExportMoves` (48-byte record: index,
    rev, user data, flags, x, y, c, s, angle, vx, vy, w), `b2x_World_StepAndExportMoves`,
    `b2x_World_GetMoveEventSpan`, `b2x_World_GetContactSpans`, `b2x_World_GetSensorSpans`;
  - integer user data for bodies and shapes.
- `shell/1_build_wasm.sh`: compiles it, exports `wasmMemory`, `HEAPF32`, `HEAP32`.
- `src/fastpath.mjs` + `.d.ts`: `createFastPath(module)` with layout, views, `sync()`, id
  packing, `alloc`/`free`, and a growable `MoveExporter`. Exposed as package export
  `box2d3-wasm/fastpath`.
- `perf/tests/fastpath-differential.mjs`: every exported field against its embind twin,
  every body, every step (drift and contact/hit/sensor scenes, dynamic-only filter, fused call,
  raw vs embind step on twin worlds, forced memory growth). **4,205,896 values equal, on deluxe
  (shared memory) and compat (non-shared)**, with 3,394 contact begins, 2,975 ends, 1,564 hits
  and 635 sensor events in the comparison.

Scratch adapter: `core/step.ts` → `_b2x_World_Step`; `body/pose_out.ts` → one
`exportMoves` per step plus a typed-array loop (same order, same lookups, same
compare-before-write). Two tests that counted pose-out's embind handles now assert the new
contract: one export per tick, zero embind body-event or velocity calls, components equal to
the embind getters.

Proof: 7/7 checksums identical (scratch adapter and unmodified vecs). vecs suites:
vecs-physics 536/536, vecs-phaser-server 154/154 (incl. `motion_accuracy.test.ts`),
vecs-phaser 119/119, in both checkouts.

Timing, stock vs R1, same session, 5 alternating rounds (ns per body per step):

| scene | copy-out stock → R1 | × | step | events | whole tick stock → R1 | × | tick spread R1 | alloc B/body/step (R1) | checksums |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 6568 → 530 | 12.4× | 226 → 199 | 38 → 34 | 6871 → 794 | **8.7×** | 28% | 421.6 | 11c76fa7 (same) |
| drift2000 | 7879 → 760 | 10.4× | 247 → 183 | 26 → 14 | 8171 → 962 | **8.5×** | 19% | 394.3 | a66a94ee (same) |
| drift10000 | 7605 → 1515 | 5.0× | 256 → 257 | 8 → 10 | 7870 → 1789 | **4.4×** | 35% | 385.4 | 70623967 (same) |
| contact | 7823 → 940 | 8.3× | 1914 → 1792 | 350 → 285 | 10134 → 3096 | **3.3×** | 9% | 911.7 | 5db7f953 (same) |
| worlds25x19 | 6591 → 795 | 8.3× | 976 → 901 | 245 → 239 | 8526 → 2493 | **3.4×** | 12% | 1035.7 | a8a0671e (same) |
| rest2000 | 6229 → 242 | 25.7× | 135 → 96 | 18 → 12 | 6411 → 361 | **17.8×** | 16% | 8.4 | 17fc310b (same) |
| drive500 | 7131 → 946 | 7.5× | 558 → 567 | 53 → 48 | 9210 → 3077 | **3.0×** | 11% | 1515.1 | fd7cc876 (same) |

Stock allocated 3,306–4,877 B/body/step; R1 allocates 385–420 B on the drift scenes (vecs
`entity.set`) and 8.4 B in rest2000 (no writes; R2 removes the known per-step sources).

R1 profile (`perf/results/profiles/r1-*.txt`):
- **drift10000:** embind is gone (0.6%). **vecs is 71.5%**: `entity.get` 29.5% and the deferred
  `_executeCommand` flush 26.3%. `entity.get(Class)` resolves the class to its component entity
  on every call (`world.entity(ref).eid`) before the map lookup, and its cost per body grows
  with entity count, which is why drift10000 sits at 5.0× copy-out.
- **worlds25x19:** the profile-timer chain (`_clock_time_get`, `now`, `bigintToI53Checked`,
  `get buffer`, `_emscripten_get_now`, `growMemViews`) is ~18%, vecs's per-world system overhead
  (`system.js` `_run` and callback wrapper, `progress`) ~14%, and the embind event headers in
  `PhysicsEvents` ~4% + `makeClassHandle` 3.5%.

Re-plan: an adapter-side round "numeric component ids for `entity.get`/`set`" is added after
R4 (it is the largest remaining cost on big worlds and is semantics-preserving: `get` accepts a
numeric id).

**Stop-rule interpretation.** A round counts as a gain when the whole tick of at least one scene
improves by ≥ 5% (same-session medians against the previous round). The loop stops after two
consecutive rounds with no scene ≥ 5%.

### Round 2: contact, hit and sensor events from zero-copy spans

Fork: nothing new (the spans shipped in R1). Builds from here on are `fork-r4` (all C for
R2–R4 plus the timer patch); with the switch at its default it behaves like R1.

Scratch adapter: `events/publish.ts` reads begin/end/hit and sensor begin/end records in place
(one `b2x_World_Get*Spans` call each, in the same order: begins, ends, hits, then sensor
begins, ends). It does the same `entityByShapeIndex` lookups and liveness checks, and the hit
point/normal/speed are the same f32 values. The three per-step `Set`s are allocated once and
reused. The handle test now asserts that events still arrive (contact begin/end, hit, sensor on
either sensor shape; checked identical on unmodified vecs) with zero embind event calls.

Proof: `perf/prove.sh fork-r4` passes (differential on both flavours, 14/14 checksums, 6/6 suite
runs). Timing R1 → R2 (both on fork-r4):

| scene | copy-out r1 → r2 | × | step r1 → r2 | events | whole tick r1 → r2 | × | tick spread r2 | alloc B/body/step (r2) | checksums |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 576 → 623 | 0.9× | 200 → 203 | 34 → 10 | 842 → 881 | **1.0×** | 18% | 415.1 | 11c76fa7 (same) |
| drift2000 | 772 → 730 | 1.1× | 190 → 187 | 14 → 4 | 987 → 935 | **1.1×** | 15% | 394.1 | a66a94ee (same) |
| drift10000 | 1424 → 1490 | 1.0× | 258 → 255 | 9 → 3 | 1699 → 1762 | **1.0×** | 19% | 385.3 | 70623967 (same) |
| contact | 1278 → 1243 | 1.0× | 1910 → 1898 | 332 → 140 | 3511 → 3358 | **1.0×** | 34% | 845.7 | 5db7f953 (same) |
| worlds25x19 | 754 → 768 | 1.0× | 894 → 882 | 240 → 40 | 2504 → 2298 | **1.1×** | 12% | 912.4 | a8a0671e (same) |
| rest2000 | 269 → 305 | 0.9× | 99 → 107 | 12 → 4 | 393 → 436 | **0.9×** | 23% | 10.2 | 17fc310b (same) |
| drive500 | 978 → 1005 | 1.0× | 538 → 556 | 50 → 13 | 3088 → 3110 | **1.0×** | 15% | 1509.5 | fd7cc876 (same) |

Events cost 332 → 140 ns/body (contact) and 240 → 40 (worlds25x19). Whole tick: worlds25x19
**−8.2%** and contact −4.4%, so this is a gaining round. The drift and rest scenes have no events,
and their copy-out code is identical between R1 and R2: those ±10% moves are noise.

Allocation hunt: a sampling heap profile with collected objects included (`BENCH_HEAP_SAMPLE`,
`perf/bench/heap-sites.py`) shows that rest2000's remaining ~15 KB/step is **per step, not
per body**:
- vecs's system runner and pipeline iteration: ~7.7 KB;
- Box2D's timer clock path (BigInt conversions): ~3.1 KB;
- harness instrumentation: ~1 KB;
- adapter iterators over empty queues and maps: ~0.8 KB;
- `writePose`: 0.26 B/body.

### Round 3: Box2D profile timers off; no iteration of empty collections

Fork: `patches/box2d/0001-runtime-switch-for-profile-timers.patch` (applied by
`0_build_makefile.sh`; `patches/README.md`), `b2x_SetProfileTimers` / `b2x_GetProfileTimers`.
Default on.

Scratch adapter: the fast path turns the timers off at preload. The reaper, impulse drains and
`PhysicsEvents` set passes return early when their collection is empty (each `for…of` allocates
an iterator).

Proof: `perf/prove.sh fork-r4` passes. Timing R2 → R3:

| scene | copy-out r2 → r3 | × | step r2 → r3 | events | whole tick r2 → r3 | × | tick spread r3 | alloc B/body/step (r3) | checksums |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 608 → 533 | 1.1× | 207 → 170 | 9 → 9 | 852 → 742 | **1.1×** | 27% | 406.3 | 11c76fa7 (same) |
| drift2000 | 729 → 753 | 1.0× | 189 → 182 | 4 → 5 | 934 → 958 | **1.0×** | 27% | 393.6 | a66a94ee (same) |
| drift10000 | 1375 → 1363 | 1.0× | 256 → 241 | 3 → 3 | 1647 → 1612 | **1.0×** | 28% | 385.3 | 70623967 (same) |
| contact | 1140 → 1208 | 0.9× | 1831 → 1834 | 140 → 135 | 3142 → 3228 | **1.0×** | 8% | 839.9 | 5db7f953 (same) |
| worlds25x19 | 767 → 736 | 1.0× | 899 → 225 | 42 → 37 | 2298 → 1538 | **1.5×** | 5% | 690.6 | a8a0671e (same) |
| rest2000 | 280 → 272 | 1.0× | 94 → 89 | 4 → 4 | 390 → 372 | **1.0×** | 14% | 5.0 | 17fc310b (same) |
| drive500 | 988 → 980 | 1.0× | 549 → 515 | 13 → 13 | 3032 → 3037 | **1.0×** | 16% | 1500.2 | fd7cc876 (same) |

worlds25x19: step **899 → 225 ns/body**, whole tick **−33%**. That matches the Phase 2 finding
(~70% of a small-world step was the timers). Single-world scenes move within noise; their
timers cost ~5 ns/body. rest2000 allocates 5.0 B/body/step, all of it fixed per-step bytes
(vecs core and the harness).

### Round 4: generated per-body API; pose-in, forces, impulses, kinematic targets, bodyMotion

Fork:
- `tools/gen_fastpath.py` generates `csrc/fastpath_body.gen.cpp` + `src/fastpath_body.gen.d.ts`:
  60 of the 65 `b2Body_*` functions. The 5 skipped are names, raw `void*` user data (covered by
  the integer user-data calls) and `GetContactData`. Id arrays (`GetShapes`, `GetJoints`) are
  written straight into the caller's buffer: a `b2ShapeId`/`b2JointId` *is* the
  `(index1, rev)` word pair, enforced by `static_assert`. `--check` mode detects stale output.
- Composites in `fastpath.cpp`: `b2x_Body_SetPosition`, `b2x_Body_SetAngle`,
  `b2x_Body_GetPose`, `b2x_Body_GetMotion`. Layouts `pose` and `motion` were added to the JSON.
- The differential test gained section 5 (every generated getter and both composites against
  embind, every body) and section 6 (twin worlds, one driven by embind setters and one by
  `b2x_` setters with the same pseudo-random doubles, full state compared bitwise every step
  for 150 steps). **5,473,096 values equal on deluxe and compat.**

Scratch adapter (`perf/adapter/0004-*.patch`):
- `pose_in.ts`: `b2x_Body_SetPosition` / `SetAngle` / `SetLinearVelocity` /
  `SetAngularVelocity`.
- `forces/gather.ts`, `forces/impulses.ts`: raw apply calls.
- `kinematic/targets.ts`: raw type, position, pose, velocity and awake calls; the JS target math
  is unchanged.
- `queries.ts`: `bodyMotion` → `b2x_Body_GetMotion` (vecs-phaser-server's dead reckoning),
  `isAwake` → raw.
- A 64-byte wasm scratch (`scr_fastOut`) holds out-parameters.

Proof: `perf/prove.sh fork-r4` passes (incl. `motion_accuracy.test.ts`, which now reads
`b2x_Body_GetMotion`). Timing R3 → R4:

| scene | copy-out r3 → r4 | × | step r3 → r4 | events | whole tick r3 → r4 | × | tick spread r4 | alloc B/body/step (r4) | checksums |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 606 → 618 | 1.0× | 170 → 169 | 10 → 10 | 815 → 837 | **1.0×** | 26% | 406.2 | 11c76fa7 (same) |
| drift2000 | 773 → 818 | 0.9× | 180 → 183 | 4 → 4 | 972 → 1018 | **1.0×** | 16% | 393.6 | a66a94ee (same) |
| drift10000 | 1466 → 1439 | 1.0× | 258 → 254 | 3 → 3 | 1740 → 1702 | **1.0×** | 22% | 385.3 | 70623967 (same) |
| contact | 1203 → 1222 | 1.0× | 1804 → 1828 | 134 → 137 | 3152 → 3253 | **1.0×** | 21% | 839.9 | 5db7f953 (same) |
| worlds25x19 | 776 → 765 | 1.0× | 246 → 240 | 45 → 39 | 1638 → 1622 | **1.0×** | 11% | 690.7 | a8a0671e (same) |
| rest2000 | 282 → 257 | 1.1× | 88 → 87 | 4 → 4 | 391 → 355 | **1.1×** | 21% | 5.0 | 17fc310b (same) |
| drive500 | 1005 → 1021 | 1.0× | 519 → 484 | 14 → 13 | 3132 → 1820 | **1.7×** | 33% | 874.3 | fd7cc876 (same) |

drive500: force gather **1,508 → 262 ns/body**; whole tick −42%; allocation 1,500 → 874
B/body/step (the `vec.Set` handles are gone). The other scenes have no per-step per-body calls
in these paths, so no change is expected and none is seen beyond noise.

### Round 5: numeric component ids in pose-out (adapter only)

vecs's `entity.get(Class)` resolves the class to its component entity (`world.getEntity`) on every
call, then does the component lookup. `entity.get(eid)` is the same lookup without the
resolution. Pose-out now resolves `Body`, `Position`, `Rotation`, `LinearVelocity` and
`AngularVelocity` once at init. No fork change.

Proof: `perf/prove.sh fork-r4` passes. Timing R4 → R5:

| scene | copy-out r4 → r5 | × | step r4 → r5 | events | whole tick r4 → r5 | × | tick spread r5 | checksums |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 561 → 565 | 1.0× | 166 → 176 | 9 → 10 | 771 → 788 | **1.0×** | 19% | 11c76fa7 (same) |
| drift2000 | 758 → 616 | 1.2× | 179 → 172 | 4 → 4 | 952 → 802 | **1.2×** | 7% | a66a94ee (same) |
| drift10000 | 1196 → 958 | 1.2× | 236 → 234 | 2 → 2 | 1440 → 1199 | **1.2×** | 32% | 70623967 (same) |
| contact | 1129 → 1055 | 1.1× | 1779 → 1811 | 116 → 131 | 3017 → 3014 | **1.0×** | 8% | 5db7f953 (same) |
| worlds25x19 | 747 → 652 | 1.1× | 225 → 234 | 38 → 38 | 1563 → 1469 | **1.1×** | 13% | a8a0671e (same) |
| rest2000 | 250 → 202 | 1.2× | 84 → 88 | 3 → 3 | 348 → 300 | **1.2×** | 25% | 17fc310b (same) |
| drive500 | 1000 → 844 | 1.2× | 495 → 479 | 12 → 12 | 1826 → 1624 | **1.1×** | 16% | fd7cc876 (same) |

Whole tick −16% (drift2000), −17% (drift10000), −14% (rest2000), −11% (drive500),
−6% (worlds25x19): a gaining round.

### Round 6: build variants, LTO for the Box2D library adopted

Three variants of the R5 build (`fork-r4`), deluxe:
- `-sSTACK_OVERFLOW_CHECK=0` (Release sets 2);
- LTO for the Box2D static library (`-flto` in its CFLAGS; the link was already `-flto`);
- both.

Every variant passes the quick proof kit (differential test, 14/14 checksums). The per-step
traces (`BENCH_TRACE=1`: every body's pose and velocities folded in after every step) are
identical to fork-r4 on drift500, contact, worlds25x19 and drive500.

Box2D-only step benchmark (`perf/spikes/step-bench.mjs`, 8 alternating rounds, ns/body/step):

| scene | fork-r4 | no stack check | LTO | LTO + no stack check |
|---|---:|---:|---:|---:|
| contact pile (1,000) | 1039 | 1023 (1.02×) | 1053 (0.99×) | 1002 (1.04×) |
| 25 worlds × 19 | 190 | 159 (1.19×) | **147 (1.29×)** | 146 (1.30×) |
| 500 forced bodies | 390 | 377 (1.04×) | **354 (1.10×)** | 353 (1.10×) |

LTO gives almost all of it, mostly per-call overhead. **Adopted: Release builds compile Box2D
with `-flto`** (`0_build_makefile.sh`). Upstream's stack-overflow check is kept, since dropping
it adds ~1%. A clean `REBUILD_LIB=1` rebuild reproduces a build byte for byte (checked), and
`fork-r6` deluxe is byte-identical to the LTO variant. Wasm size: 449 → 485 KB.

Whole tick R5 → R6 (`perf/results/r6-timing.jsonl`): steps 4–18% cheaper (contact 2,006 → 1,872,
worlds25x19 280 → 229). The whole tick moved inside this session's noise in both directions
(spreads up to 50%; contact's copy-out, which LTO cannot affect, moved 18%). **Counted as < 5%.**

### Round 7: pose-out reads entity objects by body index (adapter)

`engine.bodyEntities[index1]` holds the `Entity`, set and cleared next to `entityByBodyIndex`.
Pose-out skips the per-body `world.getEntity(eid)`; the `destroyed` check stays. Proof passes on
fork-r6. R6 → R7 whole tick: drift10000 −9.5%, rest2000 −6.7%, worlds25x19 −6.4%, others
±2%. Copy-out improved in 6/7 scenes (contact −17%, drift10000 −10%). Spreads 26–43%.
**Counted as a gain (≥ 5% in three scenes).**

### Round 8: threaded step for large worlds (opt-in), dropped

Scratch adapter option `workerCount` creates the world through the deluxe glue's
`b2CreateThreadedWorld` (enkiTS). The checksum is identical at 0, 2 and 4 workers (contact,
events included), and the Box2D-only probe (`perf/spikes/threads.mjs`) gives an identical
per-step state hash at 0/1/2/4 workers. But inside the vecs tick on this 4-vCPU host the step
got slower (1,827 → 1,910–2,303 ns/body with 4 workers; 2 workers worse). The Box2D-only probe's
1.4× at 4 workers does not survive the main thread doing JS work between steps. **Dropped; code
reverted. Counted as < 5%.** (Result-neutral, so it remains a possible vecs configuration
option for many-core servers with very large worlds; measure there.)

### Round 9: one span fetch and one memory sync per events step (adapter)

`PhysicsEvents` fetches both span headers into one scratch block and syncs the memory views
once. R7 → R9 whole tick: every scene within ±4%. **Counted as < 5%.**

**Stop: R8 and R9 are two consecutive rounds under 5% on every scene.** The final comparison
against stock and the composition of the remaining cost follow below.

### Phase 3 result: stock vs final (same session, 5 alternating rounds)

Final = fork build `fork-r6` (fast path, timer switch, LTO) + scratch adapter after R9
(`perf/adapter/0001…0007-*.patch` on vecs `2d58dd7`). Stock = npm `box2d3-wasm@5.2.0` +
unmodified vecs `2d58dd7`. ns per body per step; raw data `perf/results/phase3-final-*`.

| scene | copy-out stock → final | × | step stock → final | events | whole tick stock → final | × | tick spread final | alloc B/body/step stock → final | checksums |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| drift500 | 6809 → 480 | **14.2×** | 248 → 158 | 51 → 9 | 7171 → 678 | **10.6×** | 31% | 3782 → 406.5 | 11c76fa7 (same) |
| drift2000 | 7815 → 624 | **12.5×** | 248 → 166 | 27 → 4 | 8131 → 807 | **10.1×** | 17% | 3751 → 393.5 | a66a94ee (same) |
| drift10000 | 7745 → 1289 | **6.0×** | 259 → 244 | 9 → 3 | 8020 → 1541 | **5.2×** | 5% | 3764 → 385.3 | 70623967 (same) |
| contact | 8776 → 1112 | 7.9× | 2092 → 1743 | 432 → 147 | 11366 → 3067 | **3.7×** | 18% | 4274 → 839.9 | 5db7f953 (same) |
| worlds25x19 | 7258 → 676 | 10.7× | 1124 → 227 | 278 → 40 | 9621 → 1564 | **6.1×** | 17% | 4432 → 690.7 | a8a0671e (same) |
| rest2000 | 6412 → 200 | 32.1× | 138 → 89 | 19 → 4 | 6601 → 295 | **22.4×** | 25% | 3306 → 5.4 | 17fc310b (same) |
| drive500 | 7838 → 877 | 8.9× | 617 → 448 | 66 → 12 | 10296 → 1639 | **6.3×** | 16% | 4876 → 787.9 | fd7cc876 (same) |

Targets (§2.4):
- copy-out ≥ 5× on the drift scenes: **met** (14.2×, 12.5×, 6.0×). Stretch 10×: met at 500
  and 2,000, not at 10,000.
- whole tick ≥ 3× on the drift scenes: **met** (10.6×, 10.1×, 5.2×). Stretch 6×: met at 500
  and 2,000.
- zero allocations per body on the read path: **met**. rest2000 allocates 5.4 B/body/step,
  which is 10.8 KB/step of *fixed* per-step bytes: vecs's system runner and pipeline iteration
  (~7.7 KB) and the harness's instrumentation (~1 KB), per the heap sample in R2. In stock this
  scene allocated 3,306 B/body/step, all from the read path. On the drift scenes the remaining
  ~390 B/body/step is vecs's `entity.set` path: the `{x, y}` / `{angle}` literal, the deferred
  command record and update routing, for Position and Rotation every step.
- contact 3.7×, worlds25x19 6.1×, drive500 6.3×, rest2000 22.4×: reported separately.

### What the remaining cost is made of, and why it stays

Final profile (`perf/results/profiles/final-*.txt`), self time share of the whole tick:

| category | drift2000 | drift10000 | contact | worlds25x19 | rest2000 | drive500 |
|---|---:|---:|---:|---:|---:|---:|
| vecs (ECS core) | 44.8% | 54.7% | 24.7% | 54.5% | 15.6% | 48.6% |
| vecs-physics (adapter, incl. inlined vecs `get`/`set`) | 28.8% | 25.7% | 16.9% | 25.1% | 44.8% | 17.5% |
| Box2D (step + 1–2% export) | 21.0% | 17.2% | 56.2% | 13.5% | 37.6% | 29.3% |
| GC | 4.6% | 1.6% | 1.4% | 1.3% | 0.3% | 2.9% |
| embind / wasm allocator | 0.1% | 0.0% | 0.3% | 0.2% | 0.1% | 0.3% |
| V8 + harness | 0.6% | 0.8% | 0.5% | 5.6% | 1.6% | 1.3% |

1. **Box2D's step (13–56%).** This is the simulation itself (`b2ExecuteBlock` solver stages,
   `b2FindPairsTask` / `b2CollideTask` broadphase and narrowphase, `b2FinalizeBodiesTask`).
   Making it cheaper means changing its algorithms, solver settings, sub-steps or broadphase,
   which changes results. Result-neutral build options were all tried:
   - LTO: adopted.
   - `STACK_OVERFLOW_CHECK=0`: ~1% on top of LTO; not adopted, to keep upstream's safety check.
   - threads: identical results, slower in the vecs tick on this host.
   - SIMD: already in the deluxe build.
   The profile timers, the only non-simulation work inside the step, are switched off.
2. **vecs's write path (the largest share on every moving scene).** Each changed pose component
   is `entity.set` → a deferred command → `_executeCommand` → `_set` → `_routeModified` /
   `_notifyComponentSet` to every watching system, plus GC of the per-set literal and command
   record. vecs semantics require one modification per changed component (set hooks, update
   routing, replication). Removing it changes vecs-observable behavior, not physics results, so
   it is outside the fork. It could get cheaper only through a vecs API change (e.g. an in-place
   bulk pose write that still routes one update per entity).
3. **vecs's read path.** `entity.get` per component to compare with the committed state. The
   compare-before-write must stay exact (it decides whether a write and its replication happen).
   R5 already removed the class-to-id resolution; what is left is vecs's component map lookup.
4. **vecs per-system overhead in many small worlds (worlds25x19: `system.js` wrapper + `_run` +
   `progress` ≈ 28%).** Every registered system runs per world per tick, even with nothing to
   do. This is vecs core (the "empty system fast path" noted in #273).
5. **The adapter loop itself.** One pass over the export buffer: body index → cached entity,
   destroyed and `Body.type` checks, four exact compares. The `Body.type` read is a component
   read that keeps today's semantics. The export's own type flag would save it, but it can differ
   from the component inside a frame in which `Body.type` was just changed.

Fork-side cost left: `b2x_World_ExportMoves` ≈ 1.8% (≈ 15 ns/body: per-body id validation,
type and velocity lookups through Box2D's public API). Reading Box2D's internal body arrays
directly would halve it, at the price of depending on private headers. Not done.

---

## Phase 4: final analysis and hand-back

Deliverables:
- [REPORT.md](REPORT.md): the final tables (two hosts), proof, rounds, remaining cost, left on
  the table, publishing.
- [box2d3-wasm/docs/fastpath.md](box2d3-wasm/docs/fastpath.md): the API reference; its example
  typechecks and runs.
- [PATCHES.md](PATCHES.md): changes vs upstream and how to rebase.
- [docs/vecs-migration.md](docs/vecs-migration.md): each call site, today → fast path, order,
  gain.
- `release/`: the packed tarball.

Package: `@vworlds/box2d3-wasm` **5.2.0-vworlds.1**.

### 4.1 Audit from a clean checkout (commit `f72cf60`)

- Fresh `git clone` of the branch, submodules, `npm ci`, both flavours built from scratch (the
  Box2D patch applied, LTO). `gen_fastpath.py --check`: up to date.
- Fresh vecs checkouts via `perf/setup-vecs-checkout.sh` (unmodified at `2d58dd7`; scratch =
  `2d58dd7` + `perf/adapter/0001…0007`). Both build; the scratch adapter typechecks against the
  new declarations.
- `perf/prove.sh`: **PROOF OK**
  - differential test: 5,473,096 values equal on deluxe and compat;
  - checksums: 14/14 (scratch adapter and unmodified vecs);
  - vecs suites: 6/6 runs (vecs-physics 536, vecs-phaser-server 154, vecs-phaser 119, in both
    checkouts).

  Log: `perf/results/phase4-audit-prove.log`.
- vecs's own `bench/physics-pose-out.ts`, unmodified, on the audited build: N=500 `11c76fa7`,
  N=2,000 `a66a94ee`, with the scratch adapter and with unmodified vecs.
- **Per-step traces, stock vs final, identical in all seven scenes** (`BENCH_TRACE=1`;
  `perf/results/phase4-audit-trace.txt`): drift500 `2f08129e`, drift2000 `1d76a561`,
  drift10000 `bd957614`, contact `322669a9`, worlds25x19 `68c264b3`, rest2000 `78082b5b`,
  drive500 `db7fa498`.
- `npm pack` of the audited build → `release/vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz` (sha256
  `dbec27a1…`). Installed into a throwaway project under the scoped name and a `box2d3-wasm`
  alias; the fast path runs and equals embind.

### 4.2 The host changed during the audit

The container rebooted onto a different machine (host B) at about 05:23, before the audit build.
On host B the same final code runs relatively slower: its remaining cost is memory-latency-bound
vecs ECS work. Stock runs 1.3–1.4× slower on host B, final 1.2–2.3× slower; Box2D's share of the
final tick fell from 21% to 13%. A control run shows the audited build equals the Phase 3 build
within noise on host B (`perf/results/phase4-control.*`).

| | host A (Phases 1–3, Phase 3 final run) | host B (audit, 10 rounds for drift / 5 for the rest) |
|---|---|---|
| whole tick drift 500 / 2,000 / 10,000 | 10.6× / 10.1× / 5.2× | 8.3× / 6.4× / 4.1× |
| copy-out drift 500 / 2,000 / 10,000 | 14.2× / 12.5× / 6.0× | 10.2× / 7.3× / 4.5× |
| contact / 25 worlds / rest / drive (tick) | 3.7× / 6.1× / 22.4× / 6.3× | 2.4× / 7.0× / 13.7× / 6.7× |

Targets: on host A every floor is met. On host B the copy-out floor is missed at 10,000 bodies
(4.5×); there the remaining copy-out is ≈ 98% vecs and adapter JavaScript.

### 4.3 Publishing state

Not published to a registry: no npm credentials in this session, and Actions are disabled on
the fork. Ready:
- the tarball in `release/`;
- `npm publish release/vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz` for anyone with `@vworlds` rights;
- `.github/workflows/publish-vworlds.yml` (needs Actions enabled, the workflow on the default
  branch, and `NPM_TOKEN` for npmjs.org);
- an install-from-GitHub URL in `REPORT.md`.

### 4.4 Next steps (for whoever continues)

1. Publish (above) and report the version to VecsMaster. The vecs-side adapter change, its
   review and its release happen in vecs, following `docs/vecs-migration.md` and
   `perf/adapter/*.patch`.
2. Optional: re-run `perf/bench/run.mjs` on the production server type. Speedups depend on the
   host (see 4.2); results do not.

---

## How to rebuild and re-run everything from a clean checkout

```bash
# toolchain
git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk
(cd /opt/emsdk && ./emsdk install 4.0.18 && ./emsdk activate 4.0.18)
mkdir -p /opt/ts5 && (cd /opt/ts5 && npm i typescript@5.9)          # emcc --emit-tsd needs TS 5
curl -sSfL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz | tar -xJ -C /opt
export PATH=/opt/node-v24.15.0-linux-x64/bin:/opt/ts5/node_modules/.bin:$PATH
source /opt/emsdk/emsdk_env.sh

# fork
git clone -b claude/youthful-edison-uyuukr https://github.com/vworlds/box2d3-wasm && cd box2d3-wasm
git submodule update --init --recursive
(cd box2d3-wasm && npm ci)
perf/build-variant.sh ../builds/stock-src                 # Release deluxe -> ../builds/stock-src
FLAVOURS="deluxe compat" REBUILD_LIB=1 perf/build-variant.sh ../builds/stock-src   # both flavours
perf/build-variant.sh ../builds/stock-prof --profiling-funcs                       # profiling only

# byte-identical proof against npm: build under CI paths
#   copy the repo to /home/runner/work/box2d3-wasm/box2d3-wasm, set
#   EM_CACHE=/home/runner/work/_temp/281a1663-ccee-4526-a311-3d27de0b31ad/emsdk-main/upstream/emscripten/cache
#   build as above, then `cmp` each .wasm/.mjs with node_modules/box2d3-wasm/build/dist/es/...

# vecs consumer (local only, never pushed)
git clone https://github.com/vworlds/vecs ../vecs && cd ../vecs
git fetch origin perf/273-pose-out-bulk-read && git worktree add ../vecs-scratch 2d58dd7
npm ci && cd ../vecs-scratch && ln -s ../vecs/node_modules node_modules
for p in vecs vecs-wire vecs-protocol vecs-physics; do ln -sfn ../../../vecs/lib/$p/node_modules lib/$p/node_modules; done
npm run build -w @vworlds/vecs -w @vworlds/vecs-physics
cd ../box2d3-wasm

# one scene
BENCH_VECS_ROOT=../vecs-scratch BOX2D_ENTRY=../builds/stock-src/entry.mjs \
  node --import ./perf/bench/register.mjs perf/bench/vecs-tick.ts drift2000
# alternating rounds, all scenes (A/B any number of variants: name=<vecs root>@<entry.mjs>)
node perf/bench/run.mjs --rounds 5 --variant stock=../vecs-scratch@../builds/stock-src/entry.mjs \
  --variant fork=../vecs-scratch@../builds/fork/entry.mjs --out perf/results/x.jsonl
node perf/bench/run.mjs --alloc --rounds 2 --variant stock=../vecs-scratch@../builds/stock-src/entry.mjs
# profile + ranked table
BENCH_VECS_ROOT=../vecs-scratch BOX2D_ENTRY=../builds/stock-prof/entry.mjs node --cpu-prof \
  --cpu-prof-interval 250 --cpu-prof-dir=prof --import ./perf/bench/register.mjs perf/bench/vecs-tick.ts contact
node perf/bench/analyze-profile.mjs prof/<file>.cpuprofile --top 40
# per-op marshalling prices
BOX2D_ENTRY=../builds/stock-src/entry.mjs node perf/bench/embind-ops.mjs
```


### Phase 3 setup (scratch adapter, fork builds, proof kit)

```bash
# fork builds (from the fork root; emsdk + TS 5 on PATH as above)
FLAVOURS="deluxe compat" REBUILD_LIB=1 perf/build-variant.sh ../builds/fork        # final: fast path + timer patch + LTO
perf/build-variant.sh ../builds/fork-prof --profiling-funcs                       # profiling (lib from the line above)
python3 box2d3-wasm/tools/gen_fastpath.py --check                                  # generated body API up to date

# two vecs checkouts at 2d58dd7 (local only, never pushed)
cd ../vecs && git worktree add --detach ../vecs-stock 2d58dd7
git worktree add -b scratch/fork-adapter ../vecs-scratch 2d58dd7
(cd ../vecs-scratch && git am ../box2d3-wasm/perf/adapter/*.patch)
# each checkout gets its own node_modules: symlinks to ../vecs/node_modules/* except
#   @vworlds/<pkg> -> <checkout>/lib/<pkg> (workspace links must point into the checkout itself)
#   box2d3-wasm    -> /home/user/pkg/<checkout> (package.json of the fork + build/dist/es -> a build)
#   dgram-client / dgram-server -> ../vecs/node_modules/@vworlds/dgram-* (real packages)
perf/use-build.sh vecs-scratch ../builds/fork && perf/use-build.sh vecs-stock ../builds/fork
(cd ../vecs-stock && npm run build) && (cd ../vecs-scratch && npm run build)

# proof kit and timing
perf/prove.sh ../builds/fork                      # differential (both flavours), 14 checksums, 6 suite runs
node perf/bench/run.mjs --rounds 5 --variant stock=../vecs-stock@../builds/stock-npm/entry.mjs \
  --variant final=../vecs-scratch@../builds/fork/entry.mjs --out perf/results/x.jsonl
python3 perf/bench/summarize.py perf/results/x.jsonl stock final
BENCH_HEAP_SAMPLE=/tmp/h.json BENCH_VECS_ROOT=../vecs-scratch BOX2D_ENTRY=../builds/fork/entry.mjs \
  node --import ./perf/bench/register.mjs perf/bench/vecs-tick.ts rest2000 && python3 perf/bench/heap-sites.py /tmp/h.json 1000
```

Snapshots of each round's compiled adapter (`/home/user/snap/rN`) were plain copies of
`vecs-scratch/lib` after each commit; recreate one by checking out that commit and building.

Reference checksums (stock 5.2.0, default warmup/steps per scene): drift500 `11c76fa7`,
drift2000 `a66a94ee`, drift10000 `70623967`, contact `5db7f953`, worlds25x19 `a8a0671e`,
rest2000 `17fc310b`, drive500 `fd7cc876`.

Phase 2 probes (measurement only):

```bash
BOX2D_ENTRY=../builds/stock-src/entry.mjs node perf/spikes/raw-crossing.mjs
BOX2D_ENTRY=../builds/stock-prof/entry.mjs node --cpu-prof --cpu-prof-interval 100 \
  --cpu-prof-dir=prof perf/spikes/step-fixed-cost.mjs 19
node perf/bench/analyze-profile.mjs prof/<file>.cpuprofile
```
