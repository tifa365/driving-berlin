# Optimisation report (Codex, 2026-11-22)

Written by OpenAI Codex on request. It could NOT read this repository (its sandbox failed to start), so the
diagnosis is generic: based on the measured facts it was given and on three.js r160, not on `js/stream.js`.
Numbers are its estimates. See the notes at the end for what the streamer already does.

---

**Optimal 3D mesh and texture optimisation for this game: faster loading and less stutter**

**Evidence limitation:** Local reads failed before execution with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. I could not inspect `js/stream.js`, `index.html`, `build_stream.py`, `tools/publish_site.py`, or `README.md`. Consequently, this is a provisional report based on your measurements and verified three.js r160 sources; it cannot honestly provide the requested repository-function diagnosis. No files were modified and no write commands were run.

The following priorities are specific to your workload. Numerical improvements are **estimates or experiment targets**, not measured predictions; rows are not additive.

| Rank and action | MB to start | Seconds to drivable | GPU memory | Stutter | Effort; risk |
|---|---|---|---|---|---|
| 1. Instrument a fixed driving route | Unchanged | Unchanged | Unchanged | Establish causes | 4–8 h; low |
| 2. Resize textures; KTX2 with mipmaps | Target 30–65% less tile traffic; codec-dependent | Potential 20–50% reduction if transfer-bound | Texture memory 4–8× smaller before resizing | Large upload/bandwidth improvement | 2–4 days; texture quality |
| 3. Start with coarse coverage | Target 20–40 MB total | Target 5–15 s on the measured connection | Less initial residency | Avoid startup arrival burst | 1–2 days; initial softness |
| 4. Budget uploads, prioritise requests, protect parents | Similar or less wasted traffic | Similar; potentially faster readiness | Bound transient peaks | Potentially large improvement | 2–4 days; refinement correctness |
| 5. Quantisation and meshopt | Geometry component 40–80% smaller | Depends on geometry share | Vertex attributes roughly 30–60% smaller | Lower transfer/upload cost | 1–2 days; seams/compatibility |
| 6. Versioned persistent tile cache | Cold unchanged; cached tile traffic near zero | Removes network wait on repeats | Unchanged | Removes refetch stalls, not uploads | 1–2 days; quota/version handling |
| 7. Direct CDN delivery or spatial bundles | Similar; bundles can overfetch | Depends on request critical path | Unchanged | Fewer network starvation events | 1–3 days; delivery complexity |

**Diagnosis before implementation**

The supplied facts establish two bottlenecks: 93 MB of initial tile traffic, and JPEG textures expanding substantially in memory. A 2048×1024 RGBA8 texture occupies **8 MiB without mipmaps, approximately 10.67 MiB with them**, excluding geometry and overhead. Thus the earlier 8 MB measurement may omit mipmaps.

The following are investigation points, **not verified defects in your streamer**:

- **Parsing:** `GLTFLoader.parse()` parses JSON and constructs the loading pipeline in its calling thread. Promise-based APIs do not automatically move scene construction into workers.
- **JPEG decoding:** r160’s `GLTFParser` already selects `ImageBitmapLoader` where supported, with browser exceptions. Claiming all JPEG decoding runs synchronously on the main thread would be incorrect. Inspect the actual loader path. [r160 GLTFLoader](https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/loaders/GLTFLoader.js)
- **Uploads and mipmaps:** `WebGLTextures.uploadTexture()` uploads images; `generateMipmap()` submits GPU work that can cause stalls. Several completed tiles becoming visible together can overload one frame. [r160 WebGLTextures](https://raw.githubusercontent.com/mrdoob/three.js/r160/src/renderers/webgl/WebGLTextures.js)
- **Shaders:** first-use compilation can hitch, but compatible unlit materials share shader programs: one material per tile does not imply one compilation per tile.
- **Scheduling and eviction:** inspect per-frame traversal/sorting/allocation, loading-bar readiness conditions, stale requests, parent retention, memory accounting, disposal, and immediate reloads after eviction.
- **Delivery:** every uncached resolve adds the supplied redirect path. The limit averages ten resolves/second; aggressive concurrency can exhaust it. Multiplying 0.4–0.7 seconds by every tile overstates wall time because requests overlap.

**Offline optimisation: the largest lever**

Begin with representative road, foliage, roof and façade tiles from every level. Measure their geometry/texture split and compare screenshots from both cameras.

**KTX2/Basis Universal.** ETC1S favours small downloads but can smear photographic detail and introduce colour/block artifacts. UASTC preserves detail better but often produces files **larger than the original JPEGs**. ETC1S normally includes BasisLZ supercompression; UASTC can be stored directly or compressed with Zstandard. Zstandard reduces transfer size, adds decompression work, and does not change final GPU residency.

For 2048×1024 plus mipmaps, un-supercompressed UASTC is approximately **2.67 MiB**. An experimental UASTC+Zstd range is **1–2.7 MiB**, strongly content-dependent. ETC1S might produce **0.15–0.8 MiB**, but noisy photogrammetry may exceed that or lose unacceptable detail. These are sample-testing ranges, not dataset forecasts.

After transcoding, a 4- or 8-bit-per-pixel GPU format occupies approximately **1.33 or 2.67 MiB** including mipmaps: 8× or 4× below RGBA8. Unsupported-format fallback can erase this advantage. Precomputed mipmaps add roughly one-third to texture storage but eliminate runtime mip generation and improve distant sampling. [Khronos texture guidance](https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/KTXArtistGuide.md)

Example offline commands, **not executed**:

```sh
gltf-transform etc1s input.glb etc1s.glb --quality 200 --mipmaps true
gltf-transform uastc input.glb uastc.glb --level 2 --rdo 1 --zstd 18 --mipmaps true
```

Use glTF Transform with compatible KTX tools; preserve sRGB colour handling. Compare UASTC without Zstd as a separate experiment. [Command guidance](https://github.com/KhronosGroup/3D-Formats-Guidelines/blob/main/subpages/KTXArtistGuide_glTF-Transform.md)

**Texture resolution.** Halving both dimensions quarters pixels, GPU storage and approximate upload volume; compressed download savings might be **50–75%**. Trial maximum dimensions of L4=512, L3=1024, L2=1024, L1=2048, preserving aspect ratio:

`gltf-transform resize input.glb resized.glb --width 1024 --height 1024`

These are starting settings, not universal prescriptions: coarse tiles can cover much larger areas. Judge screen-space texel density. The elevated chase camera permits substantial reduction; the horizon view exposes blurred façades and rooflines sooner. [CLI reference](https://gltf-transform.dev/cli)

**WebP/AVIF.** Test `gltf-transform webp input.glb output.glb` or `avif`. Estimated savings against existing JPEGs might be **10–35%** and **20–50%**, respectively, with possible added artifacts; AVIF decode can be significantly slower on weak CPUs. Both expand to ordinary GPU textures, so **GPU memory and upload volume remain essentially unchanged**. r160 supports their glTF extensions when browser decoding is available. [r160 loader](https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/loaders/GLTFLoader.js)

**Geometry.** Prefer meshopt for streaming: `gltfpack -i input.glb -o output.glb -c` combines compression with quantisation and cache/fetch optimisation. Pin a compatible encoder/decoder pair producing `EXT_meshopt_compression`, rather than newer extensions unsupported by r160. Draco (`gltf-transform draco …`) may compress some meshes better but usually costs more decoding work. Neither codec alone guarantees smaller decoded GPU buffers. [gltfpack](https://raw.githubusercontent.com/zeux/meshoptimizer/master/gltf/README.md)

`KHR_mesh_quantization` retains compact attributes on the GPU and needs no extra decoder in r160. Trial 14–16-bit positions and sufficiently precise UVs; validate adjacent boundaries and texture seams. [Quantisation specification](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)

Vertex cache/fetch reordering changes neither appearance nor vertex count; overdraw optimisation through `meshopt_optimizeOverdraw` may reduce fragment work, with limited benefit for already simple unlit shading. Simplification, for example `gltfpack … -si 0.8`, reduces geometry bytes, upload and rendering work, but threatens roof silhouettes, bridges, thin structures and tile boundaries. Preserve boundaries and recompute conservative geometric errors. Existing four-level simplification makes aggressive additional decimation a lower priority. [meshoptimizer](https://github.com/zeux/meshoptimizer)

Remove demonstrably unused normals/tangents through glTF Transform’s attribute API: float normals alone cost 12 bytes/vertex. Preserve attributes used by gameplay or custom shaders. Remove skirts only after proving they do not conceal cracks.

**Containers and grouping.** `npx 3d-tiles-tools b3dmToGlb -i tile.b3dm -o tile.glb` extracts GLB; proper 1.1 migration must also preserve RTC offsets, transforms and metadata. Wrapper removal itself saves little. [3D Tiles Tools](https://github.com/CesiumGS/3d-tiles-tools)

Merging reduces requests, but merging separate textures does not automatically reduce draw calls without atlasing. Larger tiles worsen culling, eviction granularity and indivisible uploads. Prefer experimentally bundling **4–16 spatial neighbours** while keeping their render identities; avoid wholesale re-tiling initially.

**Runtime changes**

Configure one shared `KTX2Loader`, call `detectSupport(renderer)`, supply its matching transcoder JavaScript/WASM, and attach it through `setKTX2Loader()`. Attach `MeshoptDecoder` through `setMeshoptDecoder()`; Draco instead requires `DRACOLoader` and its decoder. [r160 KTX2Loader](https://raw.githubusercontent.com/mrdoob/three.js/r160/examples/jsm/loaders/KTX2Loader.js)

On two cores, start with **one transcoder worker**. Planning ranges per tile are roughly meshopt **1–10 ms**, Draco **5–50+ ms**, and Basis transcoding **5–100+ ms**; these are deliberately broad, unmeasured estimates. WASM startup and concurrent-worker memory also matter. More workers can steal rendering CPU.

Move extraction/decompression into workers using transferable buffers. Full glTF worker parsing needs serialisable results and main-thread reconstruction; it is not a GLTFLoader switch. Reuse existing `createImageBitmap` support.

Queue ready tiles and initially allow one texture upload per frame with a **1–2 ms submission budget**. `renderer.initTexture()` uploads eagerly but remains indivisible; it does not enforce that budget. True strip/block `texSubImage2D` or `compressedTexSubImage2D` budgeting requires custom renderer integration and complete mip handling—probably excessive here. Precomputed KTX2 mipmaps are the simpler solution. Prewarm material variants using `compileAsync()` where parallel compilation is available. [r160 renderer](https://raw.githubusercontent.com/mrdoob/three.js/r160/src/renderers/WebGLRenderer.js)

Prioritise missing coarse coverage, visible detail, then predicted travel. At 50–70 km/h, **3–5 seconds predicts 42–97 metres**; include the chase-camera footprint and turns. Abort obsolete fetches, discard stale decode results, and cap decoded-but-not-uploaded memory.

Use frame-time-driven screen-space error, separate refinement/coarsening thresholds, and a 2–5-second retention grace period. Keep a small coarse base resident. For REPLACE, retain the parent until all required replacement coverage is ready; failed children must not create holes.

Treat the supplied budgets as ceilings, reserving approximately **25–35%** for transient work and other rendering. Browser VRAM pressure is not reliably exposed. Start DPR at 1 on weak devices; dropping 2→1 quarters framebuffer pixels, though tile-texture memory falls only if selection also adapts.

**Caching, delivery and validation**

Inspect both redirect and CDN response headers. A cached body does not guarantee the resolve request disappears; 302 caching depends on explicit freshness and cache rules. Use immutable versioned URLs. [HTTP caching standard](https://www.rfc-editor.org/rfc/rfc9111.html)

Cache successful CORS-readable bytes under `{dataset-version, tile-id}` in Cache Storage, with a byte-based LRU cap—initially perhaps **256 MB phone / 1 GB laptop**, constrained by `navigator.storage.estimate()`. A service worker can serve the application and tiles; Cache Storage also works without one. OPFS suits indexed bundles but adds implementation work. Persistence requests may be denied and do not preserve GPU resources. [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache), [storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)

HTTP/2–3 reuse connections but retain per-request overhead. A direct static CDN removes the resolve hop. Range-capable hosting enables indexed packs, but one range per tile still means one request: coalesce neighbouring ranges, verify 206/CORS behaviour, and avoid downloading the entire city archive.

For every ranked step, repeat the same route and camera on the HD 620 with cold and warm caches. Record start bytes/time, request count, decode/upload durations, estimated resident bytes, p95/p99 frame time, frames over 50 ms, and screenshots. Test codec quality for step 2, initial coverage for 3, failures/U-turns for 4, seams for 5, offline repeats for 6, and request waterfalls for 7.

Whole-city preloading, indiscriminate UASTC, aggressive decimation, and custom partial uploads are poor first investments. Actual startup dependencies, eviction behaviour, function-level faults and achievable timings remain unresolved until the repository is readable.

---

## Notes from this project (not from Codex)

Already in `js/stream.js`: at most 6 requests in flight; at most 2 new tiles enter the scene per frame after
`renderer.initTexture`; a coarse base layer (49 L4 tiles) that is never evicted; a parent stays until its children
are in; look-ahead along the velocity; obsolete requests are cancelled; LRU eviction over a budget; an occlusion
step. Not there: compressed textures, precomputed mipmaps, texture sizes per level, any persistent cache, detail
that follows the frame time, retry of failed tiles. The parent repo has `optimize_tiles.py` (meshopt / KTX2 via
gltf-transform) from an earlier experiment.
