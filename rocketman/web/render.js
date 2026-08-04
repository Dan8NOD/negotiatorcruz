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

import { CELL, TERRAIN_INFO, FACTIONS, UNITS, BUILDINGS } from '../engine/content.js';
import { superweaponReady } from '../engine/economy.js';
import { isVisible, isExplored } from '../engine/vision.js';

const NEUTRAL = '#8b98a6';
const TAU = Math.PI * 2;

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

export function createRenderer(canvas, world, viewerId) {
  const ctx = canvas.getContext('2d', { alpha: false });

  const camera = { x: 0, y: 0, zoom: 1, minZoom: 0.45, maxZoom: 2.4 };

  // Terrain never changes, so it is painted once into an offscreen buffer and
  // blitted. Repainting 5000 cells every frame is the single easiest way to
  // make a grid game stutter.
  const terrainLayer = document.createElement('canvas');
  terrainLayer.width = world.map.width * CELL;
  terrainLayer.height = world.map.height * CELL;
  paintTerrain(terrainLayer.getContext('2d'), world);

  // Battle scars. Explosions and deaths stamp scorch marks and craters here,
  // so a fought-over ridge *stays* fought-over — the map remembers.
  const decalLayer = document.createElement('canvas');
  decalLayer.width = world.map.width * CELL;
  decalLayer.height = world.map.height * CELL;
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

    const s = scale();
    ctx.save();
    ctx.translate(-camera.x * s, -camera.y * s);
    ctx.scale(camera.zoom, camera.zoom);

    ctx.drawImage(terrainLayer, 0, 0);
    ctx.drawImage(decalLayer, 0, 0);

    drawResources();
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
      const v = 0.05 + Math.random() * 0.12;
      p.vx = Math.cos(a) * v;
      p.vy = Math.sin(a) * v - 0.08;
      p.ttl = p.maxTtl = 20 + Math.random() * 16;
      p.size = 2 + Math.random() * 3;
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
      if (p.type === 'debris') p.vy += 0.008; // gravity
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
          ctx.fillStyle = `rgba(30, 34, 40, ${life})`;
          ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size * 0.8);
        } else if (p.type === 'dust') {
          ctx.fillStyle = `rgba(120, 118, 108, ${life * 0.3})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, TAU);
          ctx.fill();
        }
        continue;
      }

      if (p.type === 'spark') {
        ctx.fillStyle = `rgba(255, ${150 + Math.round(life * 80)}, 90, ${life})`;
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
          const info = TERRAIN_INFO[world.map.terrain[i]];
          mctx.fillStyle = info.color;
          mctx.globalAlpha = dim;
        }
        mctx.fillRect(x * k, y * k, Math.ceil(k), Math.ceil(k));
        mctx.globalAlpha = 1;
      }
    }

    for (const e of world.entities.values()) {
      if (!seenBy(e)) continue;
      mctx.fillStyle = colorOf(e);
      const s = e.kind === 'building' ? Math.max(3, e.size[0] * k) : Math.max(2, k * 1.4);
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
    if (e.kind === 'building') {
      // Structures stay drawn once discovered, the way every RTS does it —
      // buildings do not walk away while you are not looking.
      return isExplored(world, viewerId, e.x, e.y);
    }
    return isVisible(world, viewerId, e.x, e.y);
  }

  function colorOf(e) {
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

  /** Stamp a scorch mark + crater into the persistent decal layer. */
  function stampScorch(x, y, radius) {
    const px = x * CELL;
    const py = y * CELL;
    const r = Math.max(6, radius * CELL * 0.7);
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
    decalCtx.lineWidth = 1.5;
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
        case 'impact':
          addParticle('flash', ev.x, ev.y, { size: 4 });
          for (let i = 0; i < 4; i++) addParticle('spark', ev.x, ev.y);
          break;
        case 'explosion': {
          const big = !!ev.big;
          addParticle('flash', ev.x, ev.y, { size: big ? 22 : 10 });
          addParticle('ring', ev.x, ev.y, { size: big ? (ev.radius || 3) : 1.2, ttl: big ? 22 : 14 });
          const fire = big ? 14 : 6;
          for (let i = 0; i < fire; i++) {
            addParticle('fire', ev.x, ev.y, { speed: big ? 0.12 : 0.06, size: big ? 8 : 5 });
          }
          const smoke = big ? 10 : 4;
          for (let i = 0; i < smoke; i++) addParticle('smoke', ev.x, ev.y);
          for (let i = 0; i < (big ? 10 : 5); i++) addParticle('debris', ev.x, ev.y);
          stampScorch(ev.x, ev.y, ev.radius || (big ? 2.5 : 1));
          break;
        }
        case 'death': {
          const building = ev.kind === 'building';
          addParticle('flash', ev.x, ev.y, { size: building ? 18 : 9 });
          for (let i = 0; i < (building ? 12 : 7); i++) {
            addParticle('fire', ev.x, ev.y, { speed: 0.09, size: building ? 7 : 5 });
          }
          for (let i = 0; i < (building ? 12 : 6); i++) addParticle('smoke', ev.x, ev.y);
          for (let i = 0; i < (building ? 12 : 8); i++) addParticle('debris', ev.x, ev.y);
          stampScorch(ev.x, ev.y, building ? 2 : 0.9);
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
  };
}

/* ------------------------------------------------------------- terrain -- */

/**
 * One-time terrain bake, with actual ground in it.
 *
 * Multi-octave value noise modulates every cell's tone so the map reads as
 * weathered terrain rather than a grid; rough ground gets rubble, cliffs get
 * faceted rock with a lit north edge, water gets depth banding. All of it is
 * hashed from coordinates — stable across frames, and baked exactly once.
 */
function paintTerrain(ctx, world) {
  const { map } = world;

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const t = map.terrain[y * map.width + x];
      const px = x * CELL;
      const py = y * CELL;

      if (t === 3) {
        paintWater(ctx, map, x, y, px, py);
        continue;
      }
      if (t === 2) {
        paintCliff(ctx, map, x, y, px, py);
        continue;
      }

      // Ground and rough share a dirt palette; noise does the blending.
      // The large octave dominates: broad weathered patches, not per-cell
      // static — that was tried, and it read as blotches.
      const n = valueNoise(x, y, 0.07) * 0.8 + valueNoise(x, y, 0.31) * 0.2;
      const rough = t === 1;
      const base = 40 + n * 13 - (rough ? 5 : 0);
      const r = Math.round(base + n * 5);
      const g = Math.round(base + 6 + n * 4);
      const b = Math.round(base + 13);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px, py, CELL, CELL);

      // Speckle: stones and surface litter, denser on rough ground.
      const specks = rough ? 5 : 2;
      for (let i = 0; i < specks; i++) {
        const hx = hash2(x * 53 + i, y * 29);
        const hy = hash2(x * 19, y * 61 + i);
        const bright = hash2(x + i * 7, y + i * 3) > 0.5;
        ctx.fillStyle = bright
          ? `rgba(255,255,255,${rough ? 0.04 : 0.025})`
          : 'rgba(0,0,0,0.10)';
        const sz = rough ? 2 + hash2(x + i, y) * 3 : 1.5;
        ctx.fillRect(px + hx * (CELL - 3), py + hy * (CELL - 3), sz, sz);
      }

      // Rough ground: broken hatch marks, the classic "slow going" texture.
      if (rough) {
        ctx.strokeStyle = 'rgba(0,0,0,0.13)';
        ctx.lineWidth = 1;
        const a = hash2(x, y) * TAU;
        ctx.beginPath();
        ctx.moveTo(px + CELL / 2 - Math.cos(a) * 5, py + CELL / 2 - Math.sin(a) * 5);
        ctx.lineTo(px + CELL / 2 + Math.cos(a) * 5, py + CELL / 2 + Math.sin(a) * 5);
        ctx.stroke();
      }

      // The faintest grid, kept because structure placement reads against it.
      ctx.strokeStyle = 'rgba(255,255,255,0.016)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL, CELL);
    }
  }

  // Contact shadows: passable cells next to cliffs sit in their shade.
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const t = map.terrain[y * map.width + x];
      if (!TERRAIN_INFO[t].passable) continue;
      const cliffLeft = x > 0 && map.terrain[y * map.width + x - 1] === 2;
      const cliffUp = y > 0 && map.terrain[(y - 1) * map.width + x] === 2;
      if (cliffLeft) {
        const g = ctx.createLinearGradient(x * CELL, 0, x * CELL + 8, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.28)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x * CELL, y * CELL, 8, CELL);
      }
      if (cliffUp) {
        const g = ctx.createLinearGradient(0, y * CELL, 0, y * CELL + 8);
        g.addColorStop(0, 'rgba(0,0,0,0.28)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x * CELL, y * CELL, CELL, 8);
      }
    }
  }
}

function paintCliff(ctx, map, x, y, px, py) {
  const n = valueNoise(x, y, 0.12);
  const base = 24 + n * 9;
  ctx.fillStyle = `rgb(${Math.round(base)},${Math.round(base + 4)},${Math.round(base + 9)})`;
  ctx.fillRect(px, py, CELL, CELL);

  // Rock facets: angular shards, lit from the north-west.
  for (let i = 0; i < 3; i++) {
    const hx = hash2(x * 71 + i, y * 37) * CELL;
    const hy = hash2(x * 23, y * 83 + i) * CELL;
    const sz = 4 + hash2(x + i, y * 3) * 8;
    const lit = hash2(x * 3 + i, y * 5) > 0.55;
    ctx.fillStyle = lit ? 'rgba(130, 145, 160, 0.18)' : 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.moveTo(px + hx, py + hy);
    ctx.lineTo(px + Math.min(CELL, hx + sz), py + hy + sz * 0.4);
    ctx.lineTo(px + hx + sz * 0.3, py + Math.min(CELL, hy + sz));
    ctx.closePath();
    ctx.fill();
  }

  // Lit top edge where open ground sits above — height at a glance.
  const above = y > 0 ? map.terrain[(y - 1) * map.width + x] : 2;
  if (TERRAIN_INFO[above].passable) {
    ctx.fillStyle = 'rgba(160, 175, 190, 0.22)';
    ctx.fillRect(px, py, CELL, 2.5);
  }
  const below = y < map.height - 1 ? map.terrain[(y + 1) * map.width + x] : 2;
  if (TERRAIN_INFO[below].passable) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(px, py + CELL - 2, CELL, 2);
  }
}

function paintWater(ctx, map, x, y, px, py) {
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
  const r = Math.round(16 + n * 4 + shore * 3);
  const g = Math.round(40 + n * 5 + shore * 5);
  const b = Math.round(58 + n * 6 + shore * 6);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(px, py, CELL, CELL);

  // Sparse still-water highlights.
  if (hash2(x * 5, y * 9) > 0.86) {
    ctx.strokeStyle = 'rgba(140, 190, 220, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 3, py + CELL * hash2(x, y));
    ctx.lineTo(px + CELL - 3, py + CELL * hash2(x, y));
    ctx.stroke();
  }
}

export { UNITS, BUILDINGS };
