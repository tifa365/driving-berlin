// Published-site settings. Optional site.json next to index.html (written by tools/publish_site.py):
//   { "tiles": "<url>/", "gz": true }
//   tiles  where the 3D Tiles live (replaces tiles.json's "base"; e.g. a Hugging Face dataset)
//   gz     the level's .bin files are stored as <name>.bin.gz (static hosts do not compress .bin)
// Absent (local play with serve.py) = exactly the old behaviour: tiles from tiles.json's "base"
// ("tiles/", served by serve.py) and plain .bin files.
export const site = await fetch(new URL('../site.json', import.meta.url))
  .then((r) => (r.ok ? r.json() : {}), () => ({})).catch(() => ({})) || {};

// fetchBin(url[, init]): fetch() for a level .bin file; with site.gz it loads url + '.gz' and
// unpacks it. Returns a Response either way (r.ok / r.status / r.arrayBuffer() as with fetch).
// The gzip magic is checked, so a host that already decodes it (Content-Encoding) still works.
export async function fetchBin(url, init) {
  if (!site.gz) return fetch(url, init);
  const r = await fetch(url + '.gz', init);
  if (!r.ok) return r;
  let b = await r.arrayBuffer();
  const m = new Uint8Array(b, 0, Math.min(2, b.byteLength));
  if (m[0] === 0x1f && m[1] === 0x8b) b = await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new Response(b, { status: 200 });
}
