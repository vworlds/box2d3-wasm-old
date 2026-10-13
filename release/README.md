# Release artifacts

| file | what |
|---|---|
| `vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz` | `npm pack` of `@vworlds/box2d3-wasm` **5.2.0-vworlds.1**: both flavours (deluxe, compat), Release, built from a clean clone of commit `f72cf60` (the audited build, see `REPORT.md`). 24 files, 470.5 kB. |
| `SHA256SUMS` | its SHA-256 |

Until the package is in a registry, install it straight from this repository, under the name
vecs imports:

```bash
npm install "box2d3-wasm@https://github.com/vworlds/box2d3-wasm/raw/<commit>/release/vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz"
```

Once it is published to npm (see `REPORT.md` → "Publishing"), use the alias instead:

```jsonc
"box2d3-wasm": "npm:@vworlds/box2d3-wasm@5.2.0-vworlds.1"
```

To publish this exact tarball: `npm publish release/vworlds-box2d3-wasm-5.2.0-vworlds.1.tgz`
(needs publish rights on the `@vworlds` npm scope). Alternatively, run the
`.github/workflows/publish-vworlds.yml` workflow, which rebuilds, re-proves and publishes.
