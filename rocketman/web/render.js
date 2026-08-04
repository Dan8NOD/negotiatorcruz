/**
 * Canvas renderer.
 *
 * Reads world state and draws it. It must never write to the simulation —
 * every player action goes back in as a command — so this file is free to use
 * Math.random for sparks, interpolate positions between ticks, and generally
 * lie for the sake of looking right.
 *
 * There is no art. Every chassis is drawn from its stats: a polygon whose
 * silhouette comes from the unit's role and radius, tinted by faction. That is
 * a deliberate stage-one choice — the game has to be *legible* before it is
 * pretty, and placeholder art that encodes real information beats placeholder
 * art that encodes none.
 */

import { CELL, TERRAIN_INFO, FACTIONS, UNITS, BUILDINGS } from '../engine/content.js';
import { superweaponReady } from '../engine/economy.js';
import { isVisible, isExplored } from '../engine/vision.js';

const NEUTRAL = '#8b98a6';

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
    /** Set by input.js while a structure is being sited. */
    placement: null,
    selectionBox: null,
    sparks: [],
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
    const w = viewWidth();
    const h = viewHeight();

    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(0, 0, w, h);

    const s = scale();
    ctx.save();
    ctx.translate(-camera.x * s, -camera.y * s);
    ctx.scale(camera.zoom, camera.zoom);

    // Terrain, clipped to what the camera can actually see.
    ctx.drawImage(terrainLayer, 0, 0);

    drawResources();
    drawBuildings(selection);
    drawPlacementPreview();
    drawStrikePreview();
    drawUnits(selection);
    drawProjectiles();
    drawEffects();

    ctx.restore();

    drawFog();
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

  function drawResources() {
    const { x0, y0, x1, y1 } = visibleBounds();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const amount = world.map.resource[y * world.map.width + x];
        if (amount <= 0) continue;
        if (!isExplored(world, viewerId, x, y)) continue;

        // Richness reads as density, so a worked-out patch is visibly thinning.
        const richness = Math.min(1, amount / 1800);
        ctx.fillStyle = `rgba(190, 214, 100, ${0.18 + richness * 0.5})`;
        ctx.fillRect(x * CELL + 2, y * CELL + 2, CELL - 4, CELL - 4);

        ctx.fillStyle = `rgba(230, 244, 160, ${0.25 + richness * 0.45})`;
        const n = 1 + Math.round(richness * 3);
        for (let i = 0; i < n; i++) {
          const px = x * CELL + 4 + ((i * 7 + x * 3 + y * 5) % (CELL - 8));
          const py = y * CELL + 4 + ((i * 11 + x * 5 + y * 3) % (CELL - 8));
          ctx.fillRect(px, py, 3, 3);
        }
      }
    }
  }

  function drawBuildings(selection) {
    for (const e of world.entities.values()) {
      if (e.kind !== 'building') continue;
      if (!seenBy(e)) continue;

      const px = e.cx * CELL;
      const py = e.cy * CELL;
      const pw = e.size[0] * CELL;
      const ph = e.size[1] * CELL;
      const color = colorOf(e);

      ctx.fillStyle = e.constructing ? 'rgba(24,30,38,0.9)' : '#1b232d';
      ctx.fillRect(px + 2, py + 2, pw - 4, ph - 4);

      ctx.strokeStyle = color;
      ctx.lineWidth = e.constructing ? 1 : 2;
      if (e.constructing) ctx.setLineDash([6, 4]);
      ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
      ctx.setLineDash([]);

      // Construction fills the footprint from the bottom up.
      if (e.constructing) {
        const t = Math.min(1, e.buildProgress / e.buildTime);
        ctx.fillStyle = `${color}33`;
        ctx.fillRect(px + 2, py + ph - 2 - (ph - 4) * t, pw - 4, (ph - 4) * t);
      }

      drawBuildingGlyph(e, px, py, pw, ph, color);

      if (selection.has(e.id)) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.strokeRect(px, py, pw, ph);
      }

      if (e.hp < e.maxHp) drawBar(px + 3, py - 7, pw - 6, 4, e.hp / e.maxHp, '#57d16a');

      // A dark structure is a real tactical fact; show it.
      if (e.def.needsPower && !e.powered && !e.constructing) {
        ctx.fillStyle = '#ff5f5f';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('⚡', px + pw / 2 - 6, py + ph / 2 + 4);
      }

      if (e.queue && e.queue.length > 0) {
        const item = e.queue[0];
        drawBar(px + 3, py + ph + 3, pw - 6, 3, 1 - item.remaining / item.total, '#4fb3ff');
      }

      // Being repaired: a pulsing outline, because a structure quietly eating
      // your scrap should never be invisible.
      if (e.repairing) {
        const pulse = 0.4 + 0.35 * Math.sin(world.tick * 0.25);
        ctx.strokeStyle = `rgba(87, 209, 106, ${pulse})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 1, py - 1, pw + 2, ph + 2);
      }

      // Superweapon charge, on the structure itself. A defender who can see
      // the Lance can see how long they have.
      if (e.def.superweapon && !e.constructing) {
        const ready = superweaponReady(e);
        const t = Math.min(1, (e.charge || 0) / e.def.superweapon.charge);
        drawBar(px + 3, py + ph + 3, pw - 6, 4, t, ready ? '#ff5f5f' : '#ffb347');
        if (ready) {
          ctx.strokeStyle = `rgba(255, 95, 95, ${0.45 + 0.35 * Math.sin(world.tick * 0.2)})`;
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

  function drawBuildingGlyph(e, px, py, pw, ph, color) {
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    switch (e.defId) {
      case 'command':
        ctx.moveTo(cx - 10, cy + 8);
        ctx.lineTo(cx, cy - 10);
        ctx.lineTo(cx + 10, cy + 8);
        ctx.closePath();
        break;
      case 'reactor':
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        break;
      case 'refinery':
        ctx.rect(cx - 11, cy - 6, 22, 12);
        break;
      case 'turret':
        ctx.arc(cx, cy, 6, 0, Math.PI * 2);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(e.facing) * 11, cy + Math.sin(e.facing) * 11);
        break;
      case 'sensor':
        ctx.moveTo(cx, cy + 8);
        ctx.lineTo(cx, cy - 8);
        ctx.moveTo(cx - 6, cy - 4);
        ctx.lineTo(cx + 6, cy - 4);
        break;
      default:
        ctx.rect(cx - 9, cy - 9, 18, 18);
        ctx.moveTo(cx - 9, cy - 9);
        ctx.lineTo(cx + 9, cy + 9);
    }
    ctx.stroke();
  }

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

      ctx.save();
      ctx.translate(x, y - lift);

      // Airborne things cast a shadow, which is the only cue that they are
      // above the battlefield rather than on it.
      if (lift > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(0, lift, r * 0.8, r * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      if (selection.has(e.id)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.rotate(e.facing);
      drawChassis(e, r, color);
      ctx.restore();

      drawUnitStatus(e, x, y - lift, r);
    }
  }

  /** Silhouette by role, so a unit's job is readable at a glance. */
  function drawChassis(e, r, color) {
    ctx.fillStyle = '#141a22';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();

    const role = e.def.role;
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
      // Assault, brawler and support all read as a hexagonal mech torso.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r * 0.85;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.stroke();

    // Hardpoints, drawn as muzzles pointing where the unit is facing.
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    const count = e.def.hardpoints.length;
    for (let i = 0; i < count; i++) {
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * r * 0.8;
      ctx.beginPath();
      ctx.moveTo(r * 0.3, offset);
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
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (e.disabledUntil > world.tick) {
      ctx.fillStyle = '#9be7ff';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillText('EMP', x - 11, y - r - 16);
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

  function drawProjectiles() {
    for (const p of world.projectiles) {
      if (!isVisible(world, viewerId, p.x, p.y)) continue;
      const x = p.x * CELL;
      const y = p.y * CELL;

      if (p.kind === 'rocket' || p.kind === 'shell') {
        const angle = Math.atan2(p.ty - p.y, p.tx - p.x);
        ctx.strokeStyle = p.kind === 'shell' ? '#ffb347' : '#ff8a5c';
        ctx.lineWidth = p.kind === 'shell' ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(angle) * 9, y - Math.sin(angle) * 9);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#ffe9a8';
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
  }

  function drawEffects() {
    for (const fx of world.effects) {
      if (fx.type === 'beam') {
        if (!isVisible(world, viewerId, fx.x1, fx.y1) && !isVisible(world, viewerId, fx.x2, fx.y2)) {
          continue;
        }
        ctx.strokeStyle = fx.damageType === 'emp' ? 'rgba(150,220,255,0.9)' : 'rgba(255,110,90,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(fx.x1 * CELL, fx.y1 * CELL);
        ctx.lineTo(fx.x2 * CELL, fx.y2 * CELL);
        ctx.stroke();
      } else if (fx.type === 'empBurst') {
        ctx.strokeStyle = 'rgba(150,220,255,0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(fx.x * CELL, fx.y * CELL, fx.radius * CELL, 0, Math.PI * 2);
        ctx.stroke();
      } else if (fx.type === 'healField') {
        ctx.strokeStyle = 'rgba(120,230,150,0.35)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(fx.x * CELL, fx.y * CELL, fx.radius * CELL, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    for (const spark of state.sparks) {
      const life = spark.ttl / spark.maxTtl;
      ctx.fillStyle = `rgba(255, ${140 + Math.round(life * 90)}, 80, ${life})`;
      const size = spark.size * (0.4 + life);
      ctx.fillRect(spark.x * CELL - size / 2, spark.y * CELL - size / 2, size, size);
    }
  }

  /** The superweapon aiming reticle, while a strike is being targeted. */
  function drawStrikePreview() {
    const aim = state.strikeAim;
    if (!aim) return;
    const w = screenToWorld(state.hoverPixel.x, state.hoverPixel.y);

    ctx.strokeStyle = 'rgba(255, 95, 95, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.arc(w.x * CELL, w.y * CELL, aim.radius * CELL, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(255, 95, 95, 0.12)';
    ctx.fill();
  }

  function drawPlacementPreview() {
    const p = state.placement;
    if (!p) return;
    const def = BUILDINGS[p.defId];
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = p.legal ? '#4fd07a' : '#ff5f5f';
    ctx.fillRect(p.cx * CELL, p.cy * CELL, def.size[0] * CELL, def.size[1] * CELL);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = p.legal ? '#8effb0' : '#ff9a9a';
    ctx.lineWidth = 2;
    ctx.strokeRect(p.cx * CELL, p.cy * CELL, def.size[0] * CELL, def.size[1] * CELL);
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
      data[o] = 6;
      data[o + 1] = 10;
      data[o + 2] = 18;
      data[o + 3] = visible[i] ? 0 : explored[i] ? 178 : 255;
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

  function drawSelectionBox() {
    const box = state.selectionBox;
    if (!box) return;
    ctx.strokeStyle = 'rgba(140, 230, 255, 0.9)';
    ctx.fillStyle = 'rgba(140, 230, 255, 0.12)';
    ctx.lineWidth = 1;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  /* ----------------------------------------------------------- minimap -- */

  function drawMinimap(minimapCanvas) {
    const mctx = minimapCanvas.getContext('2d');
    const size = minimapCanvas.width;
    const k = size / world.map.width;

    mctx.fillStyle = '#080b10';
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

  /** Spawn cosmetic debris. Renderer-only; never touches world state. */
  function addSparks(x, y, count, size = 3) {
    for (let i = 0; i < count; i++) {
      state.sparks.push({
        x: x + (Math.random() - 0.5) * 0.5,
        y: y + (Math.random() - 0.5) * 0.5,
        vx: (Math.random() - 0.5) * 0.08,
        vy: (Math.random() - 0.5) * 0.08,
        ttl: 12 + Math.random() * 10,
        maxTtl: 22,
        size,
      });
    }
  }

  function stepSparks() {
    for (const spark of state.sparks) {
      spark.x += spark.vx;
      spark.y += spark.vy;
      spark.ttl--;
    }
    state.sparks = state.sparks.filter((s) => s.ttl > 0);
  }

  /** Turn simulation events into visual noise. */
  function consumeEvents(events) {
    for (const ev of events) {
      if (ev.type === 'explosion') addSparks(ev.x, ev.y, ev.big ? 26 : 10, ev.big ? 5 : 3);
      else if (ev.type === 'impact') addSparks(ev.x, ev.y, 4, 2);
      else if (ev.type === 'death') addSparks(ev.x, ev.y, ev.kind === 'building' ? 30 : 14, 4);
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

/** One-time terrain bake. */
function paintTerrain(ctx, world) {
  const { map } = world;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const info = TERRAIN_INFO[map.terrain[y * map.width + x]];
      ctx.fillStyle = info.color;
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);

      // Per-cell tonal variation. Without it a 72×72 grid of one hex value
      // reads as a flat grey wash and the eye has nothing to hold on to —
      // the map stops looking like ground and starts looking like a
      // wireframe. Hashed from the coordinates so it is stable across
      // redraws and costs nothing at runtime; this buffer is baked once.
      const hash = ((x * 73856093) ^ (y * 19349663)) >>> 0;
      const shade = (hash % 7) - 3;
      if (shade !== 0) {
        ctx.fillStyle = `rgba(${shade > 0 ? '255,255,255' : '0,0,0'}, ${Math.abs(shade) * 0.012})`;
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }

      // A faint grid: it makes structure footprints legible during placement,
      // which is most of what the grid is for.
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL, CELL);
    }
  }

  // Cliff edges get a highlight so height reads at a glance.
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const t = map.terrain[y * map.width + x];
      if (TERRAIN_INFO[t].passable) continue;
      const above = y > 0 ? map.terrain[(y - 1) * map.width + x] : t;
      if (TERRAIN_INFO[above].passable) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(x * CELL, y * CELL, CELL, 2);
      }
    }
  }
}

export { UNITS, BUILDINGS };
