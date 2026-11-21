// No-drive zones: places the car must not drive onto. Entering one (on the ground)
// hands the car to the Rescue Bear, who lifts it straight up and sets it back on
// the street it came from (index.html, sinking.kind 'nodrive'). No sound, no joke.
// One exception (owner, 2026-11-21): entering the memorial shows "Respect is Everything."
// (js/respect.js, at most once per 20 s); other zones show nothing.
//
// Outlines in lon/lat (WGS84), converted with the exact frame of build_level.py /
// build_stream.py: ENU around level.origin, three.js X = E, Z = -N.
// To add a place: append { name, en, ring: [[lon, lat], ...] }.

export const NO_DRIVE = [
  {
    name: 'Denkmal für die ermordeten Juden Europas',
    en: 'Memorial to the Murdered Jews of Europe',
    // OSM way 172234733 (historic=monument, tourism=attraction), the stelae field
    ring: [
      [13.3774334, 52.5131524], [13.3799947, 52.5136547], [13.3799737, 52.5136972],
      [13.3797992, 52.5140489], [13.3797662, 52.5141131], [13.3796118, 52.5144009],
      [13.3794781, 52.5146468], [13.3792175, 52.5146002], [13.3790565, 52.5145787],
      [13.3777128, 52.5144918], [13.3774376, 52.5131816],
    ],
  },
];

const A = 6378137.0, F = 1 / 298.257223563, E2 = F * (2 - F);
function ecef(lat, lon) {
  const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
  const N = A / Math.sqrt(1 - E2 * Math.sin(la) ** 2);
  return [N * Math.cos(la) * Math.cos(lo), N * Math.cos(la) * Math.sin(lo), N * (1 - E2) * Math.sin(la)];
}
// lon/lat -> level frame [x, z] (same as build_level.py to_en, z = -north)
export function lonLatToLocal(origin, lon, lat) {
  const la = origin.lat * Math.PI / 180, lo = origin.lon * Math.PI / 180;
  const o = ecef(origin.lat, origin.lon), p = ecef(lat, lon);
  const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const e = -Math.sin(lo) * d[0] + Math.cos(lo) * d[1];
  const n = -Math.sin(la) * Math.cos(lo) * d[0] - Math.sin(la) * Math.sin(lo) * d[1] + Math.cos(la) * d[2];
  return [e, -n];
}

function pip(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[j];
    if ((z1 > z) !== (z2 > z) && x < (x2 - x1) * (z - z1) / (z2 - z1) + x1) c = !c;
  }
  return c;
}

// origin: level.origin; extent: level.extent (zones fully outside are dropped)
export function createNoDrive({ origin, extent }) {
  const zones = [];
  for (const d of NO_DRIVE) {
    const poly = d.ring.map(([lon, lat]) => lonLatToLocal(origin, lon, lat));
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    const box = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
    if (extent && (box.maxX < extent.minX || box.minX > extent.maxX || box.maxZ < extent.minZ || box.minZ > extent.maxZ)) continue;
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cz = zs.reduce((a, b) => a + b, 0) / zs.length;
    zones.push({ name: d.name, en: d.en, poly, box, cx, cz });
  }
  const zoneAt = (x, z) => zones.find((q) => x >= q.box.minX && x <= q.box.maxX && z >= q.box.minZ && z <= q.box.maxZ && pip(q.poly, x, z)) || null;
  // car footprint: centre or any corner of the body inside -> "the car is on it"
  // (half length / half width in metres). `reach` extends the probe ahead of the
  // bumpers only (not sideways): on `mitte` some stele obstacles stick up to
  // 1.8 m out of the OSM outline, the car must be lifted before it touches one.
  // The bordering streets are >= 9 m from the outline, the side pavements are
  // not probed sideways, so driving past never triggers.
  function hit(x, z, heading, halfLen = 2, halfWid = 0.9, reach = 2) {
    if (!zones.length) return null;
    const s = Math.sin(heading), c = Math.cos(heading);   // forward = (sin h, -cos h)
    const f = halfLen + reach;
    const pts = [[0, 0], [halfLen, halfWid], [halfLen, -halfWid], [-halfLen, halfWid], [-halfLen, -halfWid],
                 [f, halfWid], [f, -halfWid], [-f, halfWid], [-f, -halfWid]];
    for (const [f, r] of pts) {
      const q = zoneAt(x + s * f + c * r, z - c * f + s * r);
      if (q) return q;
    }
    return null;
  }

  return { zones, inside: (x, z) => !!zoneAt(x, z), zoneAt, hit };
}
