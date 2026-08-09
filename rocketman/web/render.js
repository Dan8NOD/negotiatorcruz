/**
 * Canvas renderer.
 *
 * Reads world state and draws it. It must never write to the simulation —
 * every player action goes back in as a command — so this file is free to use
 * Math.random for particles, interpolate positions between ticks, and
 * generally lie for the sake of looking right.
 *
 * The look it is chasing is the classic C&C presentation: ground that reads
 * as *terrain* rather than a grid, structures with weight and light,
 * weapons-fire that glows, and explosions that leave marks on the world.
 * Everything is still drawn from stats — silhouette encodes role, colour
 * encodes faction — because legibility is the one thing the reference games
 * never traded away.
 *
 * Structure of a frame:
 *   terrain (baked once) → battle scars (persistent decals) → resources →
 *   buildings → units → projectiles → a single additive glow pass for
 *   everything that emits light → particles → fog → vignette.
 *
 * The glow pass is the trick that buys the arcade look cheaply: anything hot
 * (tracers, beams, fireballs, reactor cores, engine flames) queues a closure
 * during the normal pass, and they are all drawn together under
 * `globalCompositeOperation = 'lighter'` so light stacks the way light does.
 */

import { CELL, TERRAIN_INFO, FACTIONS, UNITS, BUILDINGS, biomeOf } from '../engine/content.js';
import { superweaponReady } from '../engine/economy.js';
import { isVisible, isExplored } from '../engine/vision.js';

const NEUTRAL = '#8b98a6';
const TAU = Math.PI * 2;

/**
 * Spark colour per warhead, so an impact says which warhead landed.
 *
 * The counter triangle is the game's central decision and it is otherwise
 * invisible at the moment of contact — the damage number never appears, so
 * without this the only way to know an energy weapon is chewing through your
 * heavy plate is to watch the health bar and infer. Colour makes it readable
 * in peripheral vision, which is where most of an RTS is played.
 */
const IMPACT_TINTS = {
  kinetic: [255, 190, 110],
  explosive: [255, 150, 70],
  energy: [130, 240, 255],
  emp: [190, 220, 255],
};

/** Deterministic 2D hash → [0,1). Terrain detail must not shimmer between
 *  frames, so anything baked derives from coordinates, never Math.random. */
function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise over the cell grid, for large-scale ground variation. */
function valueNoise(x, y, freq) {
  const gx = x * freq;
  const gy = y * freq;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/* --------------------------------------------------------- terrain LOD -- */

/**
 * Terrain is baked rather than redrawn per frame — repainting twenty thousand
 * cells every frame is the easiest way to make a grid game stutter. But "bake
 * the whole map into one canvas" stopped being affordable when the maps
 * doubled: 144×144 cells at 24 px is a 3456×3456 buffer, about 48 MB of
 * pixels, and the decal layer was a second one. A mid-range Android phone
 * does not have 96 MB of canvas to spare, and this game is going on Play.
 *
 * So the bake has two levels:
 *
 *   - a **base** covering the whole map at `LOD_CELL` px per cell, always
 *     resident, a few megabytes;
 *   - **chunks** at full `CELL` detail, baked on demand for what is actually
 *     on screen and kept in a small LRU.
 *
 * The base is always drawn first, so a chunk that has not been baked yet
 * shows correct-looking ground rather than a hole — there is no pop-in, only
 * a sharpening. And when the view is zoomed out far enough that detail chunks
 * would exceed the budget, they are skipped entirely for that frame: at that
 * distance per-cell speckle is under a pixel, so the base *is* the picture.
 * That rule is what stops a wide view thrashing the cache instead of
 * exceeding the memory it was meant to protect.
 */
const CHUNK = 16;

/** Cell size of the always-resident whole-map bake. */
const LOD_CELL = 8;

/** Cell size of the persistent decal buffer. */
const DECAL_CELL = 12;

/**
 * How many full-detail chunks may be resident at once. Each is
 * CHUNK² × CELL² × 4 bytes ≈ 0.6 MB, so this is a ~21 MB ceiling.
 */
const CHUNK_BUDGET = 36;

function createTerrainLayers(map) {
  const base = document.createElement('canvas');
  base.width = map.width * LOD_CELL;
  base.height = map.height * LOD_CELL;
  paintTerrainRegion(base.getContext('2d'), map, LOD_CELL, 0, 0, map.width, map.height);

  /** Key `cy * cols + cx` → canvas. Insertion order is the LRU order. */
  const chunks = new Map();
  const cols = Math.ceil(map.width / CHUNK);
  const rows = Math.ceil(map.height / CHUNK);

  function chunkAt(cx, cy) {
    const key = cy * cols + cx;
    const found = chunks.get(key);
    if (found) {
      // Touch: delete and re-insert so this chunk moves to the young end.
      chunks.delete(key);
      chunks.set(key, found);
      return found;
    }

    const x0 = cx * CHUNK;
    const y0 = cy * CHUNK;
    const x1 = Math.min(map.width, x0 + CHUNK);
    const y1 = Math.min(map.height, y0 + CHUNK);
    const canvas = document.createElement('canvas');
    canvas.width = (x1 - x0) * CELL;
    canvas.height = (y1 - y0) * CELL;
    paintTerrainRegion(canvas.getContext('2d'), map, CELL, x0, y0, x1, y1);

    chunks.set(key, canvas);
    while (chunks.size > CHUNK_BUDGET) {
      const oldest = chunks.keys().next().value;
      const evicted = chunks.get(oldest);
      chunks.delete(oldest);
      // Zeroing the dimensions is what actually releases the backing store in
      // Chrome and Safari; dropping the reference alone leaves it to the GC,
      // which on a phone is exactly the wrong time to find out.
      evicted.width = 0;
      evicted.height = 0;
    }
    return canvas;
  }

  return {
    base,
    cols,
    rows,
    chunkAt,
    /** Live chunk count. Exposed for the inspection hook and tests. */
    residentChunks: () => chunks.size,
  };
}

export function createRenderer(canvas, world, viewerId) {
  const ctx = canvas.getContext('2d', { alpha: false });

  // A floor of 0.45 was "most of a 72-cell map on screen". On a doubled map
  // it is a quarter of one, which turns the zoom control into a slightly
  // wider view rather than a way to see the battlefield. 0.3 puts a whole
  // 144-cell map inside a desktop viewport, and the terrain LOD is built for
  // exactly that case — at this distance the base bake *is* the picture.
  const camera = { x: 0, y: 0, zoom: 1, minZoom: 0.3, maxZoom: 2.4 };

  const terrain = createTerrainLayers(world.map);

  // Battle scars. Explosions and deaths stamp scorch marks and craters here,
  // so a fought-over ridge *stays* fought-over — the map remembers.
  //
  // Deliberately half resolution. Scorch is a soft radial gradient with no
  // edge to lose, so nobody will ever see the difference — and at full
  // resolution this one buffer is 48 MB on a doubled map, which is 48 MB a
  // phone does not have.
  const decalLayer = document.createElement('canvas');
  decalLayer.width = world.map.width * DECAL_CELL;
  decalLayer.height = world.map.height * DECAL_CELL;
  const decalCtx = decalLayer.getContext('2d');

  // Fog is drawn at one pixel per cell and scaled up, which gives a soft edge
  // for free and costs nothing.
  const fogLayer = document.createElement('canvas');
  fogLayer.width = world.map.width;
  fogLayer.height = world.map.height;
  const fogCtx = fogLayer.getContext('2d');
  const fogImage = fogCtx.createImageData(world.map.width, world.map.height);

  const state = {
    camera,
    /** Fractional progress through the current tick, for interpolation. */
    alpha: 0,
    hoverCell: { x: 0, y: 0 },
    /** Cursor in screen pixels, for the superweapon reticle. */
    hoverPixel: { x: 0, y: 0 },
    /** Set by input.js while a superweapon strike is being aimed. */
    strikeAim: null,
    /** Set by input.js while a targeted ability is being aimed. */
    abilityAim: null,
    /** Set by input.js while a structure is being sited. */
    placement: null,
    selectionBox: null,
    sparks: [],
  };

  /** Closures queued during the normal pass, drawn together additively. */
  let glowQueue = [];
  const glow = (fn) => glowQueue.push(fn);

  /** Animation clock in frames. Presentation-only; ticks even when paused. */
  let frameClock = 0;

  /**
   * Camera shake. Decays every frame and is added to the world transform, so
   * it moves the *view* and never the simulation — a shaken camera must not
   * change where a click lands mid-explosion, which is why it is applied to
   * the draw transform and not to `camera.x`.
   */
  let shake = 0;
  let shakeX = 0;
  let shakeY = 0;
  const addShake = (amount) => {
    shake = Math.min(14, shake + amount);
  };

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /* ------------------------------------------------------- coordinates -- */

  const viewWidth = () => canvas.clientWidth;
  const viewHeight = () => canvas.clientHeight;
  const scale = () => CELL * camera.zoom;

  function worldToScreen(wx, wy) {
    return { x: (wx - camera.x) * scale(), y: (wy - camera.y) * scale() };
  }

  function screenToWorld(sx, sy) {
    return { x: sx / scale() + camera.x, y: sy / scale() + camera.y };
  }

  function clampCamera() {
    const visibleW = viewWidth() / scale();
    const visibleH = viewHeight() / scale();
    camera.x = Math.max(-2, Math.min(world.map.width - visibleW + 2, camera.x));
    camera.y = Math.max(-2, Math.min(world.map.height - visibleH + 2, camera.y));
  }

  function centreOn(wx, wy) {
    camera.x = wx - viewWidth() / scale() / 2;
    camera.y = wy - viewHeight() / scale() / 2;
    clampCamera();
  }

  function zoomAt(sx, sy, factor) {
    const before = screenToWorld(sx, sy);
    camera.zoom = Math.max(camera.minZoom, Math.min(camera.maxZoom, camera.zoom * factor));
    const after = screenToWorld(sx, sy);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;
    clampCamera();
  }

  /* ------------------------------------------------------------- draw -- */

  function draw(selection) {
    frameClock++;
    const w = viewWidth();
    const h = viewHeight();

    ctx.fillStyle = '#05070b';
    ctx.fillRect(0, 0, w, h);

    // Decay first, so a single explosion is a sharp hit rather than a wobble.
    shake *= 0.86;
    if (shake < 0.05) shake = 0;
    shakeX = (Math.random() - 0.5) * shake;
    shakeY = (Math.random() - 0.5) * shake;

    const s = scale();
    ctx.save();
    ctx.translate(-camera.x * s + shakeX, -camera.y * s + shakeY);
    ctx.scale(camera.zoom, camera.zoom);

    drawTerrain();
    ctx.drawImage(decalLayer, 0, 0, world.map.width * CELL, world.map.height * CELL);

    drawResources();
    drawProps();
    drawGateways();
    drawBuildings(selection);
    drawPlacementPreview();
    drawStrikePreview();
    drawAbilityPreview(selection);
    drawUnits(selection);
    drawProjectiles();
    drawEffects();
    drawParticles(false);

    // Everything that emits light, in one additive pass.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const fn of glowQueue) fn();
    drawParticles(true);
    ctx.restore();
    glowQueue = [];

    ctx.restore();

    drawFog();
    drawVignette(w, h);
    drawSelectionBox();
  }

  /**
   * The base bake, then full-detail chunks over whatever is on screen.
   *
   * The budget check is the load-bearing part: when the view is wide enough
   * to want more chunks than may be resident, drawing them would evict each
   * other every frame and re-bake constantly. Falling back to the base costs
   * detail nobody can resolve at that zoom and costs no memory at all.
   */
  function drawTerrain() {
    ctx.drawImage(terrain.base, 0, 0, world.map.width * CELL, world.map.height * CELL);

    const { x0, y0, x1, y1 } = visibleBounds();
    const cx0 = Math.floor(x0 / CHUNK);
    const cy0 = Math.floor(y0 / CHUNK);
    const cx1 = Math.min(terrain.cols - 1, Math.floor((x1 - 1) / CHUNK));
    const cy1 = Math.min(terrain.rows - 1, Math.floor((y1 - 1) / CHUNK));
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > CHUNK_BUDGET) return;

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        ctx.drawImage(terrain.chunkAt(cx, cy), cx * CHUNK * CELL, cy * CHUNK * CELL);
      }
    }
  }

  function visibleBounds() {
    const s = scale();
    return {
      x0: Math.max(0, Math.floor(camera.x) - 1),
      y0: Math.max(0, Math.floor(camera.y) - 1),
      x1: Math.min(world.map.width, Math.ceil(camera.x + viewWidth() / s) + 1),
      y1: Math.min(world.map.height, Math.ceil(camera.y + viewHeight() / s) + 1),
    };
  }

  /* -------------------------------------------------------- resources -- */

  function drawResources() {
    const { x0, y0, x1, y1 } = visibleBounds();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const amount = world.map.resource[y * world.map.width + x];
        if (amount <= 0) continue;
        if (!isExplored(world, viewerId, x, y)) continue;

        // Wreckage heaps: a dark mound with plates piled on it, dense in
        // proportion to what is left, so a worked-out patch visibly thins.
        // (The first cut scattered plates across the whole cell and read as
        // confetti; clustering them on a mound is what makes them *piles*.)
        const richness = Math.min(1, amount / 1800);
        const px = x * CELL;
        const py = y * CELL;
        const mx = px + CELL / 2 + (hash2(x * 3, y * 7) - 0.5) * 6;
        const my = py + CELL / 2 + (hash2(x * 9, y * 5) - 0.5) * 6;

        // The mound is barely-there shading under the plates. Anything
        // stronger tiles a wreck field with grey ovals — mission one is one
        // giant field, so this is tuned against the worst case, not a sample.
        ctx.fillStyle = `rgba(30, 34, 26, ${0.1 + richness * 0.12})`;
        ctx.beginPath();
        ctx.ellipse(mx, my, 6 + richness * 2, 4.5 + richness * 1.5, 0, 0, TAU);
        ctx.fill();

        const n = 2 + Math.round(richness * 3);
        for (let i = 0; i < n; i++) {
          const a = hash2(x * 31 + i, y * 17) * TAU;
          const d = hash2(x * 13, y * 41 + i) * (4 + richness * 3);
          const cx = mx + Math.cos(a) * d;
          const cy = my + Math.sin(a) * d * 0.7;
          const sz = 4 + hash2(x + i, y - i) * 4 * (0.5 + richness);
          const rot = hash2(x * 7 + i, y * 3) * TAU;

          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(rot);
          ctx.fillStyle = `rgba(96, 108, 66, ${0.55 + richness * 0.35})`;
          ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.7);
          ctx.fillStyle = `rgba(180, 204, 96, ${0.3 + richness * 0.4})`;
          ctx.fillRect(-sz / 2, -sz / 2, sz, sz * 0.22);
          ctx.restore();
        }

        // The occasional glint, so scrap sparkles the way ore fields did.
        if (hash2(x, y + ((frameClock >> 4) & 7)) > 0.97) {
          const gx = px + hash2(x + 5, y) * CELL;
          const gy = py + hash2(x, y + 5) * CELL;
          glow(() => {
            ctx.fillStyle = 'rgba(230, 244, 170, 0.5)';
            ctx.fillRect(gx - 1, gy - 1, 2, 2);
          });
        }
      }
    }
  }

  /* ------------------------------------------------------------ props -- */

  /**
   * Destructible scenery, drawn with fake elevation.
   *
   * The trick that sells height on a top-down map is parallax: a tall thing's
   * roof is offset *away from the camera centre* in proportion to how tall it
   * is and how far off-axis it sits. Panning past a tower block then makes its
   * silhouette lean, the way it would through a real lens, and the eye reads
   * "tall" without any isometric projection.
   *
   * Drawn in y order so nearer buildings overlap further ones, and before
   * units so a mech in the street is never hidden behind a house.
   */
  function drawProps() {
    const { x0, y0, x1, y1 } = visibleBounds();
    const list = [];
    for (const e of world.entities.values()) {
      if (e.kind !== 'prop' || e.dead) continue;
      if (e.cx + e.size[0] < x0 || e.cx > x1 || e.cy + e.size[1] < y0 || e.cy > y1) continue;
      if (!isExplored(world, viewerId, e.x, e.y)) continue;
      list.push(e);
    }
    list.sort((a, b) => a.y - b.y);
    for (const e of list) drawProp(e);
  }

  /** Roof offset for a prop of this height at this position. */
  function elevation(e) {
    const s = worldToScreen(e.x, e.y);
    const cx = viewWidth() / 2;
    const cy = viewHeight() / 2;
    const lean = 0.09;
    return {
      dx: ((s.x - cx) / Math.max(1, cx)) * e.def.height * CELL * lean,
      dy: ((s.y - cy) / Math.max(1, cy)) * e.def.height * CELL * lean - e.def.height * CELL * 0.34,
    };
  }

  function drawProp(e) {
    const px = e.cx * CELL;
    const py = e.cy * CELL;
    const pw = e.size[0] * CELL;
    const ph = e.size[1] * CELL;
    const hurt = e.hp / e.maxHp;
    const { dx, dy } = elevation(e);

    // Ground shadow, cast away from the light and scaled by height.
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.beginPath();
    ctx.ellipse(px + pw / 2 + 4, py + ph / 2 + 5, pw * 0.62, ph * 0.44, 0, 0, TAU);
    ctx.fill();

    // Dispatch on shape rather than on id, so a new prop is a content-table
    // entry and not a renderer change — the shapes are a small vocabulary
    // that a dozen different props are assembled from.
    const shape = e.def.shape || (e.def.canopy ? 'canopy' : e.def.volatile ? 'volatile' : 'block');
    switch (shape) {
      case 'canopy':
        drawTree(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'watertower':
        drawWaterTower(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'mast':
        drawMast(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'billboard':
        drawBillboard(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'silo':
        drawSilo(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'depot':
        drawDepot(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'vehicle':
        drawVehicle(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'fountain':
        drawFountain(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'volatile':
        drawVolatile(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'headquarters':
        drawHeadquarters(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'castle':
        drawCastle(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'pillar':
        drawPillar(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'crystal':
        drawCrystal(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'rubble':
        drawRubble(e, px, py, pw, ph, dx, dy, hurt);
        break;
      case 'brazier':
        drawBrazier(e, px, py, pw, ph, dx, dy, hurt);
        break;
      default:
        if (e.defId === 'statue') drawStatue(e, px, py, pw, ph, dx, dy, hurt);
        else drawBlock(e, px, py, pw, ph, dx, dy, hurt);
    }

    // Damage: cracks and smoke once it is genuinely hurt.
    if (hurt < 0.55) {
      if (Math.random() < (hurt < 0.3 ? 0.18 : 0.07)) {
        addParticle('smoke', e.x + (Math.random() - 0.5) * e.size[0], e.y - e.def.height * 0.3);
      }
      if (hurt < 0.3 && Math.random() < 0.05) addParticle('flame', e.x, e.y - e.def.height * 0.2);
    }
    // A volatile prop under fire is a warning worth shouting.
    if (e.def.volatile && hurt < 0.7) {
      const pulse = 0.3 + 0.4 * Math.sin(frameClock * 0.3 + e.id);
      glow(() => {
        ctx.fillStyle = `rgba(255, 120, 60, ${pulse * 0.5})`;
        ctx.beginPath();
        ctx.arc(px + pw / 2 + dx, py + ph / 2 + dy, pw * 0.5, 0, TAU);
        ctx.fill();
      });
    }
  }

  /**
   * Palette for one building, hashed from its id.
   *
   * A street of twenty identical boxes reads as one asset stamped twenty
   * times; a street of twenty *slightly different* boxes reads as a place
   * people lived. Hashed rather than random so a house does not change colour
   * between frames, and derived from the id so it survives a replay.
   */
  const HOUSE_TONES = [
    { wall: '#3a3230', roof: '#4a3b34', trim: '#5c4a40' }, // brick
    { wall: '#33383f', roof: '#414a55', trim: '#525d6a' }, // slate
    { wall: '#3c3a33', roof: '#4d4a3d', trim: '#5f5b4a' }, // render
    { wall: '#2f3a3a', roof: '#3c4a4a', trim: '#4b5c5c' }, // weatherboard
    { wall: '#3d3436', roof: '#4e4044', trim: '#605055' }, // painted
  ];

  function toneFor(e) {
    if (e.def.height > 2) return { wall: '#232d39', roof: '#39465a', trim: '#4a5a70' };
    return HOUSE_TONES[Math.floor(hash2(e.id, e.cx + e.cy) * HOUSE_TONES.length) % HOUSE_TONES.length];
  }

  /** A building: walls from footprint to roof, then a lit roof plate. */
  function drawBlock(e, px, py, pw, ph, dx, dy, hurt) {
    const storeys = e.def.storeys || 3;
    const tone = toneFor(e);
    const pitched = e.def.height <= 1.2;
    const rx = px + dx;
    const ry = py + dy;

    // Side walls as quads from each footprint corner to its roof corner.
    const wall = ctx.createLinearGradient(px, py + ph, rx, ry);
    wall.addColorStop(0, shade(tone.wall, -0.4));
    wall.addColorStop(1, tone.wall);
    ctx.fillStyle = wall;
    ctx.beginPath();
    ctx.moveTo(px, py + ph);
    ctx.lineTo(px + pw, py + ph);
    ctx.lineTo(rx + pw, ry + ph);
    ctx.lineTo(rx, ry + ph);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px + pw, py);
    ctx.lineTo(px + pw, py + ph);
    ctx.lineTo(rx + pw, ry + ph);
    ctx.lineTo(rx + pw, ry);
    ctx.closePath();
    ctx.fillStyle = shade(tone.wall, -0.55);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px, py + ph);
    ctx.lineTo(rx, ry + ph);
    ctx.lineTo(rx, ry);
    ctx.closePath();
    ctx.fillStyle = shade(tone.wall, -0.25);
    ctx.fill();

    // Windows up the visible wall, dimming as the building is wrecked.
    const rows = Math.min(storeys, 9);
    for (let r = 0; r < rows; r++) {
      const t = (r + 0.6) / (rows + 0.2);
      const wy = py + ph + (ry + ph - (py + ph)) * t;
      const wx = px + (rx - px) * t;
      for (let c = 0; c < Math.max(1, Math.round(pw / 9)); c++) {
        const lit = hash2(e.id + r * 7, c * 13) > 0.45 && hurt > 0.4;
        if (lit) {
          // Lit windows go through the glow pass, so a street at distance
          // reads as inhabited rather than as speckle.
          const gx = wx + 3 + c * 9;
          const gy = wy - 2.5;
          glow(() => {
            ctx.fillStyle = 'rgba(255, 206, 130, 0.5)';
            ctx.fillRect(gx, gy, 4, 2.5);
          });
        }
        ctx.fillStyle = lit ? 'rgba(255, 224, 170, 0.75)' : 'rgba(10, 14, 20, 0.72)';
        ctx.fillRect(wx + 3 + c * 9, wy - 2.5, 4, 2.5);
      }
    }

    // Roof. Suburbia gets a pitch with a ridge line and a chimney; anything
    // tall gets a flat deck, because that is what tall buildings have.
    const roof = ctx.createLinearGradient(rx, ry, rx + pw * 0.6, ry + ph);
    roof.addColorStop(0, tone.trim);
    roof.addColorStop(1, shade(tone.roof, -0.3));
    ctx.fillStyle = roof;
    ctx.fillRect(rx, ry, pw, ph);

    if (pitched) {
      // Two slopes meeting at a ridge: the lit side, then the ridge itself.
      ctx.fillStyle = shade(tone.roof, 0.12);
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx + pw, ry);
      ctx.lineTo(rx + pw * 0.5, ry + ph * 0.52);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(rx + 1, ry + ph * 0.52);
      ctx.lineTo(rx + pw - 1, ry + ph * 0.52);
      ctx.stroke();
      // Chimney, on the half of the roof the hash picks.
      const cx = rx + pw * (hash2(e.cx, e.cy) > 0.5 ? 0.26 : 0.7);
      ctx.fillStyle = shade(tone.wall, -0.3);
      ctx.fillRect(cx - 2, ry + ph * 0.2, 4, 5);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(rx, ry, pw, 2);
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + 0.5, ry + 0.5, pw - 1, ph - 1);

    // A steeple, on the buildings that carry one. It leans with the parallax
    // like everything else, which is what makes it read as the tallest thing
    // on the street rather than as a triangle painted on a roof.
    if (e.def.spire) {
      const sx = rx + pw * 0.5;
      const sy = ry + ph * 0.5;
      const tipX = sx + dx * 0.8;
      const tipY = sy + dy * 0.8 - ph * 0.35;
      ctx.fillStyle = shade(tone.roof, -0.15);
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(sx + pw * 0.16, sy + ph * 0.12);
      ctx.lineTo(sx - pw * 0.16, sy + ph * 0.12);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(210, 220, 232, 0.5)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX, tipY - 4);
      ctx.moveTo(tipX - 2, tipY - 2.5);
      ctx.lineTo(tipX + 2, tipY - 2.5);
      ctx.stroke();
    }

    // Rooftop clutter on the big ones — it is what stops a tower reading as a
    // grey box from above.
    if (e.def.height > 2) {
      ctx.fillStyle = '#1c242e';
      ctx.fillRect(rx + pw * 0.2, ry + ph * 0.25, pw * 0.28, ph * 0.28);
      ctx.fillRect(rx + pw * 0.58, ry + ph * 0.55, pw * 0.22, ph * 0.2);
      // Aircraft warning light.
      if ((frameClock >> 4) % 4 === 0) {
        glow(() => {
          ctx.fillStyle = 'rgba(255, 90, 80, 0.95)';
          ctx.beginPath();
          ctx.arc(rx + pw * 0.5, ry + ph * 0.5, 2.2, 0, TAU);
          ctx.fill();
        });
      }
    }
  }

  /** A tree: trunk to the footprint, canopy above, swaying slightly. */
  function drawTree(e, px, py, pw, ph, dx, dy, hurt) {
    const bx = px + pw / 2;
    const by = py + ph / 2;
    const sway = Math.sin(frameClock * 0.03 + e.id) * (e.def.low ? 0.5 : 1.4);
    const tx = bx + dx + sway;
    const ty = by + dy;
    const green = hurt > 0.5 ? 1 : 0.45 + hurt;
    const dark = `rgba(${Math.round(38 + (1 - green) * 60)}, ${Math.round(62 * green + 18)}, ${Math.round(34 * green + 14)}, 0.95)`;
    const lit = `rgba(${Math.round(60 + (1 - green) * 60)}, ${Math.round(92 * green + 20)}, ${Math.round(52 * green + 16)}, 0.9)`;

    // A hedgerow is a low mass with no trunk to speak of — drawn as a run of
    // overlapping bunches along its footprint rather than as a small tree,
    // because a small tree at this height just reads as a broken tree.
    if (e.def.low) {
      const bunches = Math.max(2, Math.round(pw / 9));
      for (let i = 0; i < bunches; i++) {
        const cx = px + ((i + 0.5) / bunches) * pw + dx * 0.4;
        const cy = py + ph * 0.55 + dy * 0.4;
        ctx.fillStyle = i % 2 ? dark : lit;
        ctx.beginPath();
        ctx.ellipse(cx, cy, pw / bunches * 0.7, ph * 0.42, 0, 0, TAU);
        ctx.fill();
      }
      return;
    }

    ctx.strokeStyle = '#241d16';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(bx, by + 2);
    ctx.lineTo(tx, ty + 3);
    ctx.stroke();

    // A conifer is a stack of narrowing tiers, not a ball of blobs. Two
    // silhouettes is what turns a stand of trees into a wood.
    if (e.def.conifer) {
      const r = pw * 0.4;
      for (let tier = 0; tier < 3; tier++) {
        const t = tier / 3;
        const ty2 = ty + r * 0.5 - tier * r * 0.42;
        const width = r * (1 - t * 0.42);
        ctx.fillStyle = tier === 2 ? lit : dark;
        ctx.beginPath();
        ctx.moveTo(tx, ty2 - r * 0.7);
        ctx.lineTo(tx + width, ty2 + r * 0.25);
        ctx.lineTo(tx - width, ty2 + r * 0.25);
        ctx.closePath();
        ctx.fill();
      }
      return;
    }

    // Canopy as overlapping blobs, browning as it burns down.
    const r = pw * 0.42;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + e.id;
      const ox = Math.cos(a) * r * 0.34;
      const oy = Math.sin(a) * r * 0.28;
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.arc(tx + ox, ty + oy, r * 0.62, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = lit;
    ctx.beginPath();
    ctx.arc(tx - r * 0.2, ty - r * 0.22, r * 0.5, 0, TAU);
    ctx.fill();
  }

  /* ---- the shapes the second wave of props is assembled from ---------- */

  /** Four splayed legs and a tank on top. The classic small-town skyline. */
  function drawWaterTower(e, px, py, pw, ph, dx, dy, hurt) {
    const bx = px + pw / 2;
    const by = py + ph / 2;
    const tx = bx + dx;
    const ty = by + dy;

    ctx.strokeStyle = '#39434f';
    ctx.lineWidth = 2.2;
    for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(bx + ox * pw * 0.3, by + oy * ph * 0.3);
      ctx.lineTo(tx + ox * pw * 0.12, ty + ph * 0.1);
      ctx.stroke();
    }
    // Cross-bracing halfway up, which is what makes it read as a structure.
    ctx.strokeStyle = 'rgba(90, 104, 120, 0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(bx - pw * 0.3, by);
    ctx.lineTo(tx + pw * 0.12, ty + ph * 0.1);
    ctx.moveTo(bx + pw * 0.3, by);
    ctx.lineTo(tx - pw * 0.12, ty + ph * 0.1);
    ctx.stroke();

    const r = pw * 0.34;
    const body = ctx.createLinearGradient(tx - r, 0, tx + r, 0);
    body.addColorStop(0, '#2f3a46');
    body.addColorStop(0.42, '#4d5b6b');
    body.addColorStop(1, '#28313b');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(tx, ty, r, r * 0.78, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.ellipse(tx, ty - r * 0.28, r * 0.82, r * 0.34, 0, 0, TAU);
    ctx.fill();
    // A conical cap, so the silhouette is not a floating disc.
    ctx.fillStyle = '#3c4855';
    ctx.beginPath();
    ctx.moveTo(tx, ty - r * 1.05);
    ctx.lineTo(tx + r * 0.5, ty - r * 0.4);
    ctx.lineTo(tx - r * 0.5, ty - r * 0.4);
    ctx.closePath();
    ctx.fill();
    if (hurt < 0.6) {
      ctx.strokeStyle = 'rgba(20,26,34,0.7)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(tx - r * 0.5, ty - r * 0.2);
      ctx.lineTo(tx + r * 0.2, ty + r * 0.5);
      ctx.stroke();
    }
  }

  /** A lattice mast: the tallest thing on the map, and nearly free to draw. */
  function drawMast(e, px, py, pw, ph, dx, dy, hurt) {
    const bx = px + pw / 2;
    const by = py + ph / 2;
    const tx = bx + dx;
    const ty = by + dy;

    // Guy wires first, so the lattice sits over them.
    ctx.strokeStyle = 'rgba(120, 134, 150, 0.22)';
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(bx + side * pw * 0.55, by + ph * 0.3);
      ctx.lineTo(tx + (tx - bx) * 0.1, ty + ph * 0.35);
      ctx.stroke();
    }

    // Two legs converging, rungs between them.
    const spread = pw * 0.26;
    const topSpread = spread * 0.3;
    ctx.strokeStyle = '#4a5665';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(bx - spread, by + 2);
    ctx.lineTo(tx - topSpread, ty);
    ctx.moveTo(bx + spread, by + 2);
    ctx.lineTo(tx + topSpread, ty);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(96, 112, 130, 0.65)';
    ctx.lineWidth = 1;
    const rungs = 7;
    for (let i = 1; i <= rungs; i++) {
      const t = i / (rungs + 1);
      const lx = bx - spread + (tx - topSpread - (bx - spread)) * t;
      const rx = bx + spread + (tx + topSpread - (bx + spread)) * t;
      const ry = by + 2 + (ty - by - 2) * t;
      ctx.beginPath();
      ctx.moveTo(lx, ry);
      ctx.lineTo(rx, ry);
      // Diagonal bracing on alternating bays.
      if (i % 2 === 0) {
        ctx.moveTo(lx, ry);
        ctx.lineTo(rx, ry - (ty - by) / (rungs + 1));
      }
      ctx.stroke();
    }

    // The red light. Slow, out of phase per mast, and only while it lives.
    if (hurt > 0.35 && ((frameClock + e.id * 7) >> 4) % 5 === 0) {
      glow(() => {
        ctx.fillStyle = 'rgba(255, 86, 78, 0.95)';
        ctx.beginPath();
        ctx.arc(tx, ty - 1, 2.4, 0, TAU);
        ctx.fill();
      });
    }
  }

  /** A hoarding on two posts, lit from below. */
  function drawBillboard(e, px, py, pw, ph, dx, dy, hurt) {
    const rx = px + dx;
    const ry = py + dy;

    ctx.strokeStyle = '#333c47';
    ctx.lineWidth = 2.4;
    for (const fx of [px + pw * 0.24, px + pw * 0.76]) {
      ctx.beginPath();
      ctx.moveTo(fx, py + ph - 2);
      ctx.lineTo(fx + dx, ry + ph * 0.7);
      ctx.stroke();
    }

    ctx.fillStyle = '#4a4033';
    ctx.fillRect(rx, ry, pw, ph * 0.72);
    // A washed-out poster: two bands and a block of colour, no text — text at
    // this size is noise, and the shape alone reads as advertising.
    const tone = hash2(e.id, e.cx) > 0.5 ? 'rgba(196, 122, 74, ' : 'rgba(94, 136, 168, ';
    ctx.fillStyle = tone + (hurt > 0.5 ? '0.55)' : '0.28)');
    ctx.fillRect(rx + 2, ry + 2, pw - 4, ph * 0.34);
    ctx.fillStyle = 'rgba(228, 224, 214, 0.16)';
    ctx.fillRect(rx + 2, ry + ph * 0.42, pw * 0.55, ph * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + 0.5, ry + 0.5, pw - 1, ph * 0.72);

    if (hurt > 0.4) {
      glow(() => {
        ctx.fillStyle = 'rgba(255, 226, 170, 0.10)';
        ctx.fillRect(rx, ry + ph * 0.72, pw, 3);
      });
    }
  }

  /** A grain silo: a tall cylinder with a domed cap and a hazard band. */
  function drawSilo(e, px, py, pw, ph, dx, dy, hurt) {
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    const r = pw * 0.34;
    const ty = cy + dy;

    ctx.fillStyle = '#232c36';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 3, r, r * 0.4, 0, 0, TAU);
    ctx.fill();

    const body = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
    body.addColorStop(0, '#333c46');
    body.addColorStop(0.38, '#5a6675');
    body.addColorStop(1, '#2a323b');
    ctx.fillStyle = body;
    ctx.fillRect(cx - r, ty, r * 2, cy + 3 - ty);

    // Corrugation, which is most of what says "silo" rather than "tank".
    ctx.strokeStyle = 'rgba(0,0,0,0.16)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const yy = ty + ((cy + 3 - ty) * i) / 6;
      ctx.beginPath();
      ctx.moveTo(cx - r, yy);
      ctx.lineTo(cx + r, yy);
      ctx.stroke();
    }

    ctx.fillStyle = '#66727f';
    ctx.beginPath();
    ctx.ellipse(cx + dx * 0.35, ty, r, r * 0.42, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#4c5866';
    ctx.beginPath();
    ctx.moveTo(cx + dx * 0.35, ty - r * 0.72);
    ctx.lineTo(cx + dx * 0.35 + r * 0.78, ty + r * 0.1);
    ctx.lineTo(cx + dx * 0.35 - r * 0.78, ty + r * 0.1);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = hurt > 0.6 ? 'rgba(230, 178, 60, 0.55)' : 'rgba(230, 120, 50, 0.7)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - 3);
    ctx.lineTo(cx + r, cy - 3);
    ctx.stroke();
  }

  /** A propane depot: a bank of cylinders behind a wire fence. */
  function drawDepot(e, px, py, pw, ph, dx, dy, hurt) {
    ctx.fillStyle = 'rgba(24, 30, 38, 0.85)';
    ctx.fillRect(px + 1, py + 1, pw - 2, ph - 2);

    // The cylinders, lying down in two rows.
    const rows = 2;
    const per = 3;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < per; c++) {
        const bx = px + 4 + (c * (pw - 8)) / per;
        const by = py + 5 + (r * (ph - 10)) / rows;
        const w = (pw - 8) / per - 1.5;
        const h = (ph - 10) / rows - 1.5;
        const g = ctx.createLinearGradient(0, by, 0, by + h);
        g.addColorStop(0, '#6a7280');
        g.addColorStop(0.5, '#49525e');
        g.addColorStop(1, '#2c333c');
        ctx.fillStyle = g;
        ctx.fillRect(bx, by + dy * 0.25, w, h);
        ctx.fillStyle = 'rgba(228, 120, 48, 0.55)';
        ctx.fillRect(bx, by + dy * 0.25 + h * 0.35, w, 1.6);
      }
    }

    // Chain-link fence: verticals only, which at this scale reads as mesh.
    ctx.strokeStyle = 'rgba(150, 164, 180, 0.22)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
      const fx = px + (i * pw) / 6;
      ctx.beginPath();
      ctx.moveTo(fx, py);
      ctx.lineTo(fx + dx * 0.5, py + ph + dy * 0.5);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(180, 194, 210, 0.3)';
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // The hazard placard, which is the whole warning.
    const sx = px + pw * 0.5;
    const sy = py + ph * 0.5;
    ctx.fillStyle = hurt > 0.6 ? 'rgba(236, 176, 48, 0.9)' : 'rgba(236, 90, 48, 0.95)';
    ctx.beginPath();
    ctx.moveTo(sx, sy - 4);
    ctx.lineTo(sx + 4, sy);
    ctx.lineTo(sx, sy + 4);
    ctx.lineTo(sx - 4, sy);
    ctx.closePath();
    ctx.fill();
  }

  /** A wrecked bus, dead across the carriageway. */
  function drawVehicle(e, px, py, pw, ph, dx, dy, hurt) {
    const body = ctx.createLinearGradient(0, py, 0, py + ph);
    body.addColorStop(0, '#4a4a3e');
    body.addColorStop(0.55, '#3a3a31');
    body.addColorStop(1, '#23231d');
    ctx.fillStyle = body;
    ctx.fillRect(px + 1, py + ph * 0.16, pw - 2, ph * 0.68);

    // Roof, offset by the parallax so it reads as having height at all.
    ctx.fillStyle = '#565646';
    ctx.fillRect(px + 2 + dx * 0.5, py + ph * 0.2 + dy * 0.5, pw - 4, ph * 0.5);

    // Window strip down the side, blown out where it is badly hurt.
    for (let i = 0; i < 4; i++) {
      const wx = px + 3 + i * ((pw - 6) / 4);
      const broken = hash2(e.id + i, e.cx) > (hurt > 0.6 ? 0.75 : 0.3);
      ctx.fillStyle = broken ? 'rgba(8, 10, 14, 0.9)' : 'rgba(120, 150, 168, 0.35)';
      ctx.fillRect(wx + dx * 0.5, py + ph * 0.26 + dy * 0.5, (pw - 6) / 4 - 2, ph * 0.22);
    }

    ctx.fillStyle = '#15161a';
    for (const wx of [px + pw * 0.2, px + pw * 0.74]) {
      ctx.beginPath();
      ctx.ellipse(wx, py + ph * 0.84, pw * 0.09, ph * 0.13, 0, 0, TAU);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 1.5, py + ph * 0.16 + 0.5, pw - 3, ph * 0.68);
  }

  /** A dry fountain: a basin, a plinth, and no water in it. */
  function drawFountain(e, px, py, pw, ph, dx, dy) {
    const cx = px + pw / 2;
    const cy = py + ph / 2;

    ctx.fillStyle = '#39424e';
    ctx.beginPath();
    ctx.ellipse(cx, cy, pw * 0.46, ph * 0.38, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#242c36';
    ctx.beginPath();
    ctx.ellipse(cx, cy, pw * 0.38, ph * 0.3, 0, 0, TAU);
    ctx.fill();
    // Silt and leaves in the empty basin.
    ctx.fillStyle = 'rgba(60, 70, 58, 0.5)';
    ctx.beginPath();
    ctx.ellipse(cx - pw * 0.05, cy + ph * 0.04, pw * 0.24, ph * 0.16, 0, 0, TAU);
    ctx.fill();

    const tx = cx + dx * 0.5;
    const ty = cy + dy * 0.5;
    ctx.strokeStyle = '#5b6674';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.fillStyle = '#6b7684';
    ctx.beginPath();
    ctx.ellipse(tx, ty, pw * 0.16, ph * 0.11, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath();
    ctx.ellipse(tx - 1, ty - 1.5, pw * 0.1, ph * 0.06, 0, 0, TAU);
    ctx.fill();
  }

  /** A monument: plinth, figure, and a cold metal highlight. */
  function drawStatue(e, px, py, pw, ph, dx, dy) {
    const bx = px + pw / 2;
    const by = py + ph / 2;

    ctx.fillStyle = '#2a3340';
    ctx.fillRect(px + 3, py + ph * 0.45, pw - 6, ph * 0.5);
    ctx.fillStyle = '#38434f';
    ctx.fillRect(px + 4.5, py + ph * 0.45, pw - 9, 3);

    const tx = bx + dx;
    const ty = by + dy;
    ctx.strokeStyle = '#6d7c8c';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(bx, py + ph * 0.5);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.fillStyle = '#7d8c9c';
    ctx.beginPath();
    ctx.arc(tx, ty - 3, 4, 0, TAU);
    ctx.fill();
    // An outstretched arm, so the silhouette is a figure and not a post.
    ctx.strokeStyle = '#6d7c8c';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(tx, ty + 2);
    ctx.lineTo(tx + 9, ty - 5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(190, 210, 230, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx - 1.5, ty + 8);
    ctx.lineTo(tx - 1.5, ty - 4);
    ctx.stroke();
  }

  /* ------------------------------------------------- landmarks and below -- */

  /** The gateway record anchored to this landmark, if there is one. */
  function gatewayFor(e) {
    return (world.gateways || []).find((g) => g.landmark === e.defId) || null;
  }

  /**
   * The headquarters: a slab with setbacks, a lit crown and a service mast.
   *
   * Drawn deliberately taller and colder than anything else on the map. It is
   * the only thing on it worth crossing the map to destroy, and a landmark
   * that does not read as a landmark from the minimap is just a big house.
   */
  function drawHeadquarters(e, px, py, pw, ph, dx, dy, hurt) {
    const rx = px + dx;
    const ry = py + dy;

    // Walls, as quads from footprint corners to roof corners.
    const wall = ctx.createLinearGradient(px, py + ph, rx, ry);
    wall.addColorStop(0, '#141a22');
    wall.addColorStop(1, '#28323f');
    ctx.fillStyle = wall;
    ctx.beginPath();
    ctx.moveTo(px, py + ph);
    ctx.lineTo(px + pw, py + ph);
    ctx.lineTo(rx + pw, ry + ph);
    ctx.lineTo(rx, ry + ph);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(px + pw, py);
    ctx.lineTo(px + pw, py + ph);
    ctx.lineTo(rx + pw, ry + ph);
    ctx.lineTo(rx + pw, ry);
    ctx.closePath();
    ctx.fill();

    // Window bands, dimming as the building is worked over.
    const lit = Math.max(0.06, hurt * 0.5);
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      ctx.fillStyle = `rgba(150, 190, 230, ${lit * 0.5})`;
      ctx.fillRect(px + (rx - px) * t, py + ph + (ry - py) * t, pw, 2);
    }

    // Roof plate and its parapet.
    ctx.fillStyle = '#39465a';
    ctx.fillRect(rx, ry, pw, ph);
    ctx.fillStyle = '#4a5a70';
    ctx.fillRect(rx, ry, pw, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(rx + 4, ry + 4, pw - 8, ph - 8);

    // Mast and beacon: the bit you can see from anywhere on the map.
    ctx.strokeStyle = '#5c6b7d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rx + pw / 2, ry + ph / 2);
    ctx.lineTo(rx + pw / 2 + dx * 0.25, ry + ph / 2 - 16);
    ctx.stroke();
    const beat = 0.4 + 0.6 * Math.abs(Math.sin(frameClock * 0.06));
    glow(() => {
      ctx.fillStyle = `rgba(255, 90, 70, ${beat * 0.8})`;
      ctx.beginPath();
      ctx.arc(rx + pw / 2 + dx * 0.25, ry + ph / 2 - 16, 3, 0, TAU);
      ctx.fill();
    });
  }

  /**
   * The castle: curtain wall, four corner towers, and the great door.
   *
   * The door is drawn from the definition's own `door` offset — the same
   * number the gateway opens on — so the way in can never be drawn in a
   * different wall from the one you can walk through.
   */
  function drawCastle(e, px, py, pw, ph, dx, dy) {
    const rx = px + dx * 0.6;
    const ry = py + dy * 0.6;
    const cell = pw / e.size[0];

    // Curtain wall.
    const wall = ctx.createLinearGradient(px, py + ph, rx, ry);
    wall.addColorStop(0, '#1b1a18');
    wall.addColorStop(1, '#3b3833');
    ctx.fillStyle = wall;
    ctx.beginPath();
    ctx.moveTo(px, py + ph);
    ctx.lineTo(px + pw, py + ph);
    ctx.lineTo(rx + pw, ry + ph);
    ctx.lineTo(rx, ry + ph);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#46423b';
    ctx.fillRect(rx, ry, pw, ph);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(rx + cell, ry + cell, pw - cell * 2, ph - cell * 2);

    // Crenellations along the front parapet.
    ctx.fillStyle = '#565149';
    for (let i = 0; i < e.size[0] * 2; i++) {
      if (i % 2) continue;
      ctx.fillRect(rx + (i * pw) / (e.size[0] * 2), ry + ph - 4, pw / (e.size[0] * 2) - 1, 4);
    }

    // Corner towers, drawn last so they sit proud of the wall.
    for (const [ox, oy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const tx = rx + ox * (pw - cell * 1.4) + cell * 0.7;
      const ty = ry + oy * (ph - cell * 1.4) + cell * 0.7;
      ctx.fillStyle = '#4e493f';
      ctx.beginPath();
      ctx.arc(tx, ty, cell * 0.78, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#5e584c';
      ctx.beginPath();
      ctx.arc(tx - 1, ty - 1.5, cell * 0.6, 0, TAU);
      ctx.fill();
    }

    // The great door, in the wall the definition says it is in.
    const door = e.def.door || [Math.floor(e.size[0] / 2), e.size[1]];
    const gateway = gatewayFor(e);
    const open = gateway && gateway.open;
    const gx = px + door[0] * cell;
    const gy = py + Math.min(door[1], e.size[1]) * cell - cell * 0.9;

    ctx.fillStyle = '#221f1b';
    ctx.beginPath();
    ctx.moveTo(gx - cell * 0.1, gy + cell * 1.1);
    ctx.lineTo(gx - cell * 0.1, gy + cell * 0.3);
    ctx.arc(gx + cell * 0.9, gy + cell * 0.3, cell, Math.PI, 0);
    ctx.lineTo(gx + cell * 1.9, gy + cell * 1.1);
    ctx.closePath();
    ctx.fill();

    if (open) {
      // Light from the other side, which is the whole payoff of the fight.
      glow(() => {
        const spill = ctx.createLinearGradient(gx, gy, gx, gy + cell * 2.2);
        spill.addColorStop(0, 'rgba(255, 206, 140, 0.55)');
        spill.addColorStop(1, 'rgba(255, 176, 90, 0)');
        ctx.fillStyle = spill;
        ctx.fillRect(gx - cell * 0.1, gy + cell * 0.1, cell * 2, cell * 2.2);
      });
    } else {
      // Barred: two leaves, banded iron, and a very solid drop bar.
      ctx.fillStyle = '#3a2f24';
      ctx.fillRect(gx, gy + cell * 0.1, cell * 1.8, cell);
      ctx.strokeStyle = '#5a4b3a';
      ctx.lineWidth = 2;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(gx, gy + cell * 0.1 + (i * cell) / 3);
        ctx.lineTo(gx + cell * 1.8, gy + cell * 0.1 + (i * cell) / 3);
        ctx.stroke();
      }
      ctx.fillStyle = '#6b5a44';
      ctx.fillRect(gx + cell * 0.1, gy + cell * 0.5, cell * 1.6, 3);
    }
  }

  /** A rock column, floor to roof. Tapers, so it reads as load-bearing. */
  function drawPillar(e, px, py, pw, ph, dx, dy) {
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    const tx = cx + dx;
    const ty = cy + dy;

    const body = ctx.createLinearGradient(cx - pw * 0.4, 0, cx + pw * 0.4, 0);
    body.addColorStop(0, '#241f2b');
    body.addColorStop(0.45, '#3d3546');
    body.addColorStop(1, '#1d1924');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(cx - pw * 0.42, cy + ph * 0.28);
    ctx.lineTo(cx + pw * 0.42, cy + ph * 0.28);
    ctx.lineTo(tx + pw * 0.26, ty);
    ctx.lineTo(tx - pw * 0.26, ty);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4a4055';
    ctx.beginPath();
    ctx.ellipse(tx, ty, pw * 0.26, ph * 0.16, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - pw * 0.1, cy + ph * 0.26);
    ctx.lineTo(tx - pw * 0.06, ty + 2);
    ctx.stroke();
  }

  /** Firestone: a cluster of shards, lit from inside. */
  function drawCrystal(e, px, py, pw, ph, dx, dy, hurt) {
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    for (let i = 0; i < 3; i++) {
      const lean = (i - 1) * pw * 0.22;
      const tipX = cx + lean + dx * 0.7;
      const tipY = cy + dy * 0.7 + i * 2;
      ctx.fillStyle = i === 1 ? '#a45fd0' : '#7a44a0';
      ctx.beginPath();
      ctx.moveTo(cx + lean - pw * 0.14, cy + ph * 0.24);
      ctx.lineTo(cx + lean + pw * 0.14, cy + ph * 0.24);
      ctx.lineTo(tipX, tipY);
      ctx.closePath();
      ctx.fill();
    }
    // Under pressure, and the renderer says so before it goes off.
    const pulse = 0.45 + 0.55 * Math.abs(Math.sin(frameClock * 0.05 + e.id));
    glow(() => {
      ctx.fillStyle = `rgba(214, 130, 255, ${pulse * (hurt < 0.7 ? 0.5 : 0.28)})`;
      ctx.beginPath();
      ctx.arc(cx + dx * 0.5, cy + dy * 0.5, pw * 0.5, 0, TAU);
      ctx.fill();
    });
  }

  /** A rockfall: low, broken, and something to shoot over rather than through. */
  function drawRubble(e, px, py, pw, ph) {
    for (let i = 0; i < 5; i++) {
      const hx = hash2(e.id * 7 + i, e.cx) * (pw - 6);
      const hy = hash2(e.cy, e.id * 3 + i) * (ph - 4);
      const size = 4 + hash2(e.id + i, e.cx + e.cy) * 6;
      ctx.fillStyle = i % 2 ? '#3a3442' : '#2b2634';
      ctx.beginPath();
      ctx.moveTo(px + hx, py + hy + size);
      ctx.lineTo(px + hx + size * 0.6, py + hy);
      ctx.lineTo(px + hx + size, py + hy + size * 0.8);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** A brazier: bowl, legs, and a flame somebody lit this morning. */
  function drawBrazier(e, px, py, pw, ph, dx, dy) {
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    ctx.strokeStyle = '#3a332b';
    ctx.lineWidth = 2;
    for (const off of [-4, 0, 4]) {
      ctx.beginPath();
      ctx.moveTo(cx + off * 0.6, cy + ph * 0.3);
      ctx.lineTo(cx + off, cy + dy * 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = '#4b4238';
    ctx.beginPath();
    ctx.ellipse(cx + dx * 0.5, cy + dy * 0.5, pw * 0.32, ph * 0.2, 0, 0, TAU);
    ctx.fill();
    const flare = 0.6 + 0.4 * Math.abs(Math.sin(frameClock * 0.11 + e.id));
    glow(() => {
      ctx.fillStyle = `rgba(255, 176, 80, ${flare * 0.75})`;
      ctx.beginPath();
      ctx.ellipse(cx + dx * 0.5, cy + dy * 0.5 - 3, pw * 0.2, ph * 0.3 * flare, 0, 0, TAU);
      ctx.fill();
    });
  }

  /* ---------------------------------------------------------- gateways -- */

  /**
   * The ways off the map.
   *
   * Drawn after the scenery and before the units, for the same reason props
   * are: a machine standing in a doorway has to be visible in it. A gateway is
   * always animated — a hole with light coming out of it reads as a thing to
   * walk into, and a static one reads as a decal.
   */
  function drawGateways() {
    for (const e of world.entities.values()) {
      if (e.kind !== 'gateway' || e.dead) continue;
      if (!isExplored(world, viewerId, e.x, e.y)) continue;
      const s = { x: e.x * CELL, y: e.y * CELL };
      if (e.defId === 'gate') drawGateMarker(e, s);
      else drawShaftMarker(e, s);
      drawWayMarker(e, s);
    }
  }

  /** A shaft: a hole, a broken rim, and warm air coming up out of it. */
  function drawShaftMarker(e, s) {
    const r = e.radius * CELL;

    ctx.fillStyle = '#07060a';
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 0.82, r * 0.6, 0, 0, TAU);
    ctx.fill();

    // Broken slabs around the lip — this was a floor an hour ago.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + hash2(e.id, i) * 0.4;
      ctx.fillStyle = i % 2 ? '#2f2a37' : '#413a4b';
      ctx.beginPath();
      ctx.moveTo(s.x + Math.cos(a) * r * 0.8, s.y + Math.sin(a) * r * 0.58);
      ctx.lineTo(s.x + Math.cos(a + 0.4) * r * 1.05, s.y + Math.sin(a + 0.4) * r * 0.76);
      ctx.lineTo(s.x + Math.cos(a - 0.1) * r * 1.02, s.y + Math.sin(a - 0.1) * r * 0.74);
      ctx.closePath();
      ctx.fill();
    }

    glow(() => {
      const rise = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      rise.addColorStop(0, 'rgba(196, 128, 232, 0.30)');
      rise.addColorStop(1, 'rgba(196, 128, 232, 0)');
      ctx.fillStyle = rise;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, r, r * 0.75, 0, 0, TAU);
      ctx.fill();
    });
  }

  /** An open gate: an arch with the next world lit behind it. */
  function drawGateMarker(e, s) {
    const r = e.radius * CELL;
    ctx.fillStyle = '#0b0906';
    ctx.beginPath();
    ctx.moveTo(s.x - r * 0.6, s.y + r * 0.5);
    ctx.lineTo(s.x - r * 0.6, s.y - r * 0.1);
    ctx.arc(s.x, s.y - r * 0.1, r * 0.6, Math.PI, 0);
    ctx.lineTo(s.x + r * 0.6, s.y + r * 0.5);
    ctx.closePath();
    ctx.fill();

    glow(() => {
      const spill = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      spill.addColorStop(0, 'rgba(255, 206, 140, 0.40)');
      spill.addColorStop(1, 'rgba(255, 176, 90, 0)');
      ctx.fillStyle = spill;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, r, r * 0.8, 0, 0, TAU);
      ctx.fill();
    });
  }

  /**
   * The "walk in here" ring.
   *
   * Both gateway kinds get the same one, because it is answering the same
   * question — *this is the thing, put a machine on it* — and a player who
   * learned it under the headquarters should not have to learn it again at
   * the castle.
   */
  function drawWayMarker(e, s) {
    const r = e.radius * CELL;
    const pulse = (frameClock * 0.02) % 1;
    ctx.strokeStyle = `rgba(255, 233, 180, ${0.5 * (1 - pulse)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * (0.6 + pulse * 0.55), r * (0.45 + pulse * 0.42), 0, 0, TAU);
    ctx.stroke();

    // Two chevrons pointing in, drifting inward on the same clock.
    ctx.strokeStyle = 'rgba(255, 233, 180, 0.7)';
    ctx.lineWidth = 2;
    for (const dir of [-1, 1]) {
      const off = r * (1.25 - pulse * 0.35) * dir;
      ctx.beginPath();
      ctx.moveTo(s.x + off - 5 * dir, s.y - 6);
      ctx.lineTo(s.x + off, s.y);
      ctx.lineTo(s.x + off - 5 * dir, s.y + 6);
      ctx.stroke();
    }
  }

  /** Fuel: a canopy on posts, pumps beneath, hazard stripes. */
  function drawVolatile(e, px, py, pw, ph, dx, dy, hurt) {
    // Tanks are cylinders; stations have a forecourt canopy.
    if (e.defId === 'tank') {
      const cx = px + pw / 2;
      const cy = py + ph / 2;
      ctx.fillStyle = '#2b3540';
      ctx.beginPath();
      ctx.ellipse(cx, cy + 3, pw * 0.34, ph * 0.24, 0, 0, TAU);
      ctx.fill();
      const body = ctx.createLinearGradient(cx - pw * 0.34, 0, cx + pw * 0.34, 0);
      body.addColorStop(0, '#39434f');
      body.addColorStop(0.4, '#4a5765');
      body.addColorStop(1, '#2b333d');
      ctx.fillStyle = body;
      ctx.fillRect(cx - pw * 0.34, cy + dy, pw * 0.68, cy + 3 - (cy + dy));
      ctx.fillStyle = '#54626f';
      ctx.beginPath();
      ctx.ellipse(cx + dx * 0.4, cy + dy, pw * 0.34, ph * 0.22, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 170, 60, 0.6)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx - pw * 0.34, cy - 2);
      ctx.lineTo(cx + pw * 0.34, cy - 2);
      ctx.stroke();
      return;
    }

    // Pumps on the forecourt.
    ctx.fillStyle = '#2c3641';
    for (let i = 0; i < 2; i++) {
      ctx.fillRect(px + pw * (0.22 + i * 0.42), py + ph * 0.45, 5, 8);
    }
    // Canopy, floating on its posts.
    const rx = px + dx;
    const ry = py + dy;
    ctx.strokeStyle = '#39434f';
    ctx.lineWidth = 2.5;
    for (const fx of [px + 5, px + pw - 5]) {
      ctx.beginPath();
      ctx.moveTo(fx, py + ph - 3);
      ctx.lineTo(fx + dx, ry + ph - 3);
      ctx.stroke();
    }
    ctx.fillStyle = '#3d4956';
    ctx.fillRect(rx - 2, ry, pw + 4, ph * 0.62);
    ctx.fillStyle = hurt > 0.7 ? '#e05a3c' : '#8a3a2a';
    ctx.fillRect(rx - 2, ry, pw + 4, 3.5);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(rx - 2, ry + 3.5, pw + 4, 1.5);
    // Underside light, the classic forecourt glow.
    glow(() => {
      const g = ctx.createRadialGradient(rx + pw / 2, ry + ph * 0.7, 0, rx + pw / 2, ry + ph * 0.7, pw * 0.7);
      g.addColorStop(0, 'rgba(255, 230, 170, 0.25)');
      g.addColorStop(1, 'rgba(255, 210, 140, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(rx + pw / 2, ry + ph * 0.7, pw * 0.7, 0, TAU);
      ctx.fill();
    });
  }

  /* -------------------------------------------------------- buildings -- */

  function drawBuildings(selection) {
    for (const e of world.entities.values()) {
      if (e.kind !== 'building') continue;
      if (!seenBy(e)) continue;

      const px = e.cx * CELL;
      const py = e.cy * CELL;
      const pw = e.size[0] * CELL;
      const ph = e.size[1] * CELL;
      const color = colorOf(e);

      // Drop shadow first: structures sit *on* the ground.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(px + 4, py + 5, pw - 4, ph - 4);

      if (e.constructing) {
        drawConstruction(e, px, py, pw, ph, color);
      } else {
        drawStructureBody(e, px, py, pw, ph, color);
      }

      if (selection.has(e.id)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        strokeCorners(px - 1, py - 1, pw + 2, ph + 2, 8);
      }

      if (e.hp < e.maxHp) drawBar(px + 3, py - 7, pw - 6, 4, e.hp / e.maxHp, hpColor(e.hp / e.maxHp));

      // Heavy damage smokes — the C&C tell for "this is worth finishing off".
      if (!e.constructing && e.hp < e.maxHp * 0.45 && Math.random() < 0.2) {
        addParticle('smoke', px / CELL + (0.3 + Math.random() * 0.4) * e.size[0],
          py / CELL + (0.2 + Math.random() * 0.5) * e.size[1]);
      }

      // A dark structure is a real tactical fact; show it.
      if (e.def.needsPower && !e.powered && !e.constructing) {
        const flicker = Math.random() > 0.1 ? 0.85 : 0.3;
        ctx.fillStyle = `rgba(255, 105, 95, ${flicker})`;
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('⚡', px + pw / 2 - 6, py + ph / 2 + 4);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(px + 2, py + 2, pw - 4, ph - 4);
      }

      if (e.queue && e.queue.length > 0) {
        const item = e.queue[0];
        drawBar(px + 3, py + ph + 3, pw - 6, 3, 1 - item.remaining / item.total, '#4fb3ff');
      }

      // Being repaired: pulsing wrench-green outline plus welding sparks.
      if (e.repairing) {
        const pulse = 0.4 + 0.35 * Math.sin(frameClock * 0.12);
        ctx.strokeStyle = `rgba(87, 209, 106, ${pulse})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 1, py - 1, pw + 2, ph + 2);
        if (Math.random() < 0.25) {
          addParticle('weld', (px + Math.random() * pw) / CELL, (py + Math.random() * ph) / CELL);
        }
      }

      // Superweapon charge, on the structure itself. A defender who can see
      // the Lance can see how long they have.
      if (e.def.superweapon && !e.constructing) {
        const ready = superweaponReady(e);
        const t = Math.min(1, (e.charge || 0) / e.def.superweapon.charge);
        drawBar(px + 3, py + ph + 3, pw - 6, 4, t, ready ? '#ff5f5f' : '#ffb347');
        if (ready) {
          const pulse = 0.45 + 0.35 * Math.sin(frameClock * 0.1);
          ctx.strokeStyle = `rgba(255, 95, 95, ${pulse})`;
          ctx.lineWidth = 2;
          ctx.strokeRect(px - 2, py - 2, pw + 4, ph + 4);
        }
      }

      if (e.vet > 0) {
        ctx.fillStyle = e.vet >= 2 ? '#ffd166' : '#d8e2ec';
        for (let i = 0; i < e.vet; i++) ctx.fillRect(px + 4 + i * 5, py + 4, 3, 3);
      }
    }
  }

  /** The lit, extruded structure body with per-type detailing. */
  function drawStructureBody(e, px, py, pw, ph, color) {
    // Extrusion: a darker south face gives every structure height.
    ctx.fillStyle = '#0d1218';
    ctx.fillRect(px + 2, py + 4, pw - 4, ph - 4);

    // Roof plate, lit from the north-west.
    const roof = ctx.createLinearGradient(px, py, px + pw * 0.4, py + ph);
    roof.addColorStop(0, '#2e3947');
    roof.addColorStop(0.5, '#212b36');
    roof.addColorStop(1, '#19212a');
    ctx.fillStyle = roof;
    ctx.fillRect(px + 2, py + 2, pw - 4, ph - 7);

    // Panel seams.
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    for (let i = 1; i < e.size[0]; i++) {
      ctx.beginPath();
      ctx.moveTo(px + i * CELL + 0.5, py + 3);
      ctx.lineTo(px + i * CELL + 0.5, py + ph - 6);
      ctx.stroke();
    }

    // Faction trim along the roof edge — ownership at a glance.
    ctx.fillStyle = color;
    ctx.fillRect(px + 2, py + 2, pw - 4, 2.5);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(px + 2, py + 4.5, pw - 4, 1);

    drawBuildingDetail(e, px, py, pw, ph, color);
  }

  /** Construction: scaffolding, crane sweep, structure rising into place. */
  function drawConstruction(e, px, py, pw, ph, color) {
    const t = Math.min(1, e.buildProgress / e.buildTime);

    ctx.fillStyle = 'rgba(14, 18, 24, 0.9)';
    ctx.fillRect(px + 2, py + 2, pw - 4, ph - 4);

    // Diagonal scaffold hatch.
    ctx.save();
    ctx.beginPath();
    ctx.rect(px + 2, py + 2, pw - 4, ph - 4);
    ctx.clip();
    ctx.strokeStyle = 'rgba(150, 170, 190, 0.16)';
    ctx.lineWidth = 1;
    for (let i = -ph; i < pw + ph; i += 7) {
      ctx.beginPath();
      ctx.moveTo(px + i, py);
      ctx.lineTo(px + i + ph, py + ph);
      ctx.stroke();
    }
    ctx.restore();

    // The finished floors, rising from the bottom.
    const rise = (ph - 4) * t;
    ctx.fillStyle = '#1b232d';
    ctx.fillRect(px + 2, py + ph - 2 - rise, pw - 4, rise);
    ctx.fillStyle = `${color}44`;
    ctx.fillRect(px + 2, py + ph - 2 - rise, pw - 4, 2);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
    ctx.setLineDash([]);

    // Welding light where the new floor is going in.
    if (Math.random() < 0.35) {
      addParticle('weld', (px + 4 + Math.random() * (pw - 8)) / CELL, (py + ph - 3 - rise) / CELL);
    }
  }

  function drawBuildingDetail(e, px, py, pw, ph, color) {
    const cx = px + pw / 2;
    const cy = py + ph / 2 - 2;

    switch (e.defId) {
      case 'command': {
        // Landing pad ring plus the command spire, beacon blinking.
        ctx.strokeStyle = 'rgba(140, 160, 180, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy + 4, pw * 0.26, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = '#232e3a';
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy + 2);
        ctx.lineTo(cx, cy - 12);
        ctx.lineTo(cx + 9, cy + 2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if ((frameClock >> 4) % 3 === 0) {
          glow(() => {
            ctx.fillStyle = 'rgba(255, 120, 110, 0.9)';
            ctx.beginPath();
            ctx.arc(cx, cy - 12, 2, 0, TAU);
            ctx.fill();
          });
        }
        break;
      }
      case 'reactor': {
        // The core: a contained star. Its glow is the "this is the power
        // grid" tell, and it goes out when the structure is unpowered.
        ctx.fillStyle = '#101820';
        ctx.beginPath();
        ctx.arc(cx, cy, 9, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(140,160,180,0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const throb = 0.55 + 0.3 * Math.sin(frameClock * 0.08 + e.id);
        glow(() => {
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 12);
          g.addColorStop(0, `rgba(120, 220, 255, ${throb})`);
          g.addColorStop(1, 'rgba(120, 220, 255, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, cy, 12, 0, TAU);
          ctx.fill();
        });
        break;
      }
      case 'refinery': {
        // Intake bay and hopper — the truck-sized door reads "bring scrap".
        ctx.fillStyle = '#0e141b';
        ctx.fillRect(px + 5, cy - 3, pw * 0.32, ph * 0.34);
        ctx.strokeStyle = 'rgba(190, 214, 100, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px + 5, cy - 3, pw * 0.32, ph * 0.34);
        ctx.fillStyle = '#232e3a';
        ctx.beginPath();
        ctx.moveTo(cx + 4, cy - 8);
        ctx.lineTo(px + pw - 7, cy - 8);
        ctx.lineTo(px + pw - 11, cy + 6);
        ctx.lineTo(cx + 8, cy + 6);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = 'rgba(140,160,180,0.45)';
        ctx.stroke();
        break;
      }
      case 'turret': {
        // Hardened mount with a barrel that actually tracks its target.
        ctx.fillStyle = '#0f151c';
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(140,160,180,0.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(e.facing || 0);
        ctx.fillStyle = '#28323e';
        ctx.fillRect(-2, -2.5, 13, 5);
        ctx.fillStyle = color;
        ctx.fillRect(9, -1.5, 4, 3);
        ctx.restore();
        break;
      }
      case 'sensor': {
        // Rotating sweep, like every radar dome since 1995.
        const a = frameClock * 0.05;
        ctx.strokeStyle = 'rgba(140,160,180,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, TAU);
        ctx.stroke();
        glow(() => {
          const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * 10, cy + Math.sin(a) * 10);
          g.addColorStop(0, 'rgba(120, 220, 160, 0.0)');
          g.addColorStop(1, 'rgba(120, 220, 160, 0.8)');
          ctx.strokeStyle = g;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(a) * 10, cy + Math.sin(a) * 10);
          ctx.stroke();
        });
        break;
      }
      case 'lance': {
        // The Orbital Lance: an aperture that irises open as charge builds.
        const t = Math.min(1, (e.charge || 0) / e.def.superweapon.charge);
        ctx.fillStyle = '#0e141b';
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(140,160,180,0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU + t * 0.8;
          ctx.strokeStyle = 'rgba(200, 210, 220, 0.5)';
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * 11 * (1 - t * 0.7), cy + Math.sin(a) * 11 * (1 - t * 0.7));
          ctx.lineTo(cx + Math.cos(a) * 11, cy + Math.sin(a) * 11);
          ctx.stroke();
        }
        if (t > 0.05) {
          glow(() => {
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 10 * t);
            g.addColorStop(0, `rgba(255, 120, 100, ${0.5 + t * 0.4})`);
            g.addColorStop(1, 'rgba(255, 120, 100, 0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(cx, cy, 10 * t, 0, TAU);
            ctx.fill();
          });
        }
        break;
      }
      default: {
        // Generic tech structure: inset panel and service lights.
        ctx.fillStyle = '#151d26';
        ctx.fillRect(cx - 9, cy - 7, 18, 14);
        ctx.strokeStyle = 'rgba(140,160,180,0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx - 9, cy - 7, 18, 14);
        const on = (frameClock >> 3) % 4;
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = i === on ? color : 'rgba(120,140,160,0.35)';
          ctx.fillRect(cx - 6 + i * 5, cy + 9, 3, 2);
        }
      }
    }
  }

  /* ------------------------------------------------------------ units -- */

  function drawUnits(selection) {
    for (const e of world.entities.values()) {
      if (e.kind !== 'unit') continue;
      if (!seenBy(e)) continue;

      // Interpolate between ticks so 20Hz simulation reads as smooth motion.
      const x = (e.x - e.vx * (1 - state.alpha)) * CELL;
      const y = (e.y - e.vy * (1 - state.alpha)) * CELL;
      const lift = e.leap ? (e.leapHeight || 0) * 14 : e.layer === 'air' ? 9 : 0;
      const r = e.radius * CELL;
      const color = colorOf(e);
      const moving = Math.abs(e.vx) + Math.abs(e.vy) > 0.001;

      // Ground shadow. Airborne machines cast theirs further away — the only
      // cue that they are above the battlefield rather than on it.
      ctx.fillStyle = lift > 0 ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(x + 2, y + lift * 0.9 + 3, r * 0.85, r * 0.4, 0, 0, TAU);
      ctx.fill();

      ctx.save();
      ctx.translate(x, y - lift);

      if (selection.has(e.id)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, r + 4, 0, TAU);
        ctx.stroke();
      }

      // Shield bubble: faint while holding, bright shimmer while regenerating.
      if (e.maxShield > 0 && e.shield > 0) {
        const f = e.shield / e.maxShield;
        ctx.strokeStyle = `rgba(95, 208, 255, ${0.12 + f * 0.2})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, r + 3, 0, TAU);
        ctx.stroke();
      }

      ctx.rotate(e.facing);
      drawChassis(e, r, color, moving);
      ctx.restore();

      // Engine flame for airborne machines, in the glow pass.
      if (e.layer === 'air' || e.leap) {
        const a = e.facing;
        const fx = x - Math.cos(a) * r * 1.1;
        const fy = y - lift - Math.sin(a) * r * 1.1;
        const flicker = 0.5 + Math.random() * 0.4;
        glow(() => {
          const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, 5);
          g.addColorStop(0, `rgba(255, 190, 120, ${flicker})`);
          g.addColorStop(1, 'rgba(255, 120, 60, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(fx, fy, 5, 0, TAU);
          ctx.fill();
        });
      }

      // Hurt machines trail smoke; badly hurt ones trail fire.
      const hpF = e.hp / e.maxHp;
      if (hpF < 0.5 && Math.random() < 0.18) addParticle('smoke', e.x, e.y - lift / CELL);
      if (hpF < 0.25 && Math.random() < 0.12) addParticle('flame', e.x, e.y - lift / CELL);

      drawUnitStatus(e, x, y - lift, r);
    }
  }

  /** Silhouette by role, so a unit's job is readable at a glance. */
  function drawChassis(e, r, color, moving) {
    // Walk cycle: ground mechs sway as they move; the amount is tiny but the
    // eye reads "machine walking" instead of "icon sliding".
    const stride = moving && e.layer !== 'air' ? Math.sin(frameClock * 0.4 + e.id * 2.1) : 0;
    ctx.rotate(stride * 0.05);

    // Two-facet hull: dark base, faction-tinted upper facet, hot outline.
    const base = '#10151d';
    const facet = shade(color, -0.45);

    ctx.lineWidth = 1.4;
    ctx.strokeStyle = color;

    const role = e.def.role;
    const path = () => {
      ctx.beginPath();
      if (role === 'economy') {
        ctx.rect(-r, -r * 0.8, r * 2, r * 1.6);
      } else if (role === 'air') {
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.6, r);
        ctx.lineTo(-r * 0.2, 0);
        ctx.lineTo(-r * 0.6, -r);
        ctx.closePath();
      } else if (role === 'siege') {
        ctx.rect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8);
      } else if (role === 'scout') {
        ctx.moveTo(r, 0);
        ctx.lineTo(-r * 0.7, r * 0.75);
        ctx.lineTo(-r * 0.7, -r * 0.75);
        ctx.closePath();
      } else {
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * TAU;
          const px = Math.cos(a) * r;
          const py = Math.sin(a) * r * 0.85;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
    };

    path();
    ctx.fillStyle = base;
    ctx.fill();
    ctx.stroke();

    // Upper facet: the same shape, squeezed and offset toward the light.
    ctx.save();
    ctx.scale(0.62, 0.62);
    ctx.translate(-r * 0.12, -r * 0.18);
    path();
    ctx.fillStyle = facet;
    ctx.fill();
    ctx.restore();

    // Collector cargo: the hold visibly fills with scrap.
    if (e.harvest && e.cargo > 0) {
      const f = Math.min(1, e.cargo / e.def.capacity);
      ctx.fillStyle = 'rgba(190, 214, 100, 0.8)';
      ctx.fillRect(-r * 0.7, -r * 0.5, r * 1.4 * f, r);
    }

    // Cockpit light — gold for a named pilot, so the crew reads on the field.
    ctx.fillStyle = e.pilotId ? '#ffd166' : '#9fd8ff';
    ctx.beginPath();
    ctx.arc(r * 0.35, 0, Math.max(1.5, r * 0.16), 0, TAU);
    ctx.fill();

    // Hardpoints, drawn as barrels with a lit muzzle tip.
    const count = e.def.hardpoints.length;
    for (let i = 0; i < count; i++) {
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * r * 0.8;
      ctx.strokeStyle = '#3a4756';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(r * 0.3, offset);
      ctx.lineTo(r * 1.35, offset);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r * 1.05, offset);
      ctx.lineTo(r * 1.35, offset);
      ctx.stroke();
    }

    // A deployed siege unit gets visible outriggers — the state matters enough
    // to be readable without selecting the unit.
    if (e.deployed) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-r, -r * 1.3);
      ctx.lineTo(-r, r * 1.3);
      ctx.moveTo(r * 0.4, -r * 1.3);
      ctx.lineTo(r * 0.4, r * 1.3);
      ctx.stroke();
    }
  }

  function drawUnitStatus(e, x, y, r) {
    const hurt = e.hp < e.maxHp;
    const shieldDown = e.maxShield > 0 && e.shield < e.maxShield;
    if (hurt || shieldDown) {
      const w = r * 2.4;
      if (e.maxShield > 0) {
        drawBar(x - w / 2, y - r - 12, w, 3, e.shield / e.maxShield, '#5fd0ff');
      }
      drawBar(x - w / 2, y - r - 8, w, 3, e.hp / e.maxHp, hpColor(e.hp / e.maxHp));
    }

    if (e.tempShield > 0) {
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, TAU);
      ctx.stroke();
    }

    if (e.disabledUntil > world.tick) {
      // EMP: arcs crawling over the hull beat a text label.
      for (let i = 0; i < 2; i++) {
        const a0 = Math.random() * TAU;
        const a1 = a0 + 0.6 + Math.random();
        glow(() => {
          ctx.strokeStyle = 'rgba(150, 225, 255, 0.8)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(x, y, r + 2, a0, a1);
          ctx.stroke();
        });
      }
    }

    // Cargo readout, so a full collector heading the wrong way is obvious.
    if (e.harvest && e.cargo > 0) {
      drawBar(x - r, y + r + 3, r * 2, 3, e.cargo / e.def.capacity, '#bed664');
    }

    drawChevrons(e, x, y, r);
  }

  /**
   * Rank chevrons, the way every Command & Conquer game has drawn them. This
   * is the only cue that one Kestrel in a group of five is worth retreating,
   * so it has to be visible without selecting the unit.
   */
  function drawChevrons(e, x, y, r) {
    const rank = e.vet || 0;
    if (rank <= 0) return;

    ctx.strokeStyle = rank >= 2 ? '#ffd166' : '#d8e2ec';
    ctx.lineWidth = 1.6;
    const top = y - r - (e.maxShield > 0 ? 16 : 12);
    for (let i = 0; i < rank; i++) {
      const cy = top - i * 3.4;
      ctx.beginPath();
      ctx.moveTo(x - 4, cy + 2.4);
      ctx.lineTo(x, cy);
      ctx.lineTo(x + 4, cy + 2.4);
      ctx.stroke();
    }
  }

  /* ------------------------------------------------------ projectiles -- */

  function drawProjectiles() {
    for (const p of world.projectiles) {
      if (!isVisible(world, viewerId, p.x, p.y)) continue;
      const x = p.x * CELL;
      const y = p.y * CELL;
      const angle = Math.atan2(p.ty - p.y, p.tx - p.x);

      if (p.kind === 'rocket') {
        // Rocket: dark body, flame, smoke trail.
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = '#2e3946';
        ctx.fillRect(-5, -1.5, 8, 3);
        ctx.restore();
        glow(() => {
          const g = ctx.createRadialGradient(
            x - Math.cos(angle) * 6, y - Math.sin(angle) * 6, 0,
            x - Math.cos(angle) * 6, y - Math.sin(angle) * 6, 5);
          g.addColorStop(0, 'rgba(255, 200, 130, 0.9)');
          g.addColorStop(1, 'rgba(255, 120, 60, 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x - Math.cos(angle) * 6, y - Math.sin(angle) * 6, 5, 0, TAU);
          ctx.fill();
        });
        if (Math.random() < 0.6) addParticle('trail', p.x - Math.cos(angle) * 0.3, p.y - Math.sin(angle) * 0.3);
      } else if (p.kind === 'shell') {
        // Shell: hot tracer with a comet tail.
        glow(() => {
          const g = ctx.createLinearGradient(
            x - Math.cos(angle) * 14, y - Math.sin(angle) * 14, x, y);
          g.addColorStop(0, 'rgba(255, 170, 70, 0)');
          g.addColorStop(1, 'rgba(255, 210, 130, 0.95)');
          ctx.strokeStyle = g;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(angle) * 14, y - Math.sin(angle) * 14);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255, 235, 180, 1)';
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, TAU);
          ctx.fill();
        });
      } else {
        // Kinetic round: a short bright streak.
        glow(() => {
          ctx.strokeStyle = 'rgba(255, 233, 168, 0.95)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(x - Math.cos(angle) * 7, y - Math.sin(angle) * 7);
          ctx.lineTo(x, y);
          ctx.stroke();
        });
      }
    }
  }

  /* ---------------------------------------------------------- effects -- */

  function drawEffects() {
    for (const fx of world.effects) {
      if (fx.type === 'beam') {
        if (!isVisible(world, viewerId, fx.x1, fx.y1) && !isVisible(world, viewerId, fx.x2, fx.y2)) {
          continue;
        }
        const x1 = fx.x1 * CELL;
        const y1 = fx.y1 * CELL;
        const x2 = fx.x2 * CELL;
        const y2 = fx.y2 * CELL;
        const emp = fx.damageType === 'emp';
        // Beams get a wide soft glow under a white-hot core — the RA3 look.
        glow(() => {
          ctx.strokeStyle = emp ? 'rgba(120, 200, 255, 0.35)' : 'rgba(255, 90, 70, 0.35)';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.strokeStyle = emp ? 'rgba(220, 245, 255, 0.95)' : 'rgba(255, 230, 220, 0.95)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        });
      } else if (fx.type === 'empBurst') {
        glow(() => {
          ctx.strokeStyle = 'rgba(150,220,255,0.6)';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(fx.x * CELL, fx.y * CELL, fx.radius * CELL, 0, TAU);
          ctx.stroke();
        });
      } else if (fx.type === 'healField') {
        ctx.strokeStyle = 'rgba(120,230,150,0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.arc(fx.x * CELL, fx.y * CELL, fx.radius * CELL, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  /* -------------------------------------------------------- particles -- */

  /**
   * One particle system, two passes: matter (smoke, debris) draws normally,
   * light (fire, sparks, flashes, rings) draws additively. Types:
   * spark, smoke, flame, fire (fireball), flash, ring, debris, trail, weld,
   * dust.
   */
  function addParticle(type, x, y, opts = {}) {
    if (state.sparks.length > 900) return; // hard cap: never melt the frame
    const p = {
      type,
      x,
      y,
      vx: 0,
      vy: 0,
      ttl: 20,
      maxTtl: 20,
      size: 3,
      ...opts,
    };
    if (type === 'spark') {
      const a = Math.random() * TAU;
      const v = 0.04 + Math.random() * 0.1;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v;
      p.ttl = p.maxTtl = 10 + Math.random() * 14;
    } else if (type === 'smoke') {
      p.vx = (Math.random() - 0.5) * 0.015;
      p.vy = -0.02 - Math.random() * 0.02;
      p.ttl = p.maxTtl = 30 + Math.random() * 30;
      p.size = 4 + Math.random() * 5;
    } else if (type === 'flame') {
      p.vx = (Math.random() - 0.5) * 0.01;
      p.vy = -0.015;
      p.ttl = p.maxTtl = 10 + Math.random() * 10;
      p.size = 3 + Math.random() * 3;
    } else if (type === 'fire') {
      const a = Math.random() * TAU;
      const v = Math.random() * (opts.speed || 0.06);
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v - 0.01;
      p.ttl = p.maxTtl = 14 + Math.random() * 12;
      p.size = opts.size || 5 + Math.random() * 6;
    } else if (type === 'flash') {
      p.ttl = p.maxTtl = 5;
    } else if (type === 'ring') {
      p.ttl = p.maxTtl = opts.ttl || 16;
    } else if (type === 'debris') {
      const a = Math.random() * TAU;
      const v = 0.05 + Math.random() * (opts.speed || 0.12);
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v - 0.08;
      p.ttl = p.maxTtl = 20 + Math.random() * 16;
      p.size = opts.size || 2 + Math.random() * 3;
      // Tumbling debris reads as mass; a sliding square reads as a sprite.
      p.spin = (Math.random() - 0.5) * 0.4;
      p.angle = Math.random() * TAU;
    } else if (type === 'ember') {
      // Slow-rising sparks that outlive the fireball — what makes a big
      // explosion feel like it left something burning.
      p.vx = (Math.random() - 0.5) * 0.03;
      p.vy = -0.01 - Math.random() * 0.02;
      p.ttl = p.maxTtl = 40 + Math.random() * 50;
      p.size = 1.5 + Math.random() * 1.5;
    } else if (type === 'groundfire') {
      p.ttl = p.maxTtl = opts.ttl || 120;
      p.size = opts.size || 6;
    } else if (type === 'trail') {
      p.ttl = p.maxTtl = 12 + Math.random() * 8;
      p.size = 2.5;
    } else if (type === 'weld') {
      p.ttl = p.maxTtl = 4 + Math.random() * 4;
    } else if (type === 'dust') {
      const a = Math.random() * TAU;
      p.vx = Math.cos(a) * 0.05;
      p.vy = Math.sin(a) * 0.05;
      p.ttl = p.maxTtl = 14 + Math.random() * 8;
      p.size = 3 + Math.random() * 3;
    }
    state.sparks.push(p);
  }

  function stepSparks() {
    for (const p of state.sparks) {
      p.x += p.vx;
      p.y += p.vy;
      if (p.type === 'debris') {
        p.vy += 0.008; // gravity
        p.angle += p.spin;
      }
      if (p.type === 'smoke') p.size *= 1.02;
      p.ttl--;
    }
    state.sparks = state.sparks.filter((s) => s.ttl > 0);
  }

  function drawParticles(lightPass) {
    for (const p of state.sparks) {
      const life = p.ttl / p.maxTtl;
      const x = p.x * CELL;
      const y = p.y * CELL;

      if (!lightPass) {
        if (p.type === 'smoke') {
          ctx.fillStyle = `rgba(40, 44, 50, ${life * 0.4})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, TAU);
          ctx.fill();
        } else if (p.type === 'debris') {
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.angle || 0);
          ctx.fillStyle = `rgba(30, 34, 40, ${life})`;
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.8);
          ctx.restore();
        } else if (p.type === 'dust') {
          ctx.fillStyle = `rgba(120, 118, 108, ${life * 0.3})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, TAU);
          ctx.fill();
        }
        continue;
      }

      if (p.type === 'spark') {
        if (p.tint) {
          // Warhead-coloured. Hot in the middle of its life, fading to the
          // warhead's own colour as it cools.
          const [r, g, b] = p.tint;
          ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${life})`;
        } else {
          ctx.fillStyle = `rgba(255, ${150 + Math.round(life * 80)}, 90, ${life})`;
        }
        const s = p.size * (0.4 + life);
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      } else if (p.type === 'flame' || p.type === 'fire') {
        const g = ctx.createRadialGradient(x, y, 0, x, y, p.size * (0.5 + life * 0.7));
        g.addColorStop(0, `rgba(255, 230, 170, ${life * 0.95})`);
        g.addColorStop(0.4, `rgba(255, 140, 60, ${life * 0.7})`);
        g.addColorStop(1, 'rgba(200, 60, 30, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, p.size * (0.5 + life * 0.7), 0, TAU);
        ctx.fill();
      } else if (p.type === 'flash') {
        const r = (p.size || 8) * (1.6 - life);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255, 250, 230, ${life})`);
        g.addColorStop(1, 'rgba(255, 200, 120, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      } else if (p.type === 'ring') {
        const r = (p.size || 1.5) * CELL * (1 - life);
        ctx.strokeStyle = `rgba(255, 210, 160, ${life * 0.8})`;
        ctx.lineWidth = 2.5 * life + 0.5;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.stroke();
      } else if (p.type === 'ember') {
        const heat = life * life;
        ctx.fillStyle = `rgba(255, ${120 + Math.round(heat * 110)}, ${Math.round(heat * 90)}, ${life})`;
        ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
      } else if (p.type === 'groundfire') {
        // A licking flame that stays put, for fuel that is still burning.
        const flick = 0.75 + 0.25 * Math.sin(frameClock * 0.4 + x);
        const r = p.size * (0.6 + life * 0.5) * flick;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255, 235, 190, ${life * 0.8})`);
        g.addColorStop(0.35, `rgba(255, 150, 60, ${life * 0.6})`);
        g.addColorStop(1, 'rgba(180, 50, 20, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      } else if (p.type === 'trail') {
        ctx.fillStyle = `rgba(200, 200, 205, ${life * 0.35})`;
        ctx.beginPath();
        ctx.arc(x, y, p.size * (1.4 - life), 0, TAU);
        ctx.fill();
      } else if (p.type === 'weld') {
        ctx.fillStyle = `rgba(190, 235, 255, ${life})`;
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
  }

  /* ----------------------------------------------- previews & overlays -- */

  /** The superweapon aiming reticle, while a strike is being targeted. */
  function drawStrikePreview() {
    const aim = state.strikeAim;
    if (!aim) return;
    const w = screenToWorld(state.hoverPixel.x, state.hoverPixel.y);
    const x = w.x * CELL;
    const y = w.y * CELL;
    const r = aim.radius * CELL;

    ctx.strokeStyle = 'rgba(255, 95, 95, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255, 95, 95, 0.1)';
    ctx.fill();

    // Crosshair sweep.
    const a = frameClock * 0.06;
    ctx.strokeStyle = 'rgba(255, 140, 140, 0.7)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const b = a + i * Math.PI;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(b) * r * 0.4, y + Math.sin(b) * r * 0.4);
      ctx.lineTo(x + Math.cos(b) * r, y + Math.sin(b) * r);
      ctx.stroke();
    }
  }

  /**
   * Reach ring for a targeted ability being aimed.
   *
   * Skyfall crosses half the map, which is far enough that "click roughly
   * over there" stops being good enough — the player needs to see whether the
   * far ridge is actually in range before committing a fifteen-second
   * cooldown. Drawn from the unit outward rather than at the cursor, because
   * the question is how far *this machine* can go.
   */
  function drawAbilityPreview(selection) {
    const aim = state.abilityAim;
    if (!aim || !aim.radius) return;

    for (const id of selection) {
      const e = world.entities.get(id);
      if (!e || e.dead) continue;
      const x = e.x * CELL;
      const y = e.y * CELL;
      const r = aim.radius * CELL;

      ctx.strokeStyle = 'rgba(140, 220, 255, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);

      // The landing point, snapped the way the engine will snap it.
      const w = screenToWorld(state.hoverPixel.x, state.hoverPixel.y);
      const dx = w.x - e.x;
      const dy = w.y - e.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const reach = Math.min(d, aim.radius);
      const tx = (e.x + (dx / d) * reach) * CELL;
      const ty = (e.y + (dy / d) * reach) * CELL;

      ctx.strokeStyle = 'rgba(180, 235, 255, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tx, ty, 9, 0, TAU);
      ctx.moveTo(tx - 14, ty);
      ctx.lineTo(tx + 14, ty);
      ctx.moveTo(tx, ty - 14);
      ctx.lineTo(tx, ty + 14);
      ctx.stroke();
      break; // one ring is enough; a group all leaps to the same point
    }
  }

  function drawPlacementPreview() {
    const p = state.placement;
    if (!p) return;
    const def = BUILDINGS[p.defId];
    const px = p.cx * CELL;
    const py = p.cy * CELL;
    const pw = def.size[0] * CELL;
    const ph = def.size[1] * CELL;

    ctx.globalAlpha = 0.4;
    ctx.fillStyle = p.legal ? '#4fd07a' : '#ff5f5f';
    ctx.fillRect(px, py, pw, ph);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.legal ? '#8effb0' : '#ff9a9a';
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, pw, ph);
    // Cell ticks inside the footprint, so size reads against the grid.
    ctx.strokeStyle = p.legal ? 'rgba(142,255,176,0.3)' : 'rgba(255,154,154,0.3)';
    ctx.lineWidth = 1;
    for (let i = 1; i < def.size[0]; i++) {
      ctx.beginPath();
      ctx.moveTo(px + i * CELL + 0.5, py);
      ctx.lineTo(px + i * CELL + 0.5, py + ph);
      ctx.stroke();
    }
    for (let i = 1; i < def.size[1]; i++) {
      ctx.beginPath();
      ctx.moveTo(px, py + i * CELL + 0.5);
      ctx.lineTo(px + pw, py + i * CELL + 0.5);
      ctx.stroke();
    }
  }

  /**
   * Fog, drawn as a full-screen overlay from the per-cell bitmap. Unexplored
   * is opaque; explored-but-unseen is a heavy dim that still shows terrain.
   */
  function drawFog() {
    const { visible, explored } = world.players[viewerId].vision;
    const data = fogImage.data;

    for (let i = 0; i < visible.length; i++) {
      const o = i * 4;
      // A cool tint rather than neutral black: remembered ground should read
      // as *remembered*, not just dark, so the edge of what you can currently
      // see is obvious without having to compare brightness.
      data[o] = 5;
      data[o + 1] = 8;
      data[o + 2] = 16;
      data[o + 3] = visible[i] ? 0 : explored[i] ? 165 : 255;
    }
    fogCtx.putImageData(fogImage, 0, 0);

    const s = scale();
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      fogLayer,
      -camera.x * s,
      -camera.y * s,
      world.map.width * s,
      world.map.height * s
    );
    ctx.restore();
  }

  /** Cached vignette, rebuilt when the viewport changes size. */
  let vignette = null;
  let vignetteKey = '';
  function drawVignette(w, h) {
    const key = `${w}x${h}`;
    if (key !== vignetteKey) {
      vignetteKey = key;
      vignette = ctx.createRadialGradient(
        w / 2, h / 2, Math.min(w, h) * 0.45,
        w / 2, h / 2, Math.max(w, h) * 0.75
      );
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.2)');
    }
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  function drawSelectionBox() {
    const box = state.selectionBox;
    if (!box) return;
    ctx.strokeStyle = 'rgba(140, 230, 255, 0.9)';
    ctx.fillStyle = 'rgba(140, 230, 255, 0.1)';
    ctx.lineWidth = 1;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  /** Corner brackets — selection that does not fight the artwork. */
  function strokeCorners(x, y, w, h, len) {
    ctx.beginPath();
    ctx.moveTo(x, y + len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.moveTo(x + w - len, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + len);
    ctx.moveTo(x + w, y + h - len);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - len, y + h);
    ctx.moveTo(x + len, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - len);
    ctx.stroke();
  }

  /* ----------------------------------------------------------- minimap -- */

  function drawMinimap(minimapCanvas) {
    const mctx = minimapCanvas.getContext('2d');
    const size = minimapCanvas.width;
    const k = size / world.map.width;

    mctx.fillStyle = '#05070b';
    mctx.fillRect(0, 0, size, size);

    const { explored, visible } = world.players[viewerId].vision;
    for (let y = 0; y < world.map.height; y++) {
      for (let x = 0; x < world.map.width; x++) {
        const i = y * world.map.width + x;
        if (!explored[i]) continue;
        const dim = visible[i] ? 1 : 0.55;
        if (world.map.resource[i] > 0) {
          mctx.fillStyle = `rgba(190,214,100,${dim})`;
        } else {
          mctx.fillStyle = biomeOf(world.map).palette.minimap[world.map.terrain[i]];
          mctx.globalAlpha = dim;
        }
        mctx.fillRect(x * k, y * k, Math.ceil(k), Math.ceil(k));
        mctx.globalAlpha = 1;
      }
    }

    for (const e of world.entities.values()) {
      if (!seenBy(e)) continue;
      mctx.fillStyle = colorOf(e);
      const s =
        e.kind === 'building' || e.kind === 'gateway'
          ? Math.max(3, (e.size ? e.size[0] : 2) * k)
          : Math.max(2, k * 1.4);
      mctx.fillRect(e.x * k - s / 2, e.y * k - s / 2, s, s);
    }

    // Camera rectangle.
    const s = scale();
    mctx.strokeStyle = 'rgba(255,255,255,0.75)';
    mctx.lineWidth = 1;
    mctx.strokeRect(
      camera.x * k,
      camera.y * k,
      (viewWidth() / s) * k,
      (viewHeight() / s) * k
    );
  }

  /* ------------------------------------------------------------ helpers -- */

  /** Can the viewing player see this entity at all? */
  function seenBy(e) {
    if (e.player === viewerId) return true;
    if (e.kind === 'building' || e.kind === 'gateway') {
      // Structures stay drawn once discovered, the way every RTS does it —
      // buildings do not walk away while you are not looking. A gateway is
      // the same promise and a stronger one: the whole reason it is on the
      // minimap is so a player who found it can find it again.
      return isExplored(world, viewerId, e.x, e.y);
    }
    return isVisible(world, viewerId, e.x, e.y);
  }

  /** Warm gold: the way out is not owned by either side, and reads as neither. */
  const GATEWAY_TINT = '#ffd27a';

  function colorOf(e) {
    if (e.kind === 'gateway') return GATEWAY_TINT;
    const player = world.players[e.player];
    if (!player) return NEUTRAL;
    return player.id === viewerId ? FACTIONS[player.faction].color : enemyColor(player);
  }

  function enemyColor(player) {
    return FACTIONS[player.faction].color;
  }

  function drawBar(x, y, w, h, fraction, color) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w * Math.max(0, Math.min(1, fraction)), h);
  }

  function hpColor(fraction) {
    if (fraction > 0.6) return '#57d16a';
    if (fraction > 0.3) return '#e8c34a';
    return '#e8544a';
  }

  /** Mix a hex colour toward black (amt<0) or white (amt>0). */
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const t = amt < 0 ? 0 : 255;
    const a = Math.abs(amt);
    const r = Math.round(((n >> 16) & 255) * (1 - a) + t * a);
    const g = Math.round(((n >> 8) & 255) * (1 - a) + t * a);
    const b = Math.round((n & 255) * (1 - a) + t * a);
    return `rgb(${r},${g},${b})`;
  }

  /**
   * One explosion, at a scale.
   *
   * Everything that blows up goes through here so a big blast is visibly the
   * same event as a small one rather than a different effect: a white core
   * that dies fast, a fireball that expands and cools, a shockwave ring, an
   * outward spray of tumbling debris, smoke that rises and keeps rising, and
   * embers that outlive all of it. Plus a kick to the camera, scaled — which
   * is most of what separates "a sprite played" from "something detonated".
   */
  function fireball(x, y, radius, scale) {
    addParticle('flash', x, y, { size: 8 + scale * 22 });
    addParticle('ring', x, y, { size: radius, ttl: Math.round(12 + scale * 14) });
    if (scale > 0.6) addParticle('ring', x, y, { size: radius * 1.6, ttl: Math.round(18 + scale * 16) });

    const fire = Math.round(5 + scale * 16);
    for (let i = 0; i < fire; i++) {
      addParticle('fire', x, y, { speed: 0.04 + scale * 0.11, size: 4 + scale * 7 });
    }
    for (let i = 0; i < Math.round(3 + scale * 11); i++) addParticle('smoke', x, y);
    for (let i = 0; i < Math.round(4 + scale * 10); i++) {
      addParticle('debris', x, y, { speed: 0.08 + scale * 0.14 });
    }
    for (let i = 0; i < Math.round(scale * 14); i++) addParticle('ember', x, y);

    stampScorch(x, y, Math.max(0.8, radius * 0.85));

    // Shake falls off with distance from the camera centre, so a blast across
    // the map is felt faintly and one under your feet is not.
    const s = worldToScreen(x, y);
    const dx = s.x - viewWidth() / 2;
    const dy = s.y - viewHeight() / 2;
    const away = Math.sqrt(dx * dx + dy * dy) / Math.max(1, viewWidth());
    addShake(scale * 11 * Math.max(0, 1 - away));
  }

  /**
   * Stamp a scorch mark + crater into the persistent decal layer.
   *
   * In decal-layer pixels, not world pixels — the layer is baked at
   * DECAL_CELL and scaled up at draw time.
   */
  function stampScorch(x, y, radius) {
    const px = x * DECAL_CELL;
    const py = y * DECAL_CELL;
    const r = Math.max(6 * (DECAL_CELL / CELL), radius * DECAL_CELL * 0.7);
    const g = decalCtx.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(8, 8, 10, 0.75)');
    g.addColorStop(0.6, 'rgba(10, 10, 12, 0.4)');
    g.addColorStop(1, 'rgba(10, 10, 12, 0)');
    decalCtx.fillStyle = g;
    decalCtx.beginPath();
    decalCtx.arc(px, py, r, 0, TAU);
    decalCtx.fill();
    // Rim highlight on the crater's lit side.
    decalCtx.strokeStyle = 'rgba(180, 180, 170, 0.10)';
    decalCtx.lineWidth = 1.5 * (DECAL_CELL / CELL);
    decalCtx.beginPath();
    decalCtx.arc(px, py, r * 0.45, Math.PI * 0.9, Math.PI * 1.7);
    decalCtx.stroke();
  }

  /** Turn simulation events into pictures. Renderer-only. */
  function consumeEvents(events) {
    for (const ev of events) {
      switch (ev.type) {
        case 'fire': {
          // Muzzle flash at the shooter, pointed at the target.
          const a = Math.atan2(ev.ty - ev.y, ev.tx - ev.x);
          addParticle('flash', ev.x + Math.cos(a) * 0.5, ev.y + Math.sin(a) * 0.5, { size: 5 });
          break;
        }
        case 'impact': {
          // The warhead rides along on the event, so an arrival looks like
          // what arrived: kinetic throws hot orange, energy throws cyan, EMP
          // throws pale blue and throws more of it because it is the only
          // warhead whose whole point is that you can see it did something.
          const tint = IMPACT_TINTS[ev.damageType] || null;
          addParticle('flash', ev.x, ev.y, { size: 4 });
          const count = ev.damageType === 'emp' ? 7 : 4;
          for (let i = 0; i < count; i++) addParticle('spark', ev.x, ev.y, { tint });
          break;
        }
        case 'explosion': {
          const big = !!ev.big;
          fireball(ev.x, ev.y, big ? (ev.radius || 3) : 1.2, big ? 1 : 0.45);
          break;
        }
        case 'death': {
          const building = ev.kind === 'building';
          const prop = ev.kind === 'prop';
          // A prop's own scale comes from its footprint, so a tower block
          // collapses like a tower block and a fence post does not.
          const scale = building ? 0.9 : prop ? Math.min(1.1, 0.4 + (ev.height || 1) * 0.22) : 0.4;
          fireball(ev.x, ev.y, 1 + scale * 2, scale);

          if (prop && ev.volatile) {
            // Fuel keeps burning after the blast — the lingering fire is what
            // makes a wrecked forecourt somewhere you still do not want to be.
            for (let i = 0; i < 5; i++) {
              addParticle('groundfire', ev.x + (Math.random() - 0.5) * 2.2, ev.y + (Math.random() - 0.5) * 1.6, {
                ttl: 100 + Math.random() * 100,
                size: 5 + Math.random() * 5,
              });
            }
          }
          if (prop && (ev.height || 0) > 2) {
            // A tall building throws its rubble outward as it comes down.
            for (let i = 0; i < 14; i++) {
              addParticle('debris', ev.x, ev.y, { speed: 0.2, size: 3 + Math.random() * 4 });
            }
          }
          break;
        }
        case 'leapStart':
          for (let i = 0; i < 6; i++) addParticle('dust', ev.x, ev.y);
          break;
        case 'leapEnd':
          for (let i = 0; i < 8; i++) addParticle('dust', ev.x, ev.y);
          addParticle('ring', ev.x, ev.y, { size: 0.9, ttl: 10 });
          break;
        default:
          break;
      }
    }
  }

  return {
    state,
    camera,
    resize,
    draw,
    drawMinimap,
    worldToScreen,
    screenToWorld,
    centreOn,
    clampCamera,
    zoomAt,
    stepSparks,
    consumeEvents,
    seenBy,
    colorOf,
    viewWidth,
    viewHeight,
    scale,

    /**
     * Offscreen pixel budget, in megabytes. There is no way to ask a browser
     * how much canvas memory it has handed out, so the renderer accounts for
     * its own — which is what lets a test assert the doubled map still fits
     * in a phone's budget rather than finding out on a phone.
     */
    bufferMegabytes() {
      const px =
        terrain.base.width * terrain.base.height +
        terrain.residentChunks() * (CHUNK * CELL) ** 2 +
        decalLayer.width * decalLayer.height +
        fogLayer.width * fogLayer.height;
      return (px * 4) / (1024 * 1024);
    },
    residentChunks: () => terrain.residentChunks(),
  };
}

/* ------------------------------------------------------------- terrain -- */

/**
 * Terrain bake, with actual ground in it.
 *
 * Multi-octave value noise modulates every cell's tone so the map reads as
 * weathered terrain rather than a grid; rough ground gets rubble, cliffs get
 * faceted rock with a lit north edge, water gets depth banding. All of it is
 * hashed from *map* coordinates — so the same cell paints identically whether
 * it is being baked into the low-detail base or into a full-detail chunk, and
 * the two levels line up instead of shimmering against each other.
 *
 * Paints cells `[cx0, cx1) × [cy0, cy1)` at `cell` px each, into a context
 * whose origin is the top-left of that range. Neighbour lookups still read the
 * whole map, so features that depend on what is next door — cliff edges,
 * shorelines, contact shadows — come out identical at a chunk boundary.
 */
function paintTerrainRegion(ctx, map, cell, cx0, cy0, cx1, cy1) {
  const originX = cx0 * cell;
  const originY = cy0 * cell;
  // Which world this is. Only the base tones change — the noise, the speckle
  // and the cliff facets below are the same rock everywhere, which is what
  // keeps the underworld looking like this game rather than a different one.
  const pal = biomeOf(map).palette;

  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const t = map.terrain[y * map.width + x];
      const px = x * cell - originX;
      const py = y * cell - originY;

      if (t === 3) {
        paintWater(ctx, map, cell, x, y, px, py, pal);
        continue;
      }
      if (t === 2) {
        paintCliff(ctx, map, cell, x, y, px, py, pal);
        continue;
      }
      if (t === 4) {
        paintRoad(ctx, map, cell, x, y, px, py, pal);
        continue;
      }

      // Ground and rough share a dirt palette; noise does the blending.
      // The large octave dominates: broad weathered patches, not per-cell
      // static — that was tried, and it read as blotches.
      const n = valueNoise(x, y, 0.07) * 0.8 + valueNoise(x, y, 0.31) * 0.2;
      const rough = t === 1;
      const dim = rough ? 5 : 0;
      const r = Math.round(pal.ground[0] + n * 18 - dim);
      const g = Math.round(pal.ground[1] + n * 17 - dim);
      const b = Math.round(pal.ground[2] + n * 13 - dim);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px, py, cell, cell);

      // Everything below is per-cell detail measured in pixels. It is scaled
      // by `k` so the base bake reads as the same ground rather than as the
      // same ground covered in boulders.
      const k = cell / CELL;

      // Speckle: stones and surface litter, denser on rough ground.
      const specks = rough ? 5 : 2;
      for (let i = 0; i < specks; i++) {
        const hx = hash2(x * 53 + i, y * 29);
        const hy = hash2(x * 19, y * 61 + i);
        const bright = hash2(x + i * 7, y + i * 3) > 0.5;
        ctx.fillStyle = bright
          ? `rgba(255,255,255,${rough ? 0.04 : 0.025})`
          : 'rgba(0,0,0,0.10)';
        const sz = (rough ? 2 + hash2(x + i, y) * 3 : 1.5) * k;
        ctx.fillRect(px + hx * (cell - 3 * k), py + hy * (cell - 3 * k), sz, sz);
      }

      // Rough ground: broken hatch marks, the classic "slow going" texture.
      if (rough) {
        ctx.strokeStyle = 'rgba(0,0,0,0.13)';
        ctx.lineWidth = k;
        const a = hash2(x, y) * TAU;
        ctx.beginPath();
        ctx.moveTo(px + cell / 2 - Math.cos(a) * 5 * k, py + cell / 2 - Math.sin(a) * 5 * k);
        ctx.lineTo(px + cell / 2 + Math.cos(a) * 5 * k, py + cell / 2 + Math.sin(a) * 5 * k);
        ctx.stroke();
      }

      // The faintest grid, kept because structure placement reads against it.
      // Only at full detail: at base resolution a one-pixel line on an
      // eight-pixel cell is a lattice, not a hint.
      if (cell === CELL) {
        ctx.strokeStyle = 'rgba(255,255,255,0.016)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, cell, cell);
      }
    }
  }

  // Contact shadows: passable cells next to cliffs sit in their shade.
  // A second pass over the same range, because a cell's shadow depends on a
  // neighbour that may not have been painted yet in the first.
  const k = cell / CELL;
  const reach = 8 * k;
  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const t = map.terrain[y * map.width + x];
      if (!TERRAIN_INFO[t].passable) continue;
      const px = x * cell - originX;
      const py = y * cell - originY;
      const cliffLeft = x > 0 && map.terrain[y * map.width + x - 1] === 2;
      const cliffUp = y > 0 && map.terrain[(y - 1) * map.width + x] === 2;
      if (cliffLeft) {
        const g = ctx.createLinearGradient(px, 0, px + reach, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.28)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(px, py, reach, cell);
      }
      if (cliffUp) {
        const g = ctx.createLinearGradient(0, py, 0, py + reach);
        g.addColorStop(0, 'rgba(0,0,0,0.28)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(px, py, cell, reach);
      }
    }
  }
}

function paintCliff(ctx, map, cell, x, y, px, py, pal) {
  const k = cell / CELL;
  const n = valueNoise(x, y, 0.12);
  const lift = n * 9;
  ctx.fillStyle = `rgb(${Math.round(pal.cliff[0] + lift)},${Math.round(
    pal.cliff[1] + lift
  )},${Math.round(pal.cliff[2] + lift)})`;
  ctx.fillRect(px, py, cell, cell);

  // Rock facets: angular shards, lit from the north-west.
  for (let i = 0; i < 3; i++) {
    const hx = hash2(x * 71 + i, y * 37) * cell;
    const hy = hash2(x * 23, y * 83 + i) * cell;
    const sz = (4 + hash2(x + i, y * 3) * 8) * k;
    const lit = hash2(x * 3 + i, y * 5) > 0.55;
    ctx.fillStyle = lit ? 'rgba(130, 145, 160, 0.18)' : 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.moveTo(px + hx, py + hy);
    ctx.lineTo(px + Math.min(cell, hx + sz), py + hy + sz * 0.4);
    ctx.lineTo(px + hx + sz * 0.3, py + Math.min(cell, hy + sz));
    ctx.closePath();
    ctx.fill();
  }

  // Lit top edge where open ground sits above — height at a glance.
  const above = y > 0 ? map.terrain[(y - 1) * map.width + x] : 2;
  if (TERRAIN_INFO[above].passable) {
    ctx.fillStyle = pal.lit;
    ctx.fillRect(px, py, cell, 2.5 * k);
  }
  const below = y < map.height - 1 ? map.terrain[(y + 1) * map.width + x] : 2;
  if (TERRAIN_INFO[below].passable) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(px, py + cell - 2 * k, cell, 2 * k);
  }
}

/**
 * Tarmac.
 *
 * Roads are the fastest ground in the game, so they have to *read* as the
 * fastest ground from across the map — which means a colour and a direction,
 * not just a different noise seed. The centre line is what supplies the
 * direction: it runs along the road, so a junction is legible as a junction
 * and a player can see where the network goes without following it.
 *
 * The kerb is drawn on edges that face away from other road cells, which is
 * what stops a two-lane road looking like two one-lane roads.
 */
function paintRoad(ctx, map, cell, x, y, px, py, pal) {
  const k = cell / CELL;
  const isRoad = (dx, dy) => {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) return false;
    return map.terrain[ny * map.width + nx] === 4;
  };

  const n = valueNoise(x, y, 0.09);
  const lift = n * 8;
  ctx.fillStyle = `rgb(${Math.round(pal.road[0] + lift)},${Math.round(
    pal.road[1] + lift
  )},${Math.round(pal.road[2] + lift)})`;
  ctx.fillRect(px, py, cell, cell);

  // Patches and repairs — a uniform slab reads as a placeholder.
  for (let i = 0; i < 2; i++) {
    if (hash2(x * 31 + i, y * 17) < 0.72) continue;
    const hx = hash2(x * 13 + i, y * 7) * cell * 0.6;
    const hy = hash2(x * 5, y * 23 + i) * cell * 0.6;
    ctx.fillStyle = hash2(x + i, y) > 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.028)';
    ctx.fillRect(px + hx, py + hy, cell * 0.34, cell * 0.3);
  }

  const horizontal = isRoad(-1, 0) || isRoad(1, 0);
  const vertical = isRoad(0, -1) || isRoad(0, 1);

  // Kerbs on the outward-facing edges only.
  ctx.fillStyle = 'rgba(150, 160, 172, 0.13)';
  if (!isRoad(0, -1)) ctx.fillRect(px, py, cell, 1.5 * k);
  if (!isRoad(0, 1)) ctx.fillRect(px, py + cell - 1.5 * k, cell, 1.5 * k);
  if (!isRoad(-1, 0)) ctx.fillRect(px, py, 1.5 * k, cell);
  if (!isRoad(1, 0)) ctx.fillRect(px + cell - 1.5 * k, py, 1.5 * k, cell);

  // Centre dashes, only on a straight run — a junction has no centre line.
  if (horizontal !== vertical && hash2(x * 3, y * 3) > 0.32) {
    ctx.fillStyle = pal.dash;
    if (horizontal) ctx.fillRect(px + cell * 0.2, py + cell / 2 - k, cell * 0.6, 2 * k);
    else ctx.fillRect(px + cell / 2 - k, py + cell * 0.2, 2 * k, cell * 0.6);
  }
}

function paintWater(ctx, map, cell, x, y, px, py, pal) {
  // Depth: darker away from shore, banded like a survey chart.
  let shore = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (map.terrain[ny * map.width + nx] !== 3) shore = 1;
    }
  }
  const n = valueNoise(x, y, 0.06);
  const r = Math.round(pal.water[0] + n * 4 + shore * 3);
  const g = Math.round(pal.water[1] + n * 5 + shore * 5);
  const b = Math.round(pal.water[2] + n * 6 + shore * 6);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(px, py, cell, cell);

  // Sparse still-water highlights.
  if (hash2(x * 5, y * 9) > 0.86) {
    const k = cell / CELL;
    ctx.strokeStyle = pal.glint;
    ctx.lineWidth = k;
    ctx.beginPath();
    ctx.moveTo(px + 3 * k, py + cell * hash2(x, y));
    ctx.lineTo(px + cell - 3 * k, py + cell * hash2(x, y));
    ctx.stroke();
  }
}

export { UNITS, BUILDINGS };
