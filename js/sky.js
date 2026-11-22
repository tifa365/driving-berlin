// Photographed sky for plain daylight ("Stimmung: aus" and the day mood): assets/sky/sky.webp
// (4096 x 2048 equirectangular, sky picture of the Skyfall Protocol project, used with its
// author's permission; see README "Licence and credits").
//
//   dome     no mood: a camera-following sphere in the main scene, drawn first, no depth; shown
//            only while the frame reaches above the horizon (the standard 50 / 90 camera never
//            does, so its picture and cost stay as they were). Day mood: js/mood.js samples the
//            same picture through PHOTO_GLSL in its own dome and fog (uniforms shared).
//   yaw      r160 has no scene.backgroundRotation: the shader turns direction -> (u, v) itself.
//            The picture is turned about the vertical so its sun (measured: column u = SUN_U,
//            SUN_EL deg up) stands at the compass bearing of the sun the city mesh was
//            photographed under (index.html SUN_OFFSET: the car's blob shadow falls away from it).
//   horizon  below the horizon the picture (a hazy mirror of the sky) is never shown: the dome
//            returns the haze colour there and blends into the picture over `blend` rad above it,
//            so the fogged mesh and the sky meet without a line (the haze is the fog colour).
//   filter   no mipmaps, linear filtering: the screen magnifies the picture everywhere a chase
//            camera can look (~11 texels / deg against ~30 px / deg), and without a mip chain the
//            u-wrap (atan jump) cannot pick a coarse level, so there is no seam at u = 0 / 1.
//   light    an environment map from the same picture (PMREMGenerator.fromScene of a small
//            sphere with this shader, same yaw; below the horizon a dim city-ground tone) on the
//            car and bus materials only (envMap, envMapIntensity = env); the city tiles are unlit
//            photographs and never get it (no scene.environment). The car's hemisphere fill is
//            lowered to `fill` x, so overall brightness stays about as before; paint roughness ->
//            `paint` (soft sky reflection), dark texels of the textured vehicle materials (windows)
//            -> `glassRough` (clearer reflection).
// Live tuning: berlinDrive.sky.opts.env = 0.8; berlinDrive.sky.apply().
import * as THREE from 'three';

const SKY_URL = 'assets/sky/sky.webp';
const SUN_U = 0.60, SUN_EL = 47;   // the picture's sun: centroid of its saturated pixels (u from the left edge, deg up)

// Sky colour for a world direction (level frame: x east, y up, z = -north). uSkyYaw in turns.
export const PHOTO_GLSL = /* glsl */`
uniform sampler2D uSkyTex;
uniform vec3 uSkyHaze;
uniform float uSkyYaw, uSkyBlend, uSkyOn, uSkyGlow;
vec3 photoSky(vec3 d) {
  if (d.y <= 0.0) return uSkyHaze;
  float u = fract(atan(d.x, -d.z) * 0.15915494 - uSkyYaw);    // compass bearing -> picture column
  float v = 0.5 - asin(min(d.y, 1.0)) * 0.31830989;            // ImageBitmap, flipY off: row 0 = zenith
  vec3 c = texture2D(uSkyTex, vec2(u, v)).rgb;
  c *= 1.0 + uSkyGlow * smoothstep(0.9, 1.0, min(min(c.r, c.g), c.b));   // HDR sun (day mood bloom; clamps away without a mood)
  return mix(uSkyHaze, c, smoothstep(0.0, uSkyBlend, d.y));
}`;

// sunBearing: compass deg of the sun; fogColor: the Color the horizon must melt into (no mood:
// scene.fog.color, shared, so a fog change moves the dome's horizon with it); coarse: phones.
export function createSky({ renderer, sunBearing, fogColor = null, coarse = false }) {
  const opts = {
    yaw: sunBearing / 360 - SUN_U,   // turns
    env: 0.6, fill: 0.72, paint: 0.42, glass: 1, glassRough: 0.12,
    blend: 0.04, glow: 2, ground: 0.3,
    haze: '#b2c6dc',                  // light blue haze (owner 2026-11-22: the picture's own horizon band, #999eac, read as a grey strip over the street)
    hazeNear: 250, hazeFar: 1700,     // no-mood Horizont fog (m, linear) - index.html applyViewLook
  };
  const haze = new THREE.Color(opts.haze);
  const placeholder = new THREE.DataTexture(new Uint8Array([153, 158, 172, 255]), 1, 1);
  placeholder.needsUpdate = true;
  const uniforms = {
    uSkyTex: { value: placeholder }, uSkyHaze: { value: fogColor || haze },
    uSkyYaw: { value: opts.yaw }, uSkyBlend: { value: opts.blend }, uSkyOn: { value: 0 }, uSkyGlow: { value: opts.glow },
  };
  const dirVS = 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

  // ---- dome (no mood only; index.html adds it to the scene) ----
  const dome = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    vertexShader: dirVS,
    fragmentShader: `varying vec3 vDir;\n${PHOTO_GLSL}\nvoid main() {\n  gl_FragColor = vec4(photoSky(normalize(vDir)), 1.0);\n  #include <tonemapping_fragment>\n  #include <colorspace_fragment>\n}`,
  }));
  dome.name = 'skyDome'; dome.renderOrder = -1; dome.frustumCulled = false; dome.visible = false;
  const _v = new THREE.Vector3();
  function frame(camera) {   // per draw, no mood: follow the camera, show only with sky in frame
    if (!dome.parent) return;
    dome.position.copy(camera.position);
    camera.getWorldDirection(_v);
    const top = Math.asin(THREE.MathUtils.clamp(_v.y, -1, 1)) + THREE.MathUtils.degToRad(camera.fov / 2);
    dome.visible = uniforms.uSkyOn.value > 0.5 && top > -0.01;
  }

  // ---- vehicles: envMap, paint roughness, glass mask ----
  let envTex = null, envRT = null, envGround = opts.ground;
  const glassU = { uGlass: { value: 0 }, uGlassRough: { value: opts.glassRough } };
  const veh = { mats: new Set(), paint: new Map(), setFill: null };
  const glassCompile = (sh) => {
    Object.assign(sh.uniforms, glassU);
    sh.fragmentShader = 'uniform float uGlass, uGlassRough;\n' + sh.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
      { vec3 gc = diffuseColor.rgb; float gl = dot(gc, vec3(0.2126, 0.7152, 0.0722));
        float gs = max(max(gc.r, gc.g), gc.b) - min(min(gc.r, gc.g), gc.b);
        roughnessFactor = mix(roughnessFactor, uGlassRough, uGlass * (1.0 - smoothstep(0.05, 0.09, gl)) * (1.0 - smoothstep(0.03, 0.08, gs))); }`);
  };
  // roots: vehicle models; paint: the painted body materials; setFill(f): hemisphere fill x f
  function dressVehicles(roots, { paint = [], setFill = null } = {}) {
    for (const r of roots) r.traverse((o) => {
      const m = o.isMesh && o.material;
      if (!m?.isMeshStandardMaterial || /Shadow/.test(m.name) || veh.mats.has(m)) return;
      veh.mats.add(m);
      // textured, not a wheel clone (own shader): dark, grey texels are glass
      if (m.map && !/Wheel$/.test(m.name) && m.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) { m.onBeforeCompile = glassCompile; m.needsUpdate = true; }
    });
    for (const m of paint) if (!veh.paint.has(m)) veh.paint.set(m, m.roughness);
    veh.setFill = setFill;
    apply();
  }
  function apply() {
    if (envTex && (opts.yaw !== uniforms.uSkyYaw.value || opts.ground !== envGround)) { uniforms.uSkyYaw.value = opts.yaw; const old = envRT; envTex = buildEnv(); old.dispose(); }   // live yaw / ground: rebuild
    uniforms.uSkyYaw.value = opts.yaw; uniforms.uSkyBlend.value = opts.blend; uniforms.uSkyGlow.value = opts.glow;
    const on = !!envTex && opts.env > 0;
    for (const m of veh.mats) {
      if (m.envMap !== (on ? envTex : null)) { m.envMap = on ? envTex : null; m.needsUpdate = true; }
      m.envMapIntensity = opts.env;
    }
    for (const [m, r] of veh.paint) m.roughness = on ? opts.paint : r;
    glassU.uGlass.value = on ? opts.glass : 0; glassU.uGlassRough.value = opts.glassRough;
    veh.setFill?.(on ? opts.fill : 1);
  }

  // ---- environment: the same picture on a small sphere, prefiltered ----
  function buildEnv() {
    envGround = opts.ground;
    const s = new THREE.Scene();
    const m = new THREE.Mesh(new THREE.SphereGeometry(10, 64, 32), new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uSkyHaze: { value: haze }, uGround: { value: haze.clone().multiplyScalar(opts.ground) } },
      side: THREE.BackSide, depthTest: false, depthWrite: false,
      vertexShader: dirVS,
      fragmentShader: `varying vec3 vDir;\nuniform vec3 uGround;\n${PHOTO_GLSL}\nvoid main() {
  vec3 d = normalize(vDir);
  gl_FragColor = vec4(d.y > 0.0 ? photoSky(d) : mix(uSkyHaze, uGround, smoothstep(0.0, 0.25, -d.y)), 1.0);
}`,
    }));
    s.add(m);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = envRT = pmrem.fromScene(s, 0, 0.1, 100);
    pmrem.dispose(); m.geometry.dispose(); m.material.dispose();
    return rt.texture;
  }

  // ---- load (index.html calls it at once where the picture is used; never throws) ----
  let loading = null;
  function load() {
    loading ??= fetch(SKY_URL)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then((b) => {
        const o = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
        const small = coarse ? { ...o, resizeWidth: 2048, resizeHeight: 1024, resizeQuality: 'high' } : o;   // phones: 8 MB instead of 32 MB on the GPU
        return createImageBitmap(b, small).catch(() => createImageBitmap(b));
      })
      .then((img) => {
        const t = new THREE.Texture(img);
        t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;
        t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
        t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
        t.needsUpdate = true;
        uniforms.uSkyTex.value = t; uniforms.uSkyOn.value = 1;
        envTex = buildEnv();
        apply();
        return true;
      })
      .catch((e) => { console.info('sky picture off (drawn sky / plain colour):', e.message || e); return false; });
    return loading;
  }

  return {
    opts, uniforms, dome, frame, load, apply, dressVehicles,
    sunAz: sunBearing, sunEl: SUN_EL,
    get envMap() { return envTex; }, get loaded() { return uniforms.uSkyOn.value > 0.5; },
  };
}
