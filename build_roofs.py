#!/usr/bin/env python3
"""Drivable roof decks (js/roofs.js) -> levels/<name>/roofs_deck.json + roofs_deck.bin.

  nice -n 19 python3 build_roofs.py [--name mitte_all] [--only bundestag] [--work DIR] [--check]

One entry per roof route in ROUTES (now only the Bundestag band: Paul-Loebe-Haus glass hall
roof -> upper Spree skywalk (OSM way/11355720) -> Marie-Elisabeth-Lueders-Haus, candidate #1 of
ROOF_ROUTES.md / roofs.json). For each route:

  1. raster    L1 mesh top surface over the route window at CELL (0.5 m), the same z-buffer
               as find_roofs.py (build_level.raster_top); cached as <work>/top_<id>.npy
  2. deck      the drivable surface S, one connected area:
               - flat cells (find_roofs.drivable: 3 x 3 plane fit, slope <= 10 deg, residual
                 <= 0.15 m, no step > 0.3 m to a flat neighbour) >= 3 m above the street;
               - gaps up to GAP m (a step face between the hall roof and the wings, a glass
                 rib) are closed when the cells there lie within the two sides' heights and the
                 sides differ by <= MAX_STEP m: the deck gets a step there (the car rides it,
                 see js/roofs.js); a parapet higher than both sides is NOT closed;
               - grown by up to GROW m into rough but level cells (|dz| <= LEVEL_TOL to the
                 deck next to them): gravel, joints, the last half metre before the edge;
               - the connected part that holds all of the route's seed points;
               - only LARGE structures block (owner 2026-11-21, "a completely straight roof"):
                 more than OBST_UP above the deck, at least BIG_W m thick and BIG_AREA m2 (the
                 drums, higher building parts), long high walls inside the roof (WALL_LEN, WALL_UP),
                 and cliffs (more than CLIFF m within 1 m, at least 3 m long: the raised east part
                 of the MELH roof); vents, skylight frames, housings, parapets on the outer edge,
                 mesh noise do not block;
               - holes smaller than HOLE_BIG m2 (and edge notches up to 2 m) are filled, larger
                 ones that drop away (courtyards, light wells, a lower roof part) stay = edge.
             Boxes: the blocking cells next to the deck, as static Box2D boxes in the game (row
             runs of cells merged into rectangles). Everything else around S is the edge: the car
             falls there; no box runs along the outer edge or the skywalk.
  3. heights   filled cells interpolated from the deck around them (normalised Gaussian); trenches
               and ridges narrower than ~2.5 m removed (grey closing + opening, 5 x 5 cells); then
               an edge-aware 5 x 5 mean (only neighbours within SMOOTH_TOL) twice: no cell jitter,
               the steps between roof parts stay sharp (the car rides them as short ramps).
               Stored as int16 cm in roofs_deck.bin (-32768 = off deck).
  4. poses     start (car on the deck, most room near `start`); the lift (js/liftpad.js slab,
               js/roofs.js ride): street slab (open sky over it), slide height over the canopy, roof
               dock (flat deck) and deliver pose; the street pose where the car rolls off after the
               ride down (street poses checked against walls / water like build_spots.py).
  --check      heights of S against the L1 AND L2 mesh at sample points along the route (incl.
               the skywalk), the skywalk's drivable width, the start pose's margin.

Frame: level x = east, z = -north (m), y up (the game frame); row j of a grid = north n0 + (j + 0.5)
* cell, column i = east x0 + (i + 0.5) * cell (row 0 = south, as find_roofs.py / build_level.py).
"""
import argparse, json, math, os, sys, time
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, REPO)
sys.path.insert(0, HERE)

CELL = 0.5          # m
MIN_REL = 3.0       # m above the street: a roof cell
GAP = 1.5           # m: closing radius (gaps up to ~2 x GAP wide are bridged)
MAX_STEP = 1.4      # m: largest step between deck parts (closed gaps, neighbouring cells); the
                    #    hall roof / wing steps are 0.9-1.3 m
LEVEL_TOL = 0.35    # m: rough cells this close to the deck next to them are deck
GROW = 2.0          # m: how far the deck grows into rough level cells
OBST_UP = 0.35      # m: higher than the deck next to it by this -> obstacle
HOLE_BIG = 30.0     # m2: holes in the roof smaller than this are filled (vents, housings, glass panes, dips)
BIG_W = 3.0         # m: a structure at least this thick ...
BIG_AREA = 20.0     # m2: ... and this big blocks (drums, higher building parts, lift towers)
WALL_LEN, WALL_UP = 10.0, 1.5   # m: a thin structure inside the roof this long and high blocks too
CLIFF = 1.6         # m: more than this within a 3 x 3 cell window of the deck = a wall, not a step
SMOOTH_TOL = 0.25   # m: edge-aware smoothing only averages neighbours this close in height
OBST_NEAR = 1.5     # m: obstacle cells this close to the deck become Box2D boxes
CAR_HL, CAR_HW = 4.495 / 2, 1.81 / 2
SLAB_T = 0.35       # m: thickness of the lift slab (js/liftpad.js)

# route: id, slug (spots.json), name, window (E0, N0, E1, N1 in metres east / north), seeds (x, z) that must be on
# one deck, start near (x, z, heading), the lift (street slab, roof dock, deliver pose) and the street
# pose where the car rolls off the slab after the ride down
ROUTES = [
    {"id": "bundestag", "slug": "bundestag-dach",
     "name": "Bundestag-Dach: Paul-Löbe-Haus → Spree-Skywalk → Marie-Elisabeth-Lüders-Haus",
     "window": (-1600.0, -340.0, -1080.0, -180.0),
     "seeds": [(-1540.0, 262.0), (-1360.0, 211.0), (-1200.0, 272.0)],
     "start": (-1530.0, 262.0, math.pi / 2),
     # the lift (owner 2026-11-21: "a grey platform instead" of the bear): a grey slab (len along x =
     # east-west, wid along z) at the west entrance, where the owner put the trigger (-1572.2, 259.4),
     # moved 9.8 m west to the open forecourt: the canopy (deck 58.0 m) ends at x -1573 and would hide
     # a slab under it from the chase camera; east end 2 m short of the canopy line. It rises, slides
     # east over the canopy strip and the wall at x -1568 and docks flush on the hall roof (dock); the
     # car rolls off to `deliver`. Down: the same slab from the dock, the car rolls off west to `street`.
     "lift": {"x": -1582.0, "z": 259.4, "len": 14.0, "wid": 5.0, "dock": (-1555.5, 259.4),
              "deliver": (-1540.0, 259.4, math.pi / 2)},
     "street": (-1597.0, 259.4, -math.pi / 2),
     "skywalk": [(-1400.0, 211.1), (-1325.0, 211.1)]},
]


def level(name, mesh_src):
    from build_pits import Level
    return Level(name, mesh_src)


def raster(lv, R, work):
    from build_level import raster_top
    f = os.path.join(work, f"top_{R['id']}.npy")
    E0, N0, E1, N1 = R["window"]
    nx, ny = int(round((E1 - E0) / CELL)), int(round((N1 - N0) / CELL))
    if os.path.exists(f):
        top = np.load(f)
        if top.shape == (ny, nx):
            return top
    t0 = time.time()
    prims, nt = lv.prims((E0, N0, E1, N1))
    top = raster_top(prims, E0, N0, nx, ny, CELL, colour=False)[0]
    del prims
    np.save(f, top)
    print(f"  raster {R['id']}: {nt} L1 tiles, {nx} x {ny} cells ({time.time() - t0:.0f} s) -> {f}")
    return top


class _A:   # find_roofs.drivable limits
    max_slope, rough, step = 10.0, 0.15, 0.3


def road_model(lv, R, shape):
    from find_roofs import road_on
    E0, N0 = R["window"][:2]
    return road_on(lv, E0, N0, shape[1], shape[0], CELL)


def nearest_vals(mask, val):
    """value of the nearest True cell of mask, everywhere; and the distance to it (m)"""
    d, (nj, ni) = ndimage.distance_transform_edt(~mask, return_indices=True)
    return val[nj, ni], d * CELL


def median3(S, h):
    """3 x 3 median of h over S (NaN outside), cells of S only"""
    hz = np.where(S, h, np.nan)
    st = np.stack([np.roll(np.roll(hz, dj, 0), di, 1) for dj in (-1, 0, 1) for di in (-1, 0, 1)])
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            hm = np.nanmedian(st, axis=0)
    return np.where(S, hm, np.nan)


def connected(S, H, R, info):
    """4-neighbour components of S joined only where |dH| <= MAX_STEP; keep the seeds' one"""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    jj, ii = np.nonzero(S)
    idx = -np.ones(S.shape, np.int64); idx[jj, ii] = np.arange(len(jj))
    rows, cols = [], []
    for dj, di in ((0, 1), (1, 0)):
        j2, i2 = jj + dj, ii + di
        ok = (j2 < S.shape[0]) & (i2 < S.shape[1])
        ok[ok] = S[j2[ok], i2[ok]]
        ok[ok] = np.abs(H[jj[ok], ii[ok]] - H[j2[ok], i2[ok]]) <= MAX_STEP
        rows.append(idx[jj[ok], ii[ok]]); cols.append(idx[j2[ok], i2[ok]])
    r, c = np.concatenate(rows), np.concatenate(cols)
    G = coo_matrix((np.ones(len(r)), (r, c)), shape=(len(jj), len(jj)))
    n, lab1 = connected_components(G, directed=False)
    lab = np.zeros(S.shape, np.int64); lab[jj, ii] = lab1 + 1
    E0, N0 = R["window"][:2]
    ids = set()
    for x, z in R["seeds"]:
        j, i = int((-z - N0) / CELL), int((x - E0) / CELL)
        win = lab[max(0, j - 6):j + 7, max(0, i - 6):i + 7]
        if not (win > 0).any():
            raise SystemExit(f"seed ({x}, {z}) not on a deck")
        ids.add(int(np.bincount(win[win > 0]).argmax()))
    if len(ids) != 1:
        print(f"  ! seeds on {len(ids)} separate decks: {sorted(ids)}")
    info["seedDecks"] = len(ids)
    return np.isin(lab, sorted(ids))


def deck(top, road, R):
    """-> dict S (bool), h (deck height, NaN off S), O (obstacle cells), info"""
    from find_roofs import drivable
    rel = top - road
    flat, _ = drivable(top, rel, CELL, _A)
    S0 = flat & (rel >= MIN_REL)
    info = {"flat": int(S0.sum())}
    # 1) close narrow gaps (steps between deck parts, ribs) when the cells there are between the sides
    r = int(round(GAP / CELL))
    disk = np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r
    closed = ndimage.binary_closing(S0, structure=disk, border_value=0)
    gap = closed & ~S0
    big, small = np.where(S0, top, -1e4), np.where(S0, top, 1e4)
    hmax = ndimage.maximum_filter(big, footprint=disk)
    hmin = ndimage.minimum_filter(small, footprint=disk)
    hn, _ = nearest_vals(S0, top)
    okgap = gap & (hmax - hmin <= MAX_STEP) & (top <= hmax + 0.1) & (top >= hmin - MAX_STEP)
    S = S0 | okgap
    h = np.where(S0, top, np.where(okgap, hn, np.nan))
    info["gapFilled"] = int(okgap.sum())
    # 2) grow into rough but level cells
    for _ in range(int(round(GROW / CELL))):
        hs, _d = nearest_vals(S, np.nan_to_num(h, nan=0.0))
        cand = ndimage.binary_dilation(S) & ~S & (np.abs(top - hs) <= LEVEL_TOL) & (rel >= MIN_REL)
        if not cand.any():
            break
        S |= cand
        h = np.where(cand, top, h)
    # 3) heights so far: 3 x 3 median over S; then the connected part with the seeds, where a
    #    step between neighbouring cells of more than MAX_STEP separates (towers, drums, a lower
    #    terrace next to the skywalk are other decks)
    H = median3(S, h)
    S = connected(S, H, R, info)
    # 4) cliffs inside S (a ring of cells joined round a drum): cells more than MAX_STEP above a
    #    deck neighbour leave the deck, then the seeds' part again
    for _ in range(4):
        hi = np.zeros_like(S)
        for dj, di in ((0, 1), (1, 0), (0, -1), (-1, 0)):
            Hn = np.roll(np.roll(H, dj, 0), di, 1); Sn = np.roll(np.roll(S, dj, 0), di, 1)
            hi |= S & Sn & (H - Hn > MAX_STEP)
        if not hi.any():
            break
        S &= ~hi
        H = np.where(S, H, np.nan)
        S = connected(S, H, R, info)
    # 5) what blocks (owner 2026-11-21: "a completely straight roof"): only LARGE structures - things
    #    more than OBST_UP above the deck next to them that are at least BIG_W m thick (survive an
    #    opening with a BIG_W disc: drums, higher building parts, lift towers) and BIG_AREA m2 big, plus
    #    long high walls inside the roof (>= WALL_LEN m long, >= WALL_UP m high, not on the outer edge).
    #    Vents, skylight frames, small housings, parapets on the outer edge, mesh noise: no box.
    hs, dS = nearest_vals(S, np.nan_to_num(H, nan=0.0))
    high = ~S & (top - hs > OBST_UP) & (dS <= 12.0)
    rb = int(round(BIG_W / 2 / CELL))
    thick = ndimage.binary_opening(high, structure=np.hypot(*np.mgrid[-rb:rb + 1, -rb:rb + 1]) <= rb)
    lab, n = ndimage.label(thick, structure=np.ones((3, 3)))
    area = ndimage.sum(thick, lab, np.arange(1, n + 1)) * CELL * CELL
    Big = np.isin(lab, 1 + np.flatnonzero(area >= BIG_AREA))
    outside = ~ndimage.binary_fill_holes(S | high)
    hl, nhl = ndimage.label(high & ~Big, structure=np.ones((3, 3)))
    nwall = 0
    for k, sl in enumerate(ndimage.find_objects(hl)):
        m = hl[sl] == k + 1
        jj, ii = np.nonzero(m)
        length = math.hypot(np.ptp(jj) + 1, np.ptp(ii) + 1) * CELL
        if length >= WALL_LEN and np.median((top[sl] - hs[sl])[m]) >= WALL_UP \
                and not (ndimage.binary_dilation(m, iterations=2) & outside[sl]).any():
            Big[sl] |= m; nwall += 1
    info.update(bigStructures=int(np.sum(area >= BIG_AREA)), innerWalls=nwall)
    # 6) holes: everything enclosed by deck + big structures, and notches up to 2 m wide at the edge;
    #    holes smaller than HOLE_BIG m2 are filled whatever is in them (vents, housings, glass panes,
    #    dips); larger ones are filled if level or higher (a thin raised bit), and stay open where
    #    they drop away (courtyards, large light wells, a lower roof part) - the car falls there
    r2 = int(round(1.0 / CELL))
    enclosed = ndimage.binary_fill_holes(S | Big) | ndimage.binary_closing(S, structure=np.hypot(*np.mgrid[-r2:r2 + 1, -r2:r2 + 1]) <= r2)
    cand = enclosed & ~S & ~Big
    cl, nc = ndimage.label(cand, structure=np.ones((3, 3)))
    nfill = nvoid = cfill = 0
    for k, sl in enumerate(ndimage.find_objects(cl)):
        m = cl[sl] == k + 1
        a_ = m.sum() * CELL * CELL
        if a_ < HOLE_BIG or np.median((top[sl] - hs[sl])[m]) >= -LEVEL_TOL:
            S[sl] |= m; nfill += 1; cfill += int(m.sum())
        else:
            nvoid += 1
    info.update(holesFilled=nfill, holeCellsFilled=cfill, holesOpen=nvoid)
    # 7) heights: filled cells from the deck around them (normalised Gaussian, wider until all have a
    #    value); then the whole deck smoothed edge-aware: 5 x 5 mean over neighbours within SMOOTH_TOL of
    #    the cell (steps between roof parts stay sharp, flat parts lose the cell-to-cell jitter), twice
    known = np.isfinite(H) & S
    Hf = np.where(known, H, np.nan)
    for sig in (1.0, 2.5, 6.0, 15.0):
        todo = S & ~np.isfinite(Hf)
        if not todo.any():
            break
        w = ndimage.gaussian_filter(known.astype(float), sig / CELL)
        v = ndimage.gaussian_filter(np.where(known, H, 0.0), sig / CELL)
        ok = todo & (w > 1e-3)
        Hf[ok] = v[ok] / w[ok]
    H = np.where(S, Hf, np.nan)
    # narrow trenches and ridges (< ~2.5 m across: a glass ring round the MELH dome, frames, gutters)
    # vanish: grey closing then opening over 5 x 5 cells; a step between roof parts is monotone and stays
    Hn, _d = nearest_vals(S, np.nan_to_num(H, nan=0.0))
    Hn = ndimage.grey_opening(ndimage.grey_closing(Hn, size=(5, 5)), size=(5, 5))
    H = np.where(S, Hn, np.nan)
    for _ in range(2):
        acc = np.zeros_like(top, dtype=np.float64); cnt = np.zeros_like(acc)
        Hz = np.nan_to_num(H, nan=-1e4)
        for dj in range(-2, 3):
            for di in range(-2, 3):
                Hn = np.roll(np.roll(Hz, dj, 0), di, 1)
                m = S & (np.abs(Hn - Hz) <= SMOOTH_TOL)
                acc += np.where(m, Hn, 0.0); cnt += m
        H = np.where(S, acc / np.maximum(cnt, 1), np.nan)
    # 8) cliffs at the 1 m scale: several <= MAX_STEP cell steps in a row (the raised east part of the
    #    MELH roof drops 3.5 m to the wings within 1.5 m): cells whose 3 x 3 deck range is more than
    #    CLIFF m leave the deck and block (a wall between a higher and a lower roof part), then the
    #    seeds' part again
    Hh, Hl = np.where(S, H, -1e4), np.where(S, H, 1e4)
    rng = ndimage.maximum_filter(Hh, size=3) - ndimage.minimum_filter(Hl, size=3)
    cliff = S & (rng > CLIFF)
    cl_, ncl = ndimage.label(cliff, structure=np.ones((3, 3)))   # short bits (< 3 m) are noise: they stay deck
    for k, sl in enumerate(ndimage.find_objects(cl_)):
        m = cl_[sl] == k + 1
        jj, ii = np.nonzero(m)
        if math.hypot(np.ptp(jj) + 1, np.ptp(ii) + 1) * CELL < 3.0:
            cliff[sl] &= ~m
    S &= ~cliff
    H = np.where(S, H, np.nan)
    S = connected(S, H, R, info)
    H = np.where(S, H, np.nan)
    Big |= cliff
    info["cliffCells"] = int(cliff.sum())
    # 9) boxes: the big structures (and cliffs) next to the deck
    hs, dS = nearest_vals(S, np.nan_to_num(H, nan=0.0))
    O = Big & (dS <= OBST_NEAR) & ~S
    info.update(cells=int(S.sum()), area=round(float(S.sum()) * CELL * CELL), obstacleCells=int(O.sum()))
    return {"S": S, "h": H, "O": O, "rel": rel, "info": info}


# ---------------------------------------------------------------- boxes, poses, output
def boxes(O, R):
    """obstacle cells -> axis-aligned rectangles [x0, z0, x1, z1] (row runs, merged down while equal)"""
    E0, N0 = R["window"][:2]
    runs = {}
    out = []
    for j in range(O.shape[0]):
        row = O[j]
        cur = {}
        i = 0
        while i < len(row):
            if not row[i]:
                i += 1; continue
            a = i
            while i < len(row) and row[i]:
                i += 1
            cur[(a, i)] = runs.pop((a, i), j)       # same run in the row above: extend it
        for (a, b), j0 in runs.items():             # runs that ended
            out.append((a, b, j0, j))
        runs = cur
    for (a, b), j0 in runs.items():
        out.append((a, b, j0, O.shape[0]))
    # cells -> game coords: x = E, z = -N
    return [[round(E0 + a * CELL, 2), round(-(N0 + j1 * CELL), 2), round(E0 + b * CELL, 2), round(-(N0 + j0 * CELL), 2)]
            for a, b, j0, j1 in out]


def car_pts(x, z, h, pad=0.0):
    fx, fz, lx, lz = math.sin(h), -math.cos(h), math.cos(h), math.sin(h)
    U, V = np.meshgrid(np.linspace(-CAR_HL - pad, CAR_HL + pad, 11), np.linspace(-CAR_HW - pad, CAR_HW + pad, 5))
    return x + U.ravel() * fx + V.ravel() * lx, z + U.ravel() * fz + V.ravel() * lz


def sampler(R, grid):
    E0, N0 = R["window"][:2]
    def f(xs, zs):
        i = np.floor((np.asarray(xs) - E0) / CELL).astype(int); j = np.floor((-np.asarray(zs) - N0) / CELL).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < grid.shape[1]) & (j < grid.shape[0])
        v = np.zeros(len(i), grid.dtype); v[ok] = grid[j[ok], i[ok]]
        return v, ok
    return f


def room(R, edge, x, z, h):
    """smallest distance (m) from the car box to the deck edge / an obstacle"""
    v, ok = sampler(R, edge)(*car_pts(x, z, h))
    return float(np.where(ok, v, 0).min())


def best_pose(R, edge, x, z, h, radius=8.0):
    best = (room(R, edge, x, z, h), x, z)
    for r in np.arange(1.0, radius + 0.01, 1.0):
        for a in np.linspace(0, 2 * math.pi, 16, endpoint=False):
            cx, cz = x + r * math.cos(a), z + r * math.sin(a)
            q = room(R, edge, cx, cz, h)
            if q > best[0] + 0.5:
                best = (q, cx, cz)
    return best


def street_check(lv_name, x, z, h):
    """build_spots.py clearances of a street pose (walls, footprints, clutter, trunks, water, pits)"""
    import build_spots as BS
    lv = BS.Level(lv_name)
    w = BS.Window(lv, x, z, half=60.0)
    cl = BS.clearance(w, x, z, h)
    probs = [f"{k} {cl[k]:.1f} m < {m}" for k, m in BS.MARGIN.items() if k != "border" and cl[k] < m]
    return {k: round(v, 1) for k, v in cl.items()}, probs


def street_y(top, road, R, x, z):
    """mesh street height at (x, z): the lowest top surface within 2 m (a tree crown or car does not count)"""
    E0, N0 = R["window"][:2]
    i, j = int((x - E0) / CELL), int((-z - N0) / CELL)
    t = top[max(0, j - 4):j + 5, max(0, i - 4):i + 5]
    return float(np.nanpercentile(t, 10))


def build(name, mesh_src, work, only=None, check=False):
    lv = level(name, mesh_src)
    out_routes, blobs, off = [], [], 0
    jpath = os.path.join(lv.dir, "roofs_deck.json")
    for R in ROUTES:
        if only and R["id"] not in only:
            continue
        print(f"== {R['id']}", flush=True)
        top = raster(lv, R, work)
        road = road_model(lv, R, top.shape)
        d = deck(top, road, R)
        S, H, O = d["S"], d["h"], d["O"]
        info = d["info"]
        print("  " + ", ".join(f"{k} {v}" for k, v in info.items()))
        E0, N0 = R["window"][:2]
        # room to the edge: distance to anything off the deck (obstacles included)
        edge = (ndimage.distance_transform_edt(S) * CELL).astype(np.float32)
        # poses
        x, z, h = R["start"]
        rm, sx, sz = best_pose(R, edge, x, z, h)
        start = {"x": round(sx, 2), "z": round(sz, 2), "h": round(h, 4), "y": None, "room": round(rm, 2)}
        # the lift: street slab (open sky above it: the top surface there is the street), dock on the roof
        Lf = R["lift"]
        lx, lz, hl, hw = Lf["x"], Lf["z"], Lf["len"] / 2, Lf["wid"] / 2
        def rect(cx, cz):
            i0_, i1_ = int((cx - hl - E0) / CELL), int((cx + hl - E0) / CELL) + 1
            j0_, j1_ = int((-(cz + hw) - N0) / CELL), int((-(cz - hw) - N0) / CELL) + 1
            return slice(j0_, j1_), slice(i0_, i1_)
        sl_ = rect(lx, lz)
        y0 = float(np.percentile(top[sl_], 50))
        sky = float((top[sl_] - road[sl_]).max())
        dx_, dz_ = Lf["dock"]
        dsl = rect(dx_, dz_)
        dk = H[dsl]
        on = float(np.isfinite(dk).mean())
        y1 = float(np.nanmax(dk))
        vx, vz, vh = Lf["deliver"]
        # slide height: the slab (top) clears everything under its sweep from the street spot to the dock
        # by SLAB_T + 0.3 m (the canopy at 58.0, the ridge at x -1568 up to 61.1)
        xa, xb = min(lx, dx_) - hl, max(lx, dx_) + hl
        sw = (slice(int((-(lz + hw) - N0) / CELL), int((-(lz - hw) - N0) / CELL) + 1), slice(int((xa - E0) / CELL), int((xb - E0) / CELL) + 1))
        travel = max(y1, float(top[sw].max()) + SLAB_T + 0.3)
        lift = {"x": lx, "z": lz, "len": Lf["len"], "wid": Lf["wid"], "y0": round(y0, 2), "sky": round(sky, 2),
                "travel": round(travel, 2), "thick": SLAB_T, "dock": {"x": dx_, "z": dz_, "y": round(y1, 2), "range": round(y1 - float(np.nanmin(dk)), 2), "onDeck": round(on, 3)},
                "deliver": {"x": vx, "z": vz, "h": round(vh, 4), "y": None, "room": round(room(R, edge, vx, vz, vh), 2)}}
        print(f"  lift street slab ({lx}, {lz}) {Lf['len']} x {Lf['wid']} m at y {y0:.2f} (highest top surface over it {sky:.2f} m "
              f"above the street model: {'open sky' if sky < 1.5 else 'COVERED'}); dock ({dx_}, {dz_}) y {y1:.2f}, deck range "
              f"{lift['dock']['range']} m, {100 * on:.0f} % on deck; rise {travel - y0:.2f} m to {travel:.2f}, slide {abs(dx_ - lx):.1f} m, settle {travel - y1:.2f} m")
        trig = {"x": lx, "z": lz, "r": hl, "y": round(y0, 2)}   # build_spots.py roof spots: the map marker
        stx, stz, sth = R["street"]
        street = {"x": stx, "z": stz, "h": round(sth, 4), "y": round(street_y(top, road, R, stx, stz), 2)}
        for name_, (px, pz, ph) in (("slab", (lx, lz, math.pi / 2)), ("slab-west", (lx - hl + 2.5, lz, math.pi / 2)),
                                    ("slab-east", (lx + hl - 2.5, lz, math.pi / 2)), ("street", (stx, stz, sth))):
            cl, probs = street_check(name, px, pz, ph)
            print(f"  {name_} ({px:.1f}, {pz}): " + ("ok" if not probs else "PROBLEM " + "; ".join(probs)) + f"  {cl}")
            if name_ == "street":
                street["clear"] = cl
            elif name_ == "slab":
                trig["clear"] = cl
        # crop the deck to its box (+ 2 cells)
        jj, ii = np.nonzero(S | O)
        j0, j1 = max(0, jj.min() - 2), min(S.shape[0], jj.max() + 3)
        i0, i1 = max(0, ii.min() - 2), min(S.shape[1], ii.max() + 3)
        Hc = np.where(S, np.round(H * 100), -32768)[j0:j1, i0:i1].astype("<i2")
        # floor under the deck for a fall: top surface at 1 m (min of 2 x 2: railings, lamp posts do not catch the car), whole window
        T = np.nan_to_num(top, nan=0.0)
        f2 = T[: T.shape[0] // 2 * 2, : T.shape[1] // 2 * 2].reshape(T.shape[0] // 2, 2, T.shape[1] // 2, 2).min(axis=(1, 3))
        Fc = np.round(f2 * 100).astype("<i2")
        sy = lambda x, z: float(H[int((-z - N0) / CELL), int((x - E0) / CELL)])
        start["y"] = round(sy(sx, sz), 2); lift["deliver"]["y"] = round(sy(vx, vz), 2)
        bx = boxes(O, R)
        rec = {"id": R["id"], "slug": R["slug"], "name": R["name"],
               "deck": {"x0": E0 + i0 * CELL, "n0": N0 + j0 * CELL, "cell": CELL, "nx": int(i1 - i0), "nz": int(j1 - j0),
                        "off": off, "count": int(Hc.size), "unit": 0.01, "void": -32768},
               "floor": {"x0": E0, "n0": N0, "cell": 2 * CELL, "nx": int(Fc.shape[1]), "nz": int(Fc.shape[0]),
                         "off": off + Hc.nbytes, "count": int(Fc.size), "unit": 0.01},
               "boxes": bx, "start": start, "lift": lift, "trigger": trig, "street": street,
               "stats": {**info, "boxes": len(bx), "heightMin": round(float(np.nanmin(H)), 2), "heightMax": round(float(np.nanmax(H)), 2),
                         "relMedian": round(float(np.nanmedian((H - road)[S])), 2)}}
        blobs += [Hc.tobytes(), Fc.tobytes()]
        off += Hc.nbytes + Fc.nbytes
        print(f"  deck {rec['deck']['nx']} x {rec['deck']['nz']} cells, {info['area']} m2, {len(bx)} obstacle boxes, "
              f"height {rec['stats']['heightMin']}..{rec['stats']['heightMax']} m (median {rec['stats']['relMedian']} m above the street)")
        print(f"  start ({start['x']}, {start['z']}) y {start['y']} room {start['room']} m; deliver ({vx}, {vz}) y {lift['deliver']['y']} "
              f"room {lift['deliver']['room']} m")
        if check:
            rec["check"] = check_route(lv, R, top, road, S, H, edge, start)
        out_routes.append(rec)
    doc = {"level": name, "file": "roofs_deck.bin",
           "frame": "level x = east, z = -north (m), y up; grid row j = north n0 + (j + 0.5) * cell, column i = east x0 + (i + 0.5) * cell",
           "note": "built by build_roofs.py (js/roofs.js): deck = int16 cm heights of the drivable roof (void = off the deck: the car falls), "
                   "floor = int16 cm top surface at 1 m (where a falling car lands), boxes = obstacles on the roof [x0, z0, x1, z1]",
           "routes": out_routes}
    with open(os.path.join(lv.dir, "roofs_deck.bin"), "wb") as f:
        for b in blobs:
            f.write(b)
    json.dump(doc, open(jpath, "w"), ensure_ascii=False, indent=1)
    print(f"-> {jpath} ({off / 1e3:.0f} kB binary)")


def check_route(lv, R, top, road, S, H, edge, start):
    """deck heights vs the L1 and L2 mesh at sample points (incl. the skywalk), skywalk width, start room"""
    from build_level import raster_top
    E0, N0 = R["window"][:2]
    res = {}
    # sample points: every 15 m along the seeds' polyline + the skywalk every 5 m, on the deck only
    pts = []
    sk = R.get("skywalk")
    if sk:
        (ax, az), (bx_, bz) = sk
        for t in np.linspace(0, 1, 16):
            pts.append((ax + (bx_ - ax) * t, az + (bz - az) * t, "skywalk"))
    rng = np.random.default_rng(1)
    jj, ii = np.nonzero(S & (edge >= 1.5))
    for k in rng.choice(len(jj), 24, replace=False):
        pts.append((E0 + (ii[k] + 0.5) * CELL, -(N0 + (jj[k] + 0.5) * CELL), "roof"))
    rows = []
    for lod in (1, 2):
        rws = [r for r in lv.tiles if r[1] == lod]
        for x, z, kind in pts:
            # tiny raster (3 x 3 cells of 0.1 m) around the point straight from the mesh
            prims, _ = lv.prims((x - 0.2, -z - 0.2, x + 0.2, -z + 0.2), margin=1.0, rows=rws)
            t = raster_top(prims, x - 0.15, -z - 0.15, 3, 3, 0.1, colour=False)[0]
            m = float(np.nanmax(t)) if np.isfinite(t).any() else float("nan")
            i, j = int((x - E0) / CELL), int((-z - N0) / CELL)
            dv = float(H[j, i]) if S[j, i] else float("nan")
            rows.append({"lod": lod, "kind": kind, "x": round(x, 1), "z": round(z, 1), "deck": round(dv, 2), "mesh": round(m, 2),
                         "diff": round(dv - m, 2) if np.isfinite(dv) and np.isfinite(m) else None})
    for lod in (1, 2):
        for kind in ("roof", "skywalk"):
            d = [r["diff"] for r in rows if r["lod"] == lod and r["kind"] == kind and r["diff"] is not None]
            if d:
                a = np.abs(d)
                res[f"L{lod}_{kind}"] = {"n": len(d), "median": round(float(np.median(d)), 3), "p90abs": round(float(np.percentile(a, 90)), 3),
                                         "maxabs": round(float(a.max()), 3)}
                print(f"  check L{lod} {kind:7s}: n {len(d)} deck - mesh median {np.median(d):+.3f} m, |.| p90 {np.percentile(a, 90):.3f}, max {a.max():.3f}")
    off = [r for r in rows if r["diff"] is None]
    if off:
        print(f"  ! {len(off)} sample points off the deck: " + ", ".join(f"({r['x']}, {r['z']}) L{r['lod']}" for r in off[:8]))
    res["samples"] = rows
    # skywalk width: deck cells across (north-south) at stations along it
    if sk:
        W = []
        for x in np.arange(sk[0][0], sk[1][0] + 0.01, 2.5):
            i = int((x - E0) / CELL)
            col = S[:, i]
            j = int((-sk[0][1] - N0) / CELL)
            if not col[j]:
                W.append((round(float(x), 1), 0.0, None)); continue
            a = b = j
            while a > 0 and col[a - 1]: a -= 1
            while b < len(col) - 1 and col[b + 1]: b += 1
            W.append((round(float(x), 1), (b - a + 1) * CELL, round(float(np.nanmean(H[a:b + 1, i])), 2)))
        ws = [w for _, w, _ in W]
        res["skywalkWidth"] = {"stations": W, "min": min(ws), "median": float(np.median(ws)), "max": max(ws)}
        print(f"  skywalk deck width (m, every 2.5 m): min {min(ws)} median {np.median(ws)} max {max(ws)}; "
              f"heights {W[0][2]} -> {W[len(W) // 2][2]} -> {W[-1][2]}")
        print("   " + " ".join(f"{w:.1f}" for w in ws))
    res["startRoom"] = start["room"]
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--name", default="mitte_all")
    ap.add_argument("--mesh-src", default=os.path.join(REPO, "berlin_mesh_2025_wab"))
    ap.add_argument("--work", default=os.environ.get("ROOF_WORK", "/tmp/roofdeck"))
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--check", action="store_true", help="heights vs the L1 / L2 mesh, skywalk width (slow: ~1-2 min)")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    build(a.name, a.mesh_src, a.work, a.only, a.check)


if __name__ == "__main__":
    main()
