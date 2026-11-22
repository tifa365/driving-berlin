// ?mood=day|moon|snow - sky and light moods for the photogrammetric mesh
// (day: blue sky with clouds; moon: moonlit night with stars;
// snow: falling snow, snow on the mesh, tyre tracks).
// The mesh has midday light baked into its textures and is drawn unlit, so we fake
// the mood instead of relighting: colour grade + fake sun side-light in the mesh
// shader, a gradient sky with an HDR sun, height/distance fog in the sky's horizon
// colour, bloom + ACES in post, recoloured car lights, tail lights, headlight pool.
// Nothing here runs without ?mood= (index.html only calls in behind `if (mood)`).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { PHOTO_GLSL } from './sky.js';   // day: the photographed sky (js/sky.js) in the dome and the fog

// Colours are sRGB hex; tints / ambients are linear multipliers (1 = unchanged).
// Sun: compass azimuth (deg from north) and elevation (deg); low, so the default
// chase camera (which looks ~10 deg down) still catches the disc down a street.
const PRESETS = {
  // bright day: the baked noon light is right, so the mesh is left exactly as in the plain
  // game (neutral grade, no fake light, no tone mapping, bloom only on the HDR sun); the mood
  // adds the sky, sun high in the south-west, fair-weather clouds, and the fog. photo: the
  // photographed sky of js/sky.js replaces the drawn one once loaded (its sun sets sunAz / sunEl)
  day: {
    photo: true,
    zenith: '#1f5fc4', mid: '#5aa2ea', horizon: '#c3def5', sun: '#fff3d6', bg: '#9cc4ee',
    sunAz: 225, sunEl: 42, sunSize: 1.3, sunInt: 30, halo: 0.25, glow: 0.12, stripes: 0, stars: 0, clouds: 0.75, moon: 0,
    sat: 1, contrast: 1, shadowTint: [1, 1, 1], highTint: [1, 1, 1], exposure: 1,
    ambSky: [1, 1, 1], ambGround: [1, 1, 1], sunLight: 0,
    fogDist: 900, fogHeight: 80, fogHeightAmt: 0.4, edgeFade: 90,
    bloomStrength: 0.12, bloomRadius: 0.4, bloomThreshold: 1.5,
    toneMap: 'none', toneExposure: 1, vignette: 0,
    carHemi: 2.2, carSun: 1.6, tail: 1.5, headlight: 0,
    cam: { height: 20, dist: 50, lookUp: 10 },
  },
  // moonlit night: the "sun" is a full moon low in the west (visible down the street),
  // stars above, cold blue grade, headlights and tail lights carry the picture
  moon: {
    zenith: '#01030d', mid: '#06102a', horizon: '#142848', sun: '#dfe9ff', bg: '#0a1428',
    sunAz: 258, sunEl: 3.8, sunSize: 1.5, sunInt: 1.3, halo: 0.22, glow: 0.1, stripes: 0, stars: 6, clouds: 0, moon: 1,
    sat: 0.38, contrast: 1.2, shadowTint: [0.5, 0.68, 1.15], highTint: [0.82, 0.92, 1.2], exposure: 0.26,
    ambSky: [0.5, 0.62, 0.95], ambGround: [0.24, 0.3, 0.46], sunLight: 0.55,
    fogDist: 380, fogHeight: 45, fogHeightAmt: 0.5, edgeFade: 90,
    bloomStrength: 0.6, bloomRadius: 0.55, bloomThreshold: 0.9,
    toneExposure: 1.0, vignette: 0.5,
    carHemi: 0.7, carSun: 0.9, tail: 7, headlight: 1.1,
    cam: { height: 20, dist: 50, lookUp: 10 },
  },
  // Snow: overcast, falling flakes (GPU-animated points around the camera), snow lying on
  // every up-facing face of the mesh (derived normals), slush on the streets - and the car
  // cuts tyre tracks into it that stay (trail texture over the level, see `snow` below)
  snow: {
    zenith: '#7d8896', mid: '#a9b3bf', horizon: '#d3d9e0', sun: '#fff4e6', bg: '#c8cfd8',
    sunAz: 200, sunEl: 14, sunSize: 3.5, sunInt: 0.35, halo: 0.25, glow: 0.15, stripes: 0, stars: 0, clouds: 0, moon: 0,
    sat: 0.6, contrast: 0.92, shadowTint: [0.86, 0.94, 1.08], highTint: [1.0, 1.0, 1.02], exposure: 0.9,
    ambSky: [0.98, 1.0, 1.04], ambGround: [0.62, 0.66, 0.74], sunLight: 0.1,
    fogDist: 230, fogHeight: 60, fogHeightAmt: 0.3, edgeFade: 90,
    bloomStrength: 0.15, bloomRadius: 0.5, bloomThreshold: 1.0,
    toneExposure: 1.0, vignette: 0.3,
    carHemi: 2.2, carSun: 0.8, tail: 5, headlight: 0.3,
    cam: { height: 20, dist: 50, lookUp: 10 },
    ghost: '#1c2c50',
    snow: { flakes: 40000, street: 0.6, track: 0.6 },   // flake count; street cover 0..1; tyre track width (m)
    frozen: true,   // water is ice: drive on it, no sinking (index.html: mood.frozen, iceLevelAt, ice grip)
  },
};

// Sky colour for a world direction - used by the sky dome AND the mesh fog, so the
// fogged level edge melts into the horizon without a seam. Below the horizon the
// sky repeats the horizon (the void past the mesh must look like fog).
const SKY_GLSL = /* glsl */`
#ifdef SKY_PHOTO
${PHOTO_GLSL}
#endif
uniform vec3 uZenith, uMid, uHorizon, uSunCol, uSunDir;
uniform float uSunSize, uSunInt, uHalo, uGlow, uStripes, uStars, uClouds, uMoon;
float mHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float mNoise(vec2 x) {
  vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(vec3(i, 1.0)), mHash(vec3(i + vec2(1.0, 0.0), 1.0)), f.x),
             mix(mHash(vec3(i + vec2(0.0, 1.0), 1.0)), mHash(vec3(i + vec2(1.0, 1.0), 1.0)), f.x), f.y);
}
float mFbm(vec2 x) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * mNoise(x); x = x * 2.03 + 7.1; a *= 0.5; } return s; }
vec3 moodSky(vec3 d, float disc) {
#ifdef SKY_PHOTO
  if (uSkyOn > 0.5) return photoSky(d);   // the picture (until it is loaded: the drawn sky below)
#endif
  if (d.y < 0.0) d = normalize(vec3(d.x, 0.0, d.z) + 1e-6);
  float y = d.y;
  vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.12, y));
  c = mix(c, uZenith, smoothstep(0.08, 0.5, y));
  vec3 dh = normalize(vec3(d.x, 0.0, d.z) + 1e-6), sh = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
  float az = max(dot(dh, sh), 0.0);
  c += uSunCol * uGlow * pow(az, 4.0) * exp(-y * 7.0);          // warm band toward the sun
  // fair-weather clouds on a plane overhead (none at y = 0, so the fog colour stays cloudless)
  float cover = 0.0;
  if (uClouds > 0.0 && y > 0.0) {
    float n = mFbm(d.xz / (y + 0.1) * 0.9);
    cover = smoothstep(0.48, 0.72, n) * uClouds * smoothstep(0.0, 0.1, y);
    c = mix(c, mix(uHorizon, vec3(1.0), 0.85) * (0.82 + 0.3 * smoothstep(0.5, 0.9, n)), cover);
  }
  // stars: one per random cell of a 3D grid cut by the sky sphere; dome only, fading into the haze
  if (uStars > 0.0 && disc > 0.5) {
    vec3 p = d * 120.0, id = floor(p);
    if (mHash(id) > 0.972) {
      vec3 sp = id + 0.5 + 0.5 * (vec3(mHash(id + 1.3), mHash(id + 2.7), mHash(id + 4.1)) - 0.5);
      float tw = 0.25 + 0.75 * mHash(id + 7.0);
      c += vec3(0.85, 0.92, 1.0) * uStars * tw * smoothstep(0.2, 0.0, length(p - sp)) * smoothstep(0.004, 0.05, y) * (1.0 - cover);
    }
  }
  float s = max(dot(d, uSunDir), 0.0);
  c += uSunCol * uHalo * (0.5 * pow(s, 16.0) + disc * 2.0 * pow(s, 300.0));
  if (disc > 0.5) {
    float r = acos(min(s, 1.0)) / uSunSize;                       // 1 at the rim
    float m = 1.0 - smoothstep(0.96, 1.0, r);
    // synthwave stripes across the lower half of the disc, thinning toward the top
    float v = (d.y - uSunDir.y) / sin(uSunSize);                  // -1 bottom .. 1 top
    float gap = uStripes * step(v, 0.3) * step(fract(v * 5.0), clamp(0.6 * (0.35 - v), 0.0, 0.7));
    // moon: grey maria from noise over the disc
    vec3 rt = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
    vec2 l = vec2(dot(d - uSunDir, rt), v * sin(uSunSize)) / sin(uSunSize);
    float maria = mix(1.0, 0.5 + 0.5 * smoothstep(0.35, 0.6, mFbm(l * 1.8 + 3.0)), uMoon);
    c += uSunCol * uSunInt * m * (1.0 - gap) * maria * (1.0 - cover);
  }
  return c;
}`;

// Mesh-shader extras for snow, compiled only behind its #define (the sky moods
// compile exactly the code they had). moodGround: the level's height model as a
// texture, so the shader knows "street level" vs "roof" (height above ground).
const EXTRA_GLSL = /* glsl */`
#ifdef MOOD_SNOW
uniform sampler2D uGround;
uniform vec4 uGroundBox;                       // minX, minZ, 1/width, 1/depth
float moodGround(vec2 xz) { return texture2D(uGround, (xz - uGroundBox.xy) * uGroundBox.zw).r; }
uniform sampler2D uTrail;                      // tyre tracks, same box as uGround
uniform float uSnowStreet;
vec3 moodSnow(vec3 a, vec3 n) {
  float hg = vMoodW.y - moodGround(vMoodW.xz);
  float nz = mFbm(vMoodW.xz * 0.45);                                  // drifts: patchy at metre scale
  float cover = smoothstep(0.35, 0.75, n.y + 0.4 * (nz - 0.5));       // up-facing faces hold the snow
  // street level: driven into slush (keeps the road readable), darker where tyres went;
  // generous band: in places the height model sits 3+ m under the mesh road
  float street = 1.0 - smoothstep(2.5, 5.0, hg);
  float trail = texture2D(uTrail, (vMoodW.xz - uGroundBox.xy) * uGroundBox.zw).r;
  trail *= street;
  cover *= mix(1.0, uSnowStreet * (0.65 + 0.5 * nz) * (1.0 - trail), street);
  vec3 snow = mix(vec3(0.8, 0.84, 0.92), vec3(0.5, 0.52, 0.56), street * 0.5);   // street snow is trodden grey
  a *= 1.0 - 0.6 * trail;                                             // tracks: wet, dark asphalt
  return mix(a, snow * (0.85 + 0.25 * nz), clamp(cover, 0.0, 1.0));
}
#endif`;

const hexLin = (h) => new THREE.Color(h);   // ColorManagement converts sRGB hex -> linear
function sunDir(azDeg, elDeg) {               // compass -> three (X=E, Y=U, Z=-N)
  const a = THREE.MathUtils.degToRad(azDeg), e = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}
function canvasTex(w, h, paint) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Runs the caller's existing multi-call draw (world -> shadow -> ghost -> car)
// into the composer's buffer: same target, so the ghost pass still sees the
// world's depth. Draws into readBuffer without a swap, like RenderPass.
class DrawPass extends Pass {
  constructor() { super(); this.needsSwap = false; this.draw = null; }
  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    this.draw();
  }
}

export function createMood(name, { renderer, scene, camera, extent, ground, groundAt, sky: photoSky = null }) {
  if (!name || !PRESETS[name]) { if (name) console.warn(`unknown ?mood=${name}, try ${Object.keys(PRESETS)}`); return null; }
  const params = new URLSearchParams(location.search);
  const P = structuredClone(PRESETS[name]);
  document.body.style.background = P.bg;       // no grey flash while loading

  // shared uniforms: every graded mesh material and the sky point at the same objects
  const U = {
    uZenith: { value: new THREE.Color() }, uMid: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() }, uSunCol: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3() }, uSunSize: { value: 0 }, uSunInt: { value: 0 },
    uHalo: { value: 0 }, uGlow: { value: 0 }, uStripes: { value: 0 },
    uStars: { value: 0 }, uClouds: { value: 0 }, uMoon: { value: 0 },
    uSat: { value: 0 }, uContrast: { value: 1 }, uShadowTint: { value: new THREE.Vector3() }, uHighTint: { value: new THREE.Vector3() },
    uExposure: { value: 1 }, uAmbSky: { value: new THREE.Vector3() }, uAmbGround: { value: new THREE.Vector3() },
    uSunLight: { value: 0 }, uFogDist: { value: 300 }, uFogHeight: { value: 40 }, uFogHeightAmt: { value: 0 },
    uFogBase: { value: ground }, uEdgeFade: { value: 90 },
    uExtent: { value: new THREE.Vector4(extent.minX, extent.minZ, extent.maxX, extent.maxZ) },
    uTime: { value: 0 },
  };
  const FX = P.snow ? 'MOOD_SNOW' : null;   // structural extras (EXTRA_GLSL)
  // photographed sky (js/sky.js): its uniforms join U; the sun stands where the picture's sun is
  const photo = !!(P.photo && photoSky);
  if (photo) { Object.assign(U, photoSky.uniforms); P.sunAz = photoSky.sunAz; P.sunEl = photoSky.sunEl; }
  if (FX) setupGround();

  // ---- mesh grade ----
  const gradeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = 'varying vec3 vMoodW;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n  vMoodW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FX ? '\n#define ' + FX : ''}${photo ? '\n#define SKY_PHOTO' : ''}
varying vec3 vMoodW;
uniform float uSat, uContrast, uExposure, uSunLight, uFogDist, uFogHeight, uFogHeightAmt, uFogBase, uEdgeFade;
uniform vec3 uShadowTint, uHighTint, uAmbSky, uAmbGround;
uniform vec4 uExtent;
${SKY_GLSL}
${EXTRA_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  {
    // grade: desaturate, split-tone (shadows indigo, highlights warm) - hides the noon look
    vec3 a = diffuseColor.rgb;
    float lum = dot(a, vec3(0.2126, 0.7152, 0.0722));
    a = mix(vec3(lum), a, uSat) * mix(uShadowTint, uHighTint, smoothstep(0.02, 0.3, lum));
    a = 0.18 * pow(a / 0.18, vec3(uContrast));                    // contrast around mid grey
    // fake light: face normal from screen-space derivatives (world.glb has no reliable
    // normals); sky fill from above, low sun on the faces turned toward it
    vec3 n = normalize(cross(dFdx(vMoodW), dFdy(vMoodW)));
    vec3 light = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5) + uSunCol * uSunLight * max(dot(n, uSunDir), 0.0);
#ifdef MOOD_SNOW
    a = moodSnow(a, n);
#endif
    diffuseColor.rgb = a * light * uExposure;
  }`)
      .replace('#include <fog_fragment>', `{
    // distance fog (gaussian: near stays clear) thinning with height, plus a fade
    // toward the level border so the mesh never ends in a visible cliff
    vec3 v = vMoodW - cameraPosition;
    float f = 1.0 - exp(-pow(length(v) / uFogDist, 2.0));
    f *= mix(1.0, exp(-max(vMoodW.y - uFogBase, 0.0) / uFogHeight), uFogHeightAmt);
    float sd = max(max(uExtent.x - vMoodW.x, vMoodW.x - uExtent.z), max(uExtent.y - vMoodW.z, vMoodW.z - uExtent.w));
    f = max(f, smoothstep(-uEdgeFade, 0.0, sd));
    gl_FragColor.rgb = mix(gl_FragColor.rgb, moodSky(normalize(vec3(v.x, 0.0, v.z) + 1e-6), 0.0), f);
  }`);
  };
  function gradeMaterial(mat) { mat.onBeforeCompile = gradeCompile; mat.needsUpdate = true; }

  // ---- sky dome: follows the camera, drawn first, writes no depth ----
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), new THREE.ShaderMaterial({
    uniforms: U, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false, defines: photo ? { SKY_PHOTO: '' } : {},
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir;\n${SKY_GLSL}\nvoid main() { gl_FragColor = vec4(moodSky(normalize(vDir), 1.0), 1.0); }`,
  }));
  sky.renderOrder = -1; sky.frustumCulled = false; scene.add(sky);
  scene.fog = null;                     // the mesh shader does its own fog

  // ---- post: HDR target (MSAA where float targets render), bloom, ACES ----
  const floatOK = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
  const samples = floatOK && params.get('msaa') !== '0' ? 4 : 0;
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType, samples });
  const composer = new EffectComposer(renderer, rt);
  const drawPass = new DrawPass();
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0.5, 1);
  const output = new OutputPass();
  // vignette before tone mapping, 1/255 dither after (8-bit sky gradients band)
  output.uniforms.uVignette = { value: 0 };
  output.material.fragmentShader = output.material.fragmentShader
    .replace('uniform sampler2D tDiffuse;', 'uniform sampler2D tDiffuse;\nuniform float uVignette;')
    .replace('gl_FragColor = texture2D( tDiffuse, vUv );',
      'gl_FragColor = texture2D( tDiffuse, vUv );\n vec2 q = vUv - 0.5; gl_FragColor.rgb *= 1.0 - uVignette * dot(q, q) * 2.0;')
    .replace(/\}\s*$/, ' gl_FragColor.rgb += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;\n}');
  composer.addPass(drawPass); composer.addPass(bloom); composer.addPass(output);
  function setSize(w, h) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
  setSize(innerWidth, innerHeight);

  // ---- car: lights, tail lights, headlight pool ----
  const car = {};
  const glowTex = canvasTex(64, 64, (g, w) => {
    const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.6)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, w);
  });
  const carFx = new THREE.Group();
  const tails = [-1, 1].map(() => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending,
                                                         depthWrite: false, fog: false }));
    carFx.add(s); return s;
  });
  // beam on the ground: soft ellipse ahead of the bumper (canvas bottom = car end)
  const beamTex = canvasTex(128, 256, (g, w, h) => {
    const R = 0.76 * h;                              // ellipse centre near the bumper end, all edges soft
    g.setTransform((w / 2 - 2) / R, 0, 0, 1, w / 2, 0.78 * h);
    const r = g.createRadialGradient(0, 0, 0, 0, 0, R);
    r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(0.5, 'rgba(255,255,255,0.4)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.beginPath(); g.arc(0, 0, R, 0, 2 * Math.PI); g.fill();
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-in';   // fade out under the car
    const f = g.createLinearGradient(0, h, 0, 0.7 * h);
    f.addColorStop(0, 'rgba(0,0,0,0)'); f.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = f; g.fillRect(0, 0, w, h);
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: beamTex, transparent: true, blending: THREE.AdditiveBlending,
                                  depthTest: false, depthWrite: false }));
  pool.renderOrder = 1;                  // after the blob shadow
  function attachCar({ carScene, carRoot, shadow, carScale, sunOffset, ghostMat }) {
    Object.assign(car, { carScene, carRoot, shadow, carScale, sunOffset, ghostMat });
    car.hemi = carScene.children.find((o) => o.isHemisphereLight);
    car.sun = carScene.children.find((o) => o.isDirectionalLight);
    carRoot.add(carFx);
    shadow.add(pool);                    // rides with the blob shadow (shadow pass, no depth test)
    apply();
  }
  function fitCar(model) {               // from the model's box (bigger than spec.bodyLength); forward is -Z
    if (!model) return;
    const p = model.parent; p?.remove(model); model.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(model); p?.add(model);
    const W = b.max.x - b.min.x, L = b.max.z - b.min.z;
    tails.forEach((s, i) => { s.position.set((i ? 1 : -1) * W * 0.33, b.min.y + 0.45 * (b.max.y - b.min.y), b.max.z + 0.05); s.scale.setScalar(0.6); });
    // shadow plane is non-uniformly scaled: compensate so the beam is 7 x 16 m
    const sc = car.shadow.scale, k = car.carScale;
    const len = 16 * k;
    pool.scale.set(7 * k / sc.x, 1, len / sc.z);
    pool.position.set(0, 0.01, -(L * k / 2 + len / 2 - 0.5) / sc.z);
    car.trackHalf = 0.36 * W * k;        // snow: wheel tracks either side of the centre line
  }

  // ---- snow: height model as a texture (street level vs roofs in the mesh shader) ----
  function setupGround() {
    const w = extent.maxX - extent.minX, d = extent.maxZ - extent.minZ;
    const nx = Math.ceil(w / 2), nz = Math.ceil(d / 2);              // the height model's 2 m cells
    const data = new Uint16Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++)
      data[j * nx + i] = THREE.DataUtils.toHalfFloat(groundAt(extent.minX + (i + 0.5) * w / nx, extent.minZ + (j + 0.5) * d / nz));
    const tex = new THREE.DataTexture(data, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;   // half float filters everywhere in WebGL2
    tex.unpackAlignment = 1; tex.needsUpdate = true;      // rows of nx * 2 bytes: not 4-aligned, would shear
    U.uGround = { value: tex };
    U.uGroundBox = { value: new THREE.Vector4(extent.minX, extent.minZ, 1 / w, 1 / d) };
  }

  // ---- snow: flakes + tyre tracks ----
  // Flakes: N random points in a unit cube; the vertex shader moves them (fall, wind,
  // flutter) and wraps them into a box in front of the camera - no CPU work per frame.
  // Drawn after the caller's passes (fxScene), so they fall in front of the car too.
  const fxScene = new THREE.Scene();
  let flakes = null, trail = null;
  if (P.snow) {
    const N = P.snow.flakes, pos = new Float32Array(N * 3);
    for (let i = 0; i < pos.length; i++) pos[i] = Math.random();
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    flakes = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uCenter: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector3(150, 55, 150) },
                  uPx: { value: 500 }, uSize: { value: 0.13 } },
      transparent: true, depthWrite: false,
      vertexShader: /* glsl */`
uniform float uTime, uPx, uSize; uniform vec3 uCenter, uBox;
varying float vA;
void main() {
  vec3 s = position, p = s * uBox;
  p.y -= uTime * (1.1 + 0.9 * fract(s.x * 13.7));                     // 1-2 m/s fall
  p.x += uTime * 0.8 + 0.9 * sin(uTime * 0.9 + s.z * 40.0);           // wind + flutter
  p.z += 0.7 * sin(uTime * 0.7 + s.y * 33.0);
  p = uCenter + mod(p - uCenter, uBox) - 0.5 * uBox;                  // endless: wrap into the box
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float z = -mv.z, sz = uSize * (0.6 + 0.8 * fract(s.y * 91.3)) * uPx / z;
  gl_PointSize = clamp(sz, 1.0, 36.0);
  // sub-pixel flakes dim instead of shrinking; none right at the lens, thinning into the fog
  vA = min(sz, 1.0) * smoothstep(2.0, 7.0, z) * exp(-z / 160.0);
}`,
      fragmentShader: /* glsl */`
varying float vA;
void main() { float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5)) * vA; gl_FragColor = vec4(vec3(1.15), a * 0.9); }`,
    }));
    flakes.frustumCulled = false; fxScene.add(flakes);
    // tracks: an R8 target over the level (~0.2 m/px); each frame one strip per wheel
    // from the last position to this one, max-blended. The mesh shader samples it.
    const w = extent.maxX - extent.minX, d = extent.maxZ - extent.minZ;
    const cell = Math.max(0.2, Math.max(w, d) / Math.min(4096, renderer.capabilities.maxTextureSize));
    const target = new THREE.WebGLRenderTarget(Math.ceil(w / cell), Math.ceil(d / cell),
      { format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));   // 2 quads, xz in x/z
    geo.setAttribute('side', new THREE.BufferAttribute(new Float32Array([-1, 1, 1, -1, -1, 1, -1, 1, 1, -1, -1, 1]), 1));
    const strip = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { uBox: U.uGroundBox },
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,   // winding flips with the driving direction
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      vertexShader: 'uniform vec4 uBox; attribute float side; varying float vS;\n' +
        'void main() { vS = side; gl_Position = vec4((position.xz - uBox.xy) * uBox.zw * 2.0 - 1.0, 0.0, 1.0); }',
      fragmentShader: 'varying float vS; void main() { gl_FragColor = vec4(1.0 - vS * vS); }',   // soft rut profile
    }));
    strip.frustumCulled = false;
    trail = { target, strip, scene: new THREE.Scene().add(strip), cam: new THREE.Camera(), last: null };
    U.uTrail = { value: target.texture }; U.uSnowStreet = { value: P.snow.street };
    const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
    renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.setRenderTarget(null); renderer.setClearColor(cc, ca);
  }
  const _v = new THREE.Vector3(), _px = new THREE.Vector2();
  function stampTracks() {
    const r = car.carRoot; if (!r || !car.trackHalf) return;
    const x = r.position.x, z = r.position.z, h = -r.rotation.y;
    const onGround = Math.abs(r.position.y - groundAt(x, z)) < 0.3;   // not while sinking / carried by the bear
    const L = trail.last;
    if (!L || !onGround) { trail.last = onGround ? { x, z, h } : null; return; }
    const dx = x - L.x, dz = z - L.z, m = Math.hypot(dx, dz);
    if (m < 0.1) return;                                                 // creeping: wait until it adds up
    trail.last = { x, z, h };
    if (m > 8) return;                                                   // teleported
    const pos = trail.strip.geometry.attributes.position, hw = P.snow.track / 2;
    const ex = dx / m, ez = dz / m, px = -ez * hw, pz = ex * hw;      // along / across the move
    [-1, 1].forEach((sd, k) => {
      const ox = Math.cos(h) * car.trackHalf * sd, oz = Math.sin(h) * car.trackHalf * sd;   // wheel: car's right axis
      const ax = L.x + ox - ex * 0.3, az = L.z + oz - ez * 0.3, bx = x + ox, bz = z + oz;    // overlap the last strip
      const q = [[ax - px, az - pz], [bx + px, bz + pz], [ax + px, az + pz], [ax - px, az - pz], [bx - px, bz - pz], [bx + px, bz + pz]];
      q.forEach(([qx, qz], i) => pos.setXYZ(k * 6 + i, qx, 0, qz));
    });
    pos.needsUpdate = true;
    const ac = renderer.autoClear; renderer.autoClear = false;
    renderer.setRenderTarget(trail.target); renderer.render(trail.scene, trail.cam);
    renderer.setRenderTarget(null); renderer.autoClear = ac;
  }

  // ---- frozen water (P.frozen): material for index.html's flat ice sheet ----
  // pale blue-grey ice, large-scale tone, meandering cracks, drifted snow dust,
  // a faint sky sheen, fainter tyre tracks (same trail texture), same fog as the
  // mesh. Pulled uIcePull m toward the camera, so the lumpy photogrammetry water
  // under it never pokes through (quays and bridges are metres higher and win).
  function iceMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: Object.assign({ uIcePull: { value: 1.5 } }, U),
      vertexShader: /* glsl */`
uniform float uIcePull; varying vec3 vIceW;
void main() {
  vIceW = (modelMatrix * vec4(position, 1.0)).xyz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xyz -= normalize(mv.xyz) * uIcePull;
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: /* glsl */`
uniform float uExposure, uFogDist, uFogHeight, uFogHeightAmt, uFogBase, uEdgeFade;
uniform vec3 uAmbSky; uniform vec4 uExtent;
${SKY_GLSL}
uniform sampler2D uTrail; uniform vec4 uGroundBox;
varying vec3 vIceW;
float crack(vec2 p) { return 1.0 - smoothstep(0.0, 0.035, abs(mNoise(p) - 0.5)); }
void main() {
  vec2 p = vIceW.xz;
  float tone = mFbm(p * 0.03), fine = mFbm(p * 0.5 + 11.0);
  vec3 a = mix(vec3(0.16, 0.25, 0.34), vec3(0.34, 0.44, 0.54), tone);     // clear dark ice .. milky ice
  float c = max(crack(p * 0.09), 0.7 * crack(p * 0.23 + 5.0));            // long cracks + finer ones
  a = mix(a, vec3(0.70, 0.78, 0.86), 0.6 * c);                            // cracks: white rims
  float dust = smoothstep(0.6, 0.85, mFbm(p * 0.12 + 3.0) + 0.25 * fine);
  float trail = texture2D(uTrail, (p - uGroundBox.xy) * uGroundBox.zw).r;
  dust *= 1.0 - 0.8 * trail;                                               // tyres sweep the dust off
  a = mix(a, vec3(0.80, 0.84, 0.91), 0.7 * dust);
  a *= 1.0 - 0.18 * trail;                                                 // faint tyre tracks
  vec3 v = normalize(vIceW - cameraPosition), r = reflect(v, vec3(0.0, 1.0, 0.0));
  float fres = 0.06 + 0.94 * pow(1.0 - abs(v.y), 5.0);
  vec3 col = a * uAmbSky * uExposure + moodSky(r, 0.0) * (fres + 0.12 * (1.0 - dust) * smoothstep(0.45, 0.8, fine));
  vec3 fv = vIceW - cameraPosition;
  float f = 1.0 - exp(-pow(length(fv) / uFogDist, 2.0));
  f *= mix(1.0, exp(-max(vIceW.y - uFogBase, 0.0) / uFogHeight), uFogHeightAmt);
  float sd = max(max(uExtent.x - vIceW.x, vIceW.x - uExtent.z), max(uExtent.y - vIceW.z, vIceW.z - uExtent.w));
  f = max(f, smoothstep(-uEdgeFade, 0.0, sd));
  gl_FragColor = vec4(mix(col, moodSky(normalize(vec3(fv.x, 0.0, fv.z) + 1e-6), 0.0), f), 1.0);
}`,
      side: THREE.DoubleSide,
    });
  }

  // ---- apply preset numbers (also for live tuning: berlinDrive.mood.set('fogDist', 400)) ----
  function apply() {
    U.uZenith.value.copy(hexLin(P.zenith)); U.uMid.value.copy(hexLin(P.mid));
    U.uHorizon.value.copy(hexLin(P.horizon)); U.uSunCol.value.copy(hexLin(P.sun));
    U.uSunDir.value.copy(sunDir(P.sunAz, P.sunEl));
    U.uSunSize.value = THREE.MathUtils.degToRad(P.sunSize); U.uSunInt.value = P.sunInt;
    U.uHalo.value = P.halo; U.uGlow.value = P.glow; U.uStripes.value = P.stripes;
    U.uStars.value = P.stars; U.uClouds.value = P.clouds; U.uMoon.value = P.moon;
    U.uSat.value = P.sat; U.uContrast.value = P.contrast; U.uShadowTint.value.fromArray(P.shadowTint); U.uHighTint.value.fromArray(P.highTint);
    U.uExposure.value = P.exposure; U.uAmbSky.value.fromArray(P.ambSky); U.uAmbGround.value.fromArray(P.ambGround);
    U.uSunLight.value = P.sunLight; U.uFogDist.value = P.fogDist; U.uFogHeight.value = P.fogHeight;
    U.uFogHeightAmt.value = P.fogHeightAmt; U.uEdgeFade.value = P.edgeFade;
    bloom.strength = P.bloomStrength; bloom.radius = P.bloomRadius; bloom.threshold = P.bloomThreshold;
    renderer.toneMapping = P.toneMap === 'none' ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = P.toneExposure; output.uniforms.uVignette.value = P.vignette;
    scene.background = hexLin(P.horizon);
    if (car.hemi) {
      car.hemi.color.copy(hexLin(P.mid)).lerp(new THREE.Color(1, 1, 1), 0.4); car.hemi.groundColor.copy(hexLin(P.zenith));
      car.hemi.intensity = P.carHemi;
      car.sun.color.copy(hexLin(P.sun)); car.sun.intensity = P.carSun; car.sun.position.copy(U.uSunDir.value);
      // blob shadow nudged away from our low sun (capped: a true 3-deg shadow would be 20x the car height)
      const d = U.uSunDir.value, n = Math.hypot(d.x, d.z) || 1;
      car.sunOffset[0] = -1.2 * d.x / n; car.sunOffset[1] = -1.2 * d.z / n;
    }
    if (P.ghost && car.ghostMat) car.ghostMat.color.set(P.ghost);   // white ghost vanishes on snow
    tails.forEach((s) => s.material.color.setRGB(1, 0.06, 0.08).multiplyScalar(P.tail));
    pool.material.color.setRGB(1, 0.82, 0.55).multiplyScalar(P.headlight);
    if (P.snow) U.uSnowStreet.value = P.snow.street;
  }
  apply();

  return {
    name, preset: P, uniforms: U, bloom, trail, composer, carFx, cam: P.cam, samples, floatOK, photo,
    gradeMaterial, attachCar, fitCar, setSize,
    frozen: !!P.frozen, iceMaterial,   // frozen water: index.html drives on it
    set(key, value) { P[key] = value; apply(); return P; },
    time: null,   // seconds; null = real clock (headless checks pin it to step the animation)
    render(draw) {
      sky.position.copy(camera.position);
      const t = this.time ?? (performance.now() / 1000) % 3600;
      U.uTime.value = t;
      if (trail) stampTracks();
      if (flakes) {   // box centred ~45 m ahead of the camera (where the car and the road are)
        camera.getWorldDirection(_v).setY(0).normalize();
        const c = flakes.material.uniforms.uCenter.value.copy(camera.position).addScaledVector(_v, 45); c.y -= 5;
        flakes.material.uniforms.uPx.value = renderer.getDrawingBufferSize(_px).y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      }
      drawPass.draw = fxScene.children.length ? () => {
        draw();
        const ac = renderer.autoClear; renderer.autoClear = false; renderer.render(fxScene, camera); renderer.autoClear = ac;
      } : draw;
      composer.render();
    },
  };
}
