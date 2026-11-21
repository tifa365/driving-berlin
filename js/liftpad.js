// A plain grey lift platform (owner 2026-11-21: "a grey platform instead" of glowing discs and the
// bear lift). Shared look for every lift in the game (js/roofs.js; the S-Bahn may use it too):
// a flat slab, calm neutral grey, a darker rim and a few darker chevrons pointing along the long
// axis (local +x), no letters, no glow, nothing animated. Unlit (MeshBasicMaterial) like the
// photogrammetric city, so it reads the same in every mood.
//
//   const pad = makeLiftPad({ length: 14, width: 5, thick: 0.35 });
//   scene.add(pad); pad.position.set(x, yTop, z); pad.rotation.y = Math.PI / 2 - h;   // chevrons along heading h (forward (sin h, -cos h))
// Local frame: origin at the centre of the TOP surface (y = 0 is where the wheels stand), long
// axis = local x, the chevrons point to +x, the slab hangs down to y = -thick.
import * as THREE from 'three';

export const LIFTPAD_COLORS = { top: '#8c8f92', rim: '#5d6063', chevron: '#76797c', side: 0x6b6e71 };

const texCache = new Map();
function topTexture(length, width, accent = null, fill = null) {
  const key = `${length}x${width}x${accent}x${fill}`;
  if (texCache.has(key)) return texCache.get(key);
  const ppm = 32, w = Math.round(length * ppm), h = Math.round(width * ppm);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), C = LIFTPAD_COLORS;
  g.fillStyle = accent || C.rim; g.fillRect(0, 0, w, h);              // rim (0.3 m; accent: 0.5 m in that colour)
  const r = Math.round((accent ? 0.5 : 0.3) * ppm);
  g.fillStyle = fill || C.top; g.fillRect(r, r, w - 2 * r, h - 2 * r);   // fill: optional colour of the deck itself
  g.strokeStyle = accent || C.chevron; g.lineWidth = Math.round(0.28 * ppm); g.lineJoin = 'miter';   // chevrons, pointing +x
  const n = Math.max(2, Math.floor(length / 3.5)), arm = 0.32 * h;
  for (let k = 0; k < n; k++) {
    const cx = (k + 1) * w / (n + 1) + arm / 2;
    g.beginPath(); g.moveTo(cx - arm, h / 2 - arm); g.lineTo(cx, h / 2); g.lineTo(cx - arm, h / 2 + arm); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

// accent: optional colour for the rim + chevrons (a lift that should be found: S-Bahn green)
export function makeLiftPad({ length = 14, width = 5, thick = 0.35, accent = null, fill = null, side: sideCol = null } = {}) {
  // polygonOffset: the slab wins against the photogrammetric pavement it lies on (no z-fighting)
  const side = new THREE.MeshBasicMaterial({ color: sideCol ?? LIFTPAD_COLORS.side, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const top = new THREE.MeshBasicMaterial({ map: topTexture(length, width, accent, fill), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const box = new THREE.Mesh(new THREE.BoxGeometry(length, thick, width), [side, side, top, side, side, side]);
  box.position.y = -thick / 2;
  const g = new THREE.Group(); g.name = 'liftpad'; g.add(box);
  g.userData = { length, width, thick };
  return g;
}

// A beacon for a lift stop: a soft translucent column of light standing on the slab, brightest at
// the base and fading out upward, plus a faint ground glow. Steady (no blinking), no letters, not an
// occluder (no depth write; js/camcollide.js only counts userData.world meshes). Set `.setFade(f)`
// (0..1) per frame for a distance fade; the colour is the lift's (S-Bahn green, the roof lift white).
//   const b = makeLiftBeacon({ color: '#1fbf6a', height: 20, radius: 2.6, opacity: 0.5 });
//   scene.add(b); b.position.set(x, yTop, z); b.setFade(1);
const beamTex = (() => {
  let t = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas'); c.width = 4; c.height = 256;
    const g = c.getContext('2d'), gr = g.createLinearGradient(0, 256, 0, 0);   // canvas bottom = column base
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,0.7)');
    gr.addColorStop(0.45, 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
    t = new THREE.CanvasTexture(c); return t;
  };
})();
const glowTex = (() => {
  let t = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    t = new THREE.CanvasTexture(c); return t;
  };
})();
// camFade: [near, far] m from the camera - full below near, gone beyond far (on its own, every frame,
// via onBeforeRender), times setFade(f) (a caller's own fade, e.g. by distance to the car)
export function makeLiftBeacon({ color = '#1fbf6a', height = 20, radius = 2.6, opacity = 0.5, glow = 1.6, camFade = [350, 800] } = {}) {
  const mat = new THREE.MeshBasicMaterial({ color, map: beamTex(), transparent: true, opacity, depthWrite: false,
                                            side: THREE.DoubleSide, toneMapped: false, fog: false });
  const col = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.8, radius, height, 32, 1, true), mat);
  col.position.y = height / 2; col.renderOrder = 5;
  const gm = new THREE.MeshBasicMaterial({ color, map: glowTex(), transparent: true, opacity: opacity * 0.9, depthWrite: false,
                                           toneMapped: false, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius * glow, 40), gm);
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.04; disc.renderOrder = 5;
  const g = new THREE.Group(); g.name = 'liftbeacon'; g.add(col, disc);
  let own = 1;
  const wp = new THREE.Vector3();
  const apply = (cam) => {
    let f = own;
    if (cam && camFade) { g.getWorldPosition(wp); f *= 1 - Math.min(1, Math.max(0, (wp.distanceTo(cam.position) - camFade[0]) / (camFade[1] - camFade[0]))); }
    mat.opacity = opacity * f; gm.opacity = opacity * 0.9 * f;
  };
  col.onBeforeRender = (r, sc, cam) => apply(cam);
  disc.onBeforeRender = (r, sc, cam) => apply(cam);
  g.setFade = (f) => { own = f; g.visible = f > 0.01; apply(null); };
  return g;
}
