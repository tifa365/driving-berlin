// Vehicle model for the top-down Box2D world (Box2DWeb as the global `Box2D`).
//
// Design
//   One dynamic chassis body carries all the mass and all the forces. Four light wheel
//   bodies (order FL, FR, RL, RR) ride along at their tyre positions: the chassis is the
//   authority, and the wheels are re-placed onto it (position and point velocity) before
//   and after every world step. Own fixtures share a negative group index, so chassis and
//   wheels never collide with each other.
//
//   Every step, `update()` turns the inputs into forces at the four contact patches:
//     - steering: a centre angle that slews toward lever x lock(speed); the two front
//       wheels follow it with Ackermann geometry (inner wheel steers more);
//     - lateral tyre force: slip angle (with a low-speed floor on the rolling speed so it
//       stays well behaved near standstill) through a tanh curve that saturates at
//       grip x muY x load; a friction ellipse takes away lateral capacity while the tyre
//       also transmits a large longitudinal force;
//     - longitudinal: engine on the driven axle (the car pulls with the front wheels, the
//       bus pushes with the rear ones), brakes, rolling resistance, coast braking and a
//       ride-roughness loss on every wheel. Resistive forces never reverse a wheel: each
//       one is clipped to what stops that wheel's share of the mass within the step;
//     - a speed governor (feed-forward of the known resistances plus a proportional term)
//       that ramps up gently under a speed limit and eases into it from below;
//     - air drag on the chassis.
//   A parking hold pins the whole vehicle at exact rest when no key is held and it has
//   stood still for a moment. Reverse engages only after the stop pedal was held at a
//   standstill for a short delay; in reverse the pedals swap roles.
//
// Frame: Box2D x = east, y = south. Heading is a bearing (0 = north, clockwise +), equal to
// the chassis angle. Forward is body-local -y, right is local +x.

const b2Vec2 = () => Box2D.Common.Math.b2Vec2;

const G = 9.81;
const KMH = 3.6;
const DEG = Math.PI / 180;

// ---------- shared helpers (exported) ----------

// Map v from [a0, a1] to [b0, b1] and clamp to the output range (which may run downwards).
export function mapClamped(v, a0, a1, b0, b1) {
  const t = a1 === a0 ? 0 : (v - a0) / (a1 - a0);
  const r = b0 + (b1 - b0) * t;
  return b0 < b1 ? Math.min(b1, Math.max(b0, r)) : Math.min(b0, Math.max(b1, r));
}

// Wrap an angle (rad) to (-pi, pi].
export function wrapAngle(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

// Material of every static collider: a dull stop with no bounce.
export const SOLID = { friction: 0.35, restitution: 0 };

// Visual nose-dip after a wall hit: amplitude per m/s of impact speed, and its ceiling (rad).
export const IMPACT = { dipPerMs: 0.0035, dipMax: 0.045, rise: 0.09, end: 0.75 };

// Fixture userData marker for round tree trunks (js/clutter.js).
export const TRUNK = { kind: 'trunk' };

// ---------- vehicle data ----------
// Dimensions in metres, masses in kg, forces in N, accelerations in m/s2, angles in rad.
export const VEHICLE_SPECS = {
  car: {
    mass: 1500, inertia: 2695,
    bodyWidth: 1.81, bodyLength: 4.495,          // drawn size (shadows, fit tests, camera)
    wheelBase: 2.65, tread: 1.35, wheelRadius: 0.3106,
    frontAxle: 1.25, rearAxle: 1.40,              // axle distances from the centre of mass
    outline: [                                    // collision outline, body-local, nose at -y
      [0.835, -1.75], [0.70, -2.05], [0.45, -2.149], [-0.45, -2.149], [-0.70, -2.05],
      [-0.835, -1.75], [-0.835, 1.95], [-0.60, 2.151], [0.60, 2.151], [0.835, 1.95],
    ],
    wheelBox: [0.10, 0.30],
    bodyFriction: 0.35,         // outline against walls (mixed with the wall's 0.35)
    drive: 'front',
    engineAccel: 5.35,          // full engine force / mass at power 1
    brakeForce: 3200,           // per wheel
    lock: 35.2 * DEG,           // centre steering lock at rest
    muYF: 2.205, muYR: 2.683, muX: 1.49, slipPeak: 0.0258, slipFloor: 4.0, latLimiter: 0.7, slideF: 1, slideR: 1,
    steerApply: 0.285, steerCentre: 0.0924, lockSpeed: 49.7,
    airDrag: 4.25e-4,           // 1/m: drag accel = airDrag * v^2
  },
  bus: {
    mass: 13000, inertia: 33235,
    bodyWidth: 2.5, bodyLength: 12.7,
    wheelBase: 6.0, tread: 1.9, wheelRadius: 0.4,
    frontAxle: 2.75, rearAxle: 3.25,
    outline: [
      [1.25, -6.20], [1.10, -6.35], [-1.10, -6.35], [-1.25, -6.20],
      [-1.25, 6.20], [-1.10, 6.35], [1.10, 6.35], [1.25, 6.20],
    ],
    wheelBox: [0.15, 0.45],
    bodyFriction: 0.086,        // smooth flanks: the bus scrapes along walls
    drive: 'rear',
    engineAccel: 3.73,
    brakeForce: 19200,
    lock: 45.0 * DEG,
    muYF: 0.80, muYR: 0.756, muX: 1.728, slipPeak: 0.04, slipFloor: 1.8, latLimiter: 1.38, slideF: 0.742, slideR: 0.857,
    steerApply: 0.524, steerCentre: 0.119, lockSpeed: 27.06,
    airDrag: 5.5e-5,
  },
};

// Behaviour shared by both vehicles (the default 'arcade' handling).
export const TUNING = {
  rolling: 0.0683,        // rolling resistance coefficient (x load)
  coastShare: 0.5,        // coast braking with no pedal, as a share of the full brake
  overlapDrive: 0.82,     // both pedals held: engine output is cut to this share of full
  govGain: 1.0,           // 1/s: governor acceleration per m/s below the limit
  govUp: 2.796,           // m/s2: gentle pull-away under a speed limit
  govDown: 3.2,           // m/s2: largest governor deceleration toward a lowered limit
  roughLoss: 4000,        // N per rad/s of attitude change (rough road losses)
  stillSpeed: 0.5 / KMH,  // m/s: below this the vehicle counts as standing
  stillYaw: 0.05,         // rad/s
  holdDelay: 0.33,        // s standing with no key before the parking hold takes over
  gearDelay: 0.40,        // s holding the stop pedal at a standstill before the gear changes
  impactMin: 1.0,         // m/s into a wall for a new impact
  stopShare: 0.5,         // share of a wheel's rolling speed that resistive forces may take per step
};

const HANDLINGS = {
  arcade: {},
  classic: { muY: 0.8, steerScale: 1.8, centreAtRest: false },
};

// ---------- the vehicle ----------
export class Vehicle {
  constructor(world, kind, x, y, heading, power = 1, handling = 'arcade') {
    const V = b2Vec2();
    const D = Box2D.Dynamics, S = Box2D.Collision.Shapes;
    this.world = world;
    this.specName = kind === 'bus' ? 'bus' : 'car';
    const base = VEHICLE_SPECS[this.specName];
    this.spec = { ...base };
    this.power = isFinite(+power) && +power > 0 ? +power : 1;
    this.handling = HANDLINGS[handling] ? handling : 'arcade';
    const H = HANDLINGS[this.handling];
    this.tune = { ...TUNING, centreAtRest: H.centreAtRest !== false, steerScale: H.steerScale || 1 };
    this.muYScale = H.muY || 1;

    // limits (written by the game)
    this.maxSpeed = 160 / KMH;
    this.speedLimit = 0;
    this.reverseLimit = 0;
    this.noHold = false;

    // read-outs
    this.speedKmh = 0;
    this.held = true;
    this.airborne = false;
    this.tilt = 0; this.roll = 0;
    this.impactPitch = 0; this.impactA = 0; this.impactT = 10;
    this.frontLAngle = 0; this.frontRAngle = 0;
    this.squealLevel = 0;
    this.gear = 1;
    this.wallContact = null;
    this.steering = { lever: 0, angle: 0 };
    this.prevVel = { x: 0, y: 0 };

    // inputs and internal state
    this.throttle = 0; this.brake = 0;
    this._brakeLock = true;
    this._still = TUNING.holdDelay;   // standing time (s)
    this._gearT = 0;
    this._rate = 0;                   // smoothed attitude change rate (rad/s)
    this._attPrev = null;
    this._contactPrev = false;

    const sp = this.spec, L = sp.frontAxle + sp.rearAxle;
    this._wb = L;
    // wheel layout: FL, FR, RL, RR; static load shares
    const fShare = sp.rearAxle / L / 2, rShare = sp.frontAxle / L / 2;
    const ht = sp.tread / 2;
    this._wl = [
      { x: -ht, y: -sp.frontAxle, share: fShare, front: true, side: -1 },
      { x: ht, y: -sp.frontAxle, share: fShare, front: true, side: 1 },
      { x: -ht, y: sp.rearAxle, share: rShare, front: false, side: -1 },
      { x: ht, y: sp.rearAxle, share: rShare, front: false, side: 1 },
    ];
    this._driven = this._wl.map((w) => (sp.drive === 'front' ? w.front : !w.front));

    // chassis
    const bd = new D.b2BodyDef();
    bd.type = D.b2Body.b2_dynamicBody;
    bd.position.Set(x, y);
    bd.angle = heading;
    bd.allowSleep = false;
    this.body = world.CreateBody(bd);
    const group = -7;
    const outline = new S.b2PolygonShape();
    const pts = sp.outline.map(([px, py]) => new V(px, py));
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area += a.x * b.y - b.x * a.y; }
    if (area < 0) pts.reverse();                       // Box2D wants counter-clockwise vertices
    outline.SetAsArray(pts, pts.length);
    this._nose = -Math.min(...sp.outline.map((q) => q[1]));
    this._tail = Math.max(...sp.outline.map((q) => q[1]));
    const fd = new D.b2FixtureDef();
    fd.shape = outline; fd.density = 0; fd.friction = sp.bodyFriction; fd.restitution = 0;
    fd.filter.categoryBits = 0x0001; fd.filter.maskBits = 0xffff; fd.filter.groupIndex = group;
    this.body.CreateFixture(fd);
    const md = new Box2D.Collision.Shapes.b2MassData();
    md.mass = sp.mass; md.center = new V(0, 0); md.I = sp.inertia;
    this.body.SetMassData(md);

    // wheels
    this.wheels = this._wl.map((w) => {
      const wd = new D.b2BodyDef();
      wd.type = D.b2Body.b2_dynamicBody;
      wd.allowSleep = false;
      const c = Math.cos(heading), s = Math.sin(heading);
      wd.position.Set(x + c * w.x - s * w.y, y + s * w.x + c * w.y);
      wd.angle = heading;
      const body = world.CreateBody(wd);
      const box = new S.b2PolygonShape();
      box.SetAsBox(sp.wheelBox[0], sp.wheelBox[1]);
      const wf = new D.b2FixtureDef();
      wf.shape = box; wf.density = 0; wf.friction = SOLID.friction; wf.restitution = 0;
      wf.filter.categoryBits = 0x0002; wf.filter.maskBits = 0xffff; wf.filter.groupIndex = group;
      body.CreateFixture(wf);
      return { body, grip: 1 };
    });

    // scratch vectors (no allocation per step)
    this._f = new V(0, 0); this._p = new V(0, 0); this._v = new V(0, 0);
    this._wm = new Box2D.Collision.b2WorldManifold();
    this._syncWheels();
  }

  // ----- inputs -----
  setSteeringLever(l) { this.steering.lever = l > 0 ? 1 : l < 0 ? -1 : 0; }
  setThrottle(t) { this.throttle = Math.min(1, Math.max(0, +t || 0)); }
  setBrake(b) { this.brake = Math.min(1, Math.max(0, +b || 0)); }

  // false = do not hold the vehicle braked (a module just gave it a velocity to roll on)
  get brakeLock() { return this._brakeLock; }
  set brakeLock(on) {
    this._brakeLock = !!on;
    if (!on) { this.held = false; this._still = 0; }
  }

  getPosition() { const p = this.body.GetPosition(); return { x: p.x, y: p.y }; }
  getHeading() { return this.body.GetAngle(); }
  getMass() { return this.body.GetMass(); }

  setAttitude(pitch, roll) {
    this.tilt = pitch; this.roll = roll;
  }

  setAirborne(on) {
    on = !!on;
    this.airborne = on;
    if (on) { this.held = false; this._still = 0; }
    for (const b of this._bodies()) for (let f = b.GetFixtureList(); f; f = f.GetNext()) f.SetSensor(on);
  }

  reset(x, y, heading) {
    this.body.SetPositionAndAngle(this._vec(x, y), heading);
    this._zeroAll();
    this.gear = 1; this._gearT = 0;
    this.throttle = 0; this.brake = 0; this.steering.lever = 0; this.steering.angle = 0;
    this.frontLAngle = this.frontRAngle = 0; this.squealLevel = 0;
    this.wallContact = null; this._contactPrev = false;
    this.impactPitch = 0; this.impactA = 0; this.impactT = 10;
    this.held = false; this._brakeLock = true; this._still = this.tune.holdDelay;
    this.speedKmh = 0; this.prevVel.x = this.prevVel.y = 0;
    this._attPrev = null; this._rate = 0;
    this._syncWheels();
  }

  destroy() {
    for (const b of this._bodies()) this.world.DestroyBody(b);
    this.wheels = [];
  }

  // ----- per step, before world.Step -----
  update(dt) {
    const T = this.tune, sp = this.spec, body = this.body;
    const v = body.GetLinearVelocity(), w = body.GetAngularVelocity(), h = body.GetAngle();
    const fx = Math.sin(h), fy = -Math.cos(h), rx = Math.cos(h), ry = Math.sin(h);
    const u = v.x * fx + v.y * fy;                       // forward speed
    const speed = Math.hypot(v.x, v.y);
    this.prevVel.x = v.x; this.prevVel.y = v.y;

    // attitude change rate (rough road), smoothed
    this._updateRoughness(dt);

    // steering (also in the air: the wheels turn, nothing else happens)
    this._steer(dt, Math.abs(u));

    const lever = this.steering.lever;
    if (this.throttle > 0 || this.brake > 0) this._brakeLock = false;

    if (this.airborne) {
      this._airDrag(v, speed);
      this.squealLevel = 0;
      this.speedKmh = speed * KMH;
      this._syncWheels();
      return;
    }

    // standing still?
    const slow = speed < T.stillSpeed && Math.abs(w) < T.stillYaw;
    this._still = slow ? this._still + dt : 0;
    const noKey = this.throttle === 0 && this.brake === 0 && lever === 0;
    if (noKey && !this.noHold && slow && (this._brakeLock || this._still >= T.holdDelay)) {
      this.held = true;
    } else this.held = false;
    if (this.held) {
      this._zeroAll();
      this._syncWheels();
      this.speedKmh = 0; this.squealLevel = 0;
      return;
    }

    // gear: the stop pedal held at a standstill changes the direction after a delay
    let drive = this.gear > 0 ? this.throttle : this.brake;
    let stop = this.gear > 0 ? this.brake : this.throttle;
    if (stop > 0 && Math.abs(u) < T.stillSpeed) {
      this._gearT += dt;
      if (this._gearT >= T.gearDelay) {
        this.gear = -this.gear; this._gearT = 0;
        const d = drive; drive = stop; stop = d;
      }
    } else this._gearT = 0;

    // driven-wheel grip, mean grip
    let gDrive = 0, nDrive = 0, gMean = 0;
    for (let i = 0; i < 4; i++) { const g = this._grip(i); gMean += g / 4; if (this._driven[i]) { gDrive += g; nDrive++; } }
    gDrive /= nDrive;

    // longitudinal demand at vehicle level
    const m = sp.mass;
    const slope = G * Math.sin(this.tilt);                 // nose-up: pulls backwards
    const rough = T.roughLoss * this._rate / m;           // m/s2
    const roll = T.rolling * G * gMean;                     // m/s2
    let engine = 0, govBrake = 0;                          // N
    const pedal = drive > 0 || stop > 0;
    if (drive > 0) {
      const s = this.gear * u;
      const lim = this.gear > 0 ? this.speedLimit : this.reverseLimit;
      const L = lim > 0 ? Math.min(lim, this.maxSpeed) : this.maxSpeed;
      let a = T.govGain * (L - s);
      if (lim > 0) a = Math.min(a, T.govUp);
      a = Math.max(a, -T.govDown);
      const need = m * (a + roll + rough + this.gear * slope + sp.airDrag * s * Math.abs(s));
      if (need > 0) engine = Math.min(need / Math.max(gDrive, 1e-3), sp.engineAccel * m * this.power) * drive;
      else govBrake = -need;
      // both pedals: the governor sees the vehicle slowing and opens fully, the engine
      // management cuts that output while braking, and the brakes always win
      if (stop > 0) govBrake = 0;
      if (stop > 0) engine = Math.min(T.overlapDrive * sp.engineAccel * m * this.power, 0.9 * 4 * sp.brakeForce * gDrive) * drive;
    }

    // forces per wheel
    const sa = this.steering.angle;
    const angles = this._wheelAngles(sa);
    const c = Math.cos(h), s = Math.sin(h);
    let squeal = 0;
    for (let i = 0; i < 4; i++) {
      const wl = this._wl[i], grip = this._grip(i);
      const load = m * G * wl.share;
      const mi = m * wl.share;
      const ox = c * wl.x - s * wl.y, oy = s * wl.x + c * wl.y;
      const pvx = v.x - w * oy, pvy = v.y + w * ox;
      const d = wl.front ? angles[i] : 0;
      const cd = Math.cos(d), sd = Math.sin(d);
      const dx = fx * cd + rx * sd, dy = fy * cd + ry * sd;     // wheel forward
      const lx = rx * cd - fx * sd, ly = ry * cd - fy * sd;     // wheel right
      const ui = pvx * dx + pvy * dy, wi = pvx * lx + pvy * ly;

      // longitudinal
      const dr = this._driven[i] ? engine / nDrive * grip * this.gear : 0;
      let res = load * (T.rolling * grip) + T.roughLoss * this._rate * wl.share;
      if (stop > 0) res += sp.brakeForce * grip * stop;
      else if (!pedal && !this.noHold) res += sp.brakeForce * grip * T.coastShare;
      res += govBrake * wl.share * grip;
      const stopF = dr + T.stopShare * mi * ui / dt;
      const Fx = dr - Math.max(-res, Math.min(res, stopF));

      // lateral
      const capY = grip * (wl.front ? sp.muYF : sp.muYR) * this.muYScale * load;
      const capX = grip * sp.muX * load;
      const ex = capX > 0 ? Fx / capX : 0;
      const capYe = capY * Math.sqrt(Math.max(0.05, 1 - ex * ex));
      const alpha = Math.atan2(wi, Math.max(Math.abs(ui), sp.slipFloor));
      const x = Math.abs(alpha) / sp.slipPeak;
      // tyre curve: steep rise, saturation, and past the peak a gentle drop toward the
      // sliding share (slideF / slideR of the peak)
      const slide = wl.front ? sp.slideF : sp.slideR;
      const curve = Math.tanh(x) * (1 - (1 - slide) * (1 - Math.exp(-Math.max(0, x - 1) / 3)));
      let Fy = -capYe * curve * Math.sign(alpha);
      const lim = sp.latLimiter * mi * Math.abs(wi) / dt;
      if (Math.abs(Fy) > lim) Fy = Math.sign(Fy) * lim;
      squeal = Math.max(squeal, Math.abs(alpha) / sp.slipPeak);

      this._f.x = dx * Fx + lx * Fy; this._f.y = dy * Fx + ly * Fy;
      const bp = body.GetPosition();
      this._p.x = bp.x + ox; this._p.y = bp.y + oy;
      body.ApplyForce(this._f, this._p);
    }
    // slope pull only while a pedal is held (a parked vehicle stays put)
    if (pedal && slope !== 0) {
      this._f.x = -fx * m * slope; this._f.y = -fy * m * slope;
      body.ApplyForce(this._f, body.GetWorldCenter());
    }
    this._airDrag(v, speed);
    this.squealLevel = Math.max(0, Math.min(1, (squeal - 1) / 4));
    this.speedKmh = speed * KMH;
    this._syncWheels();
  }

  // ----- per step, after world.Step and the other modules -----
  lateUpdate(dt) {
    if (this.held) this._zeroAll();
    this._syncWheels();
    // wall contacts
    let touching = false, nx = 0, ny = 0, px = 0, py = 0, trunk = false, n = 0;
    const wm = this._wm;
    for (let k = 0; k <= this.wheels.length; k++) {
      const b = k === 0 ? this.body : this.wheels[k - 1].body;
      for (let e = b.GetContactList(); e; e = e.next) {
        const ct = e.contact;
        if (!ct.IsTouching() || ct.IsSensor()) continue;
        const fa = ct.GetFixtureA(), fb = ct.GetFixtureB();
        const own = fa.GetBody() === b ? fa : fb, other = own === fa ? fb : fa;
        if (other.IsSensor() || other.GetBody().GetType() !== Box2D.Dynamics.b2Body.b2_staticBody) continue;
        ct.GetWorldManifold(wm);
        const sg = own === fa ? -1 : 1;                    // manifold normal points A -> B
        nx += sg * wm.m_normal.x; ny += sg * wm.m_normal.y;
        px += wm.m_points[0].x; py += wm.m_points[0].y; n++;
        if (other.GetUserData && other.GetUserData() === TRUNK) trunk = true;
        touching = true;
      }
    }
    this.impactT += dt;
    if (touching) {
      const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl; px /= n; py /= n;
      const impact = Math.max(0, -(this.prevVel.x * nx + this.prevVel.y * ny));
      if (this.wallContact) { this.wallContact.nx = nx; this.wallContact.ny = ny; this.wallContact.impact = impact; this.wallContact.trunk = trunk; }
      else this.wallContact = { nx, ny, impact, trunk };
      const lp = this.body.GetLocalPoint(this._vec(px, py));
      const half = lp.y < 0 ? this._nose : this._tail;
      const along = Math.min(1, Math.abs(lp.y) / half);
      if (impact >= this.tune.impactMin && (!this._contactPrev || this.impactT > 0.3)) {
        const amp = Math.min(IMPACT.dipMax, IMPACT.dipPerMs * impact) * (0.25 + 0.75 * along * along);
        this.impactA = lp.y < 0 ? -amp : amp;
        this.impactT = dt;
      }
      if (trunk && along > 0.6 && Math.abs(lp.x) < 0.5 * this.spec.bodyWidth) {
        // round trunk hit end-on: stop dead instead of sliding round it
        const v = this.body.GetLinearVelocity(), h = this.body.GetAngle();
        const fx = Math.sin(h), fy = -Math.cos(h), uf = v.x * fx + v.y * fy;
        const into = lp.y < 0 ? uf > 0 : uf < 0;
        this._setAllVel(into ? 0 : uf * fx, into ? 0 : uf * fy, 0);
      }
    } else this.wallContact = null;
    this._contactPrev = touching;
    // nose-dip curve: rises to the amplitude at IMPACT.rise, fades with no overshoot
    const t = this.impactT;
    this.impactPitch = t < IMPACT.end ? this.impactA * (t / IMPACT.rise) * Math.exp(1 - t / IMPACT.rise) : 0;
    if (this.held) this.speedKmh = 0;
  }

  // ----- internals -----
  _bodies() { return [this.body, ...this.wheels.map((q) => q.body)]; }
  _vec(x, y) { this._v.x = x; this._v.y = y; return this._v; }
  _grip(i) { const g = this.wheels[i].grip; return g == null || !isFinite(g) ? 1 : Math.max(0, g); }

  _zeroAll() { this._setAllVel(0, 0, 0); }
  _setAllVel(vx, vy, w) {
    this._v.x = vx; this._v.y = vy;
    this.body.SetLinearVelocity(this._v); this.body.SetAngularVelocity(w);
    for (const q of this.wheels) { q.body.SetLinearVelocity(this._v); q.body.SetAngularVelocity(0); }
  }

  // wheel bodies onto the chassis: tyre position and the chassis point velocity
  _syncWheels() {
    const b = this.body, p = b.GetPosition(), h = b.GetAngle(), v = b.GetLinearVelocity(), w = b.GetAngularVelocity();
    const c = Math.cos(h), s = Math.sin(h);
    for (let i = 0; i < this.wheels.length; i++) {
      const wl = this._wl[i], wb = this.wheels[i].body;
      const ox = c * wl.x - s * wl.y, oy = s * wl.x + c * wl.y;
      const wp = wb.GetPosition();
      if (Math.abs(wp.x - p.x - ox) > 1e-9 || Math.abs(wp.y - p.y - oy) > 1e-9 || Math.abs(wb.GetAngle() - h) > 1e-9) {
        this._p.x = p.x + ox; this._p.y = p.y + oy;
        wb.SetPositionAndAngle(this._p, h);
      }
      this._v.x = v.x - w * oy; this._v.y = v.y + w * ox;
      wb.SetLinearVelocity(this._v);
      wb.SetAngularVelocity(w);
    }
  }

  _steer(dt, absU) {
    const T = this.tune, sp = this.spec;
    const lock = sp.lock / (1 + (absU / sp.lockSpeed) ** 2);
    const lever = this.steering.lever;
    let a = this.steering.angle;
    const target = lever * lock;
    const centring = lever === 0;
    if (centring && !T.centreAtRest && absU < 0.3) { /* classic: wheel stays where it is at rest */ }
    else {
      if (centring) {
        // self-centring: a first-order return (fast at first, a short tail)
        a *= Math.exp(-dt / (sp.steerCentre * T.steerScale));
        if (Math.abs(a) < 1e-4) a = 0;
      } else {
        // the lever turns the wheel at a steady rate toward the speed-dependent lock
        const d = target - a, stepMax = sp.lock / (sp.steerApply * T.steerScale) * dt;
        a += Math.abs(d) <= stepMax ? d : Math.sign(d) * stepMax;
      }
    }
    this.steering.angle = a;
    const ang = this._wheelAngles(a);
    this.frontLAngle = ang[0]; this.frontRAngle = ang[1];
  }

  // Ackermann: the inner front wheel steers more
  _wheelAngles(a) {
    const out = this._ang || (this._ang = [0, 0, 0, 0]);
    if (a === 0) { out[0] = out[1] = 0; return out; }
    const t = Math.tan(a), k = this.spec.tread / (2 * this._wb);
    out[0] = Math.atan(t / (1 + t * k));    // left
    out[1] = Math.atan(t / (1 - t * k));    // right
    return out;
  }

  _airDrag(v, speed) {
    if (speed <= 0) return;
    const k = this.spec.airDrag * this.spec.mass * speed;
    this._f.x = -k * v.x; this._f.y = -k * v.y;
    this.body.ApplyForce(this._f, this.body.GetWorldCenter());
  }

  _updateRoughness(dt) {
    if (this.held || this.airborne) { this._attPrev = null; this._rate = 0; return; }
    const p = this._attPrev;
    if (p) {
      const d = Math.min(0.02, Math.abs(this.tilt - p.t) + Math.abs(this.roll - p.r));
      this._rate = d / dt;
      p.t = this.tilt; p.r = this.roll;
    } else this._attPrev = { t: this.tilt, r: this.roll };
  }
}
