/**
 * NOD Tank Shooter — the renderer.
 *
 * Reads the world, writes pixels, and touches neither. Everything transient —
 * muzzle flash, sparks, damage numbers, screen shake — is driven off
 * `world.events` rather than off state, which is why the simulation can be
 * stepped a thousand times in a test without any of this existing.
 *
 * Vector art, no sprites. Partly because it is the same visual language
 * `rocketman` speaks and these are meant to sit in one arcade, and partly
 * because a game that draws itself from shapes has no assets to load, which is
 * what lets a round start the instant a token is spent.
 *
 * `Math.random` is used freely in here. That is allowed and it is the point of
 * the split: sparks are not state, nothing reads them back, and two players
 * watching the same seed see the same *game* even if the debris differs.
 */

import { ARENA, TANK, GUNS, HOSTILES } from '../engine/content.js';

const PALETTE = {
  floor: '#0b0f14',
  grid: '#141c25',
  wall: '#1e2a36',
  wallEdge: '#2f4152',
  tank: '#4fd1c5',
  tankDark: '#1f6f68',
  turret: '#8ef2e8',
  hostile: '#e2574c',
  hostileDark: '#7d2a24',
  shield: '#f5a623',
  shot: '#ffe08a',
  hostileShot: '#ff8a7a',
  pickup: '#7ee787',
  telegraph: '#ff5d47',
  text: '#c9d6e2',
};

/** Per-hostile accent, so five machines are five silhouettes and five colours. */
const HOSTILE_TINT = {
  scuttler: '#e2574c',
  gunhead: '#c86bd8',
  lobber: '#e8a33d',
  warden: '#5b8ff9',
  hive: '#43c07a',
};

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const camera = { x: ARENA.width / 2, y: ARENA.height / 2, zoom: 1 };

  /** Cosmetic particles. Never read by anything but this file. */
  let sparks = [];
  let floats = [];
  let shake = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Fit the whole arena, with a little margin. The arena is small enough to
    // hold entirely on screen, which removes the whole class of "something
    // killed me from off-screen" complaints a scrolling camera invites.
    camera.zoom = Math.min(w / (ARENA.width + 90), h / (ARENA.height + 90));
  }

  function viewWidth() {
    return canvas.clientWidth;
  }
  function viewHeight() {
    return canvas.clientHeight;
  }

  /** World point to screen point. Exported shape matches rocketman's renderer. */
  function worldToScreen(x, y) {
    return {
      x: (x - camera.x) * camera.zoom + viewWidth() / 2,
      y: (y - camera.y) * camera.zoom + viewHeight() / 2,
    };
  }

  /** Screen point to world point — what the mouse needs to aim. */
  function screenToWorld(x, y) {
    return {
      x: (x - viewWidth() / 2) / camera.zoom + camera.x,
      y: (y - viewHeight() / 2) / camera.zoom + camera.y,
    };
  }

  /** Turn one tick's events into things to look at. */
  function consumeEvents(events) {
    for (const ev of events) {
      switch (ev.type) {
        case 'fire':
          burst(ev.x, ev.y, 4, PALETTE.shot, 120, ev.angle, 0.5);
          break;
        case 'hit':
          burst(ev.x, ev.y, ev.shielded ? 4 : 8, ev.shielded ? PALETTE.shield : PALETTE.shot, 150);
          if (ev.shielded) float(ev.x, ev.y, 'clang', PALETTE.shield);
          break;
        case 'kill':
          burst(ev.x, ev.y, 18, HOSTILE_TINT[ev.hostile] || PALETTE.hostile, 260);
          if (ev.score) float(ev.x, ev.y, `+${ev.score}`, PALETTE.text);
          shake = Math.min(9, shake + 2.5);
          break;
        case 'tankHit':
          burst(ev.x, ev.y, 14, PALETTE.hostileShot, 220);
          shake = Math.min(14, shake + 6);
          break;
        case 'shotSpark':
          burst(ev.x, ev.y, 3, PALETTE.wallEdge, 90);
          break;
        case 'boost':
          burst(ev.x, ev.y, 10, PALETTE.tank, 180);
          break;
        case 'repaired':
          float(ev.x, ev.y, 'repaired', PALETTE.pickup);
          break;
        case 'gunTaken':
          float(ev.x, ev.y, GUNS[ev.gun].label, PALETTE.pickup);
          break;
        case 'waveStart':
          float(ARENA.width / 2, ARENA.height / 2 - 120, `WAVE ${ev.wave}`, PALETTE.text, 1.6);
          break;
        default:
          break;
      }
    }
  }

  function burst(x, y, n, colour, speed, angle = null, spread = Math.PI * 2) {
    for (let i = 0; i < n; i++) {
      const a = angle === null ? Math.random() * Math.PI * 2 : angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.35 + Math.random() * 0.65);
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.25 + Math.random() * 0.35, colour });
    }
  }

  function float(x, y, text, colour, life = 0.9) {
    floats.push({ x, y, text, colour, life, max: life });
  }

  /**
   * Draw one frame.
   *
   * `dt` is real elapsed seconds, not the simulation's fixed step — particles
   * and shake are wall-clock effects and should not slow down if the tab does.
   */
  function draw(world, dt) {
    stepEffects(dt);

    const w = viewWidth();
    const h = viewHeight();
    ctx.save();
    ctx.fillStyle = PALETTE.floor;
    ctx.fillRect(0, 0, w, h);

    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }
    ctx.translate(w / 2, h / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    drawFloor(ctx);
    drawCover(ctx, world);
    drawPickups(ctx, world);
    drawShots(ctx, world);
    drawHostiles(ctx, world);
    drawTank(ctx, world);
    drawSparks(ctx);
    drawFloats(ctx);

    ctx.restore();
  }

  function stepEffects(dt) {
    shake = Math.max(0, shake - dt * 40);
    for (const s of sparks) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.94;
      s.vy *= 0.94;
      s.life -= dt;
    }
    sparks = sparks.filter((s) => s.life > 0);
    for (const f of floats) {
      f.y -= dt * 26;
      f.life -= dt;
    }
    floats = floats.filter((f) => f.life > 0);
  }

  function drawFloor(ctx) {
    ctx.fillStyle = PALETTE.grid;
    ctx.fillRect(0, 0, ARENA.width, ARENA.height);
    ctx.fillStyle = PALETTE.floor;
    ctx.fillRect(4, 4, ARENA.width - 8, ARENA.height - 8);

    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= ARENA.width; x += 100) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ARENA.height);
    }
    for (let y = 0; y <= ARENA.height; y += 100) {
      ctx.moveTo(0, y);
      ctx.lineTo(ARENA.width, y);
    }
    ctx.stroke();
  }

  function drawCover(ctx, world) {
    for (const c of world.cover) {
      ctx.fillStyle = PALETTE.wall;
      ctx.fillRect(c.x, c.y, c.w, c.h);
      ctx.strokeStyle = PALETTE.wallEdge;
      ctx.lineWidth = 2;
      ctx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
    }
  }

  function drawPickups(ctx, world) {
    for (const p of world.pickups) {
      // Blink out as it expires, so a pickup about to vanish says so.
      const fading = p.life < 4 && Math.floor(p.life * 6) % 2 === 0;
      if (fading) continue;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(performance.now() / 700);
      ctx.strokeStyle = PALETTE.pickup;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(-p.radius * 0.7, -p.radius * 0.7, p.radius * 1.4, p.radius * 1.4);
      ctx.restore();

      ctx.fillStyle = PALETTE.pickup;
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(p.kind === 'repair' ? '+HP' : GUNS[p.gun].label.toUpperCase(), p.x, p.y + 30);
    }
  }

  function drawShots(ctx, world) {
    for (const s of world.shots) {
      ctx.fillStyle = s.friendly ? PALETTE.shot : PALETTE.hostileShot;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.fill();
      // A short trail behind the travel direction reads as speed without
      // costing a particle per shot per frame.
      ctx.strokeStyle = s.friendly ? PALETTE.shot : PALETTE.hostileShot;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = s.radius * 1.4;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.02, s.y - s.vy * 0.02);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawHostiles(ctx, world) {
    for (const h of world.hostiles) {
      const def = HOSTILES[h.type];
      const tint = HOSTILE_TINT[h.type] || PALETTE.hostile;
      ctx.save();
      ctx.translate(h.x, h.y);

      // The telegraph, drawn as a widening line toward where the shot will go.
      // It is the single most important thing on screen when it is on screen.
      if (h.telegraph > 0 && def.gun) {
        const progress = 1 - h.telegraph / def.gun.telegraph;
        ctx.save();
        ctx.rotate(h.facing);
        ctx.strokeStyle = PALETTE.telegraph;
        ctx.globalAlpha = 0.25 + progress * 0.5;
        ctx.lineWidth = 1 + progress * 4;
        ctx.beginPath();
        ctx.moveTo(h.radius, 0);
        ctx.lineTo(h.radius + def.range * progress, 0);
        ctx.stroke();
        ctx.restore();
      }

      ctx.rotate(h.facing);
      ctx.fillStyle = tint;
      ctx.strokeStyle = PALETTE.hostileDark;
      ctx.lineWidth = 2;

      switch (h.type) {
        case 'scuttler':
          // A dart. Points where it is going, which is all it does.
          ctx.beginPath();
          ctx.moveTo(h.radius, 0);
          ctx.lineTo(-h.radius * 0.7, h.radius * 0.8);
          ctx.lineTo(-h.radius * 0.7, -h.radius * 0.8);
          ctx.closePath();
          ctx.fill();
          break;
        case 'gunhead':
          // An emplacement: squat base, long barrel.
          ctx.fillRect(-h.radius * 0.8, -h.radius * 0.8, h.radius * 1.6, h.radius * 1.6);
          ctx.fillRect(0, -3, h.radius * 1.7, 6);
          break;
        case 'lobber':
          // A mortar tube, angled up. Rounded so it reads as different from
          // the gunhead's hard edges at a glance.
          ctx.beginPath();
          ctx.arc(0, 0, h.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = PALETTE.hostileDark;
          ctx.fillRect(0, -5, h.radius * 1.3, 10);
          break;
        case 'warden': {
          ctx.beginPath();
          ctx.arc(0, 0, h.radius, 0, Math.PI * 2);
          ctx.fill();
          // The shield arc, drawn exactly where the damage rule says it is.
          // A player should never have to guess where "the front" ends.
          ctx.strokeStyle = PALETTE.shield;
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.arc(0, 0, h.radius + 5, -def.shieldArc, def.shieldArc);
          ctx.stroke();
          break;
        }
        case 'hive':
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const r = h.radius * (i % 2 ? 0.7 : 1);
            i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          }
          ctx.closePath();
          ctx.fill();
          break;
        default:
          ctx.beginPath();
          ctx.arc(0, 0, h.radius, 0, Math.PI * 2);
          ctx.fill();
      }
      ctx.restore();

      // Health bar, only once it means something. A full bar over every enemy
      // is noise; a bar that appears when you have hurt something is feedback.
      if (h.health < def.health) {
        const frac = Math.max(0, h.health / def.health);
        ctx.fillStyle = '#000a';
        ctx.fillRect(h.x - h.radius, h.y - h.radius - 12, h.radius * 2, 4);
        ctx.fillStyle = tint;
        ctx.fillRect(h.x - h.radius, h.y - h.radius - 12, h.radius * 2 * frac, 4);
      }
    }
  }

  function drawTank(ctx, world) {
    const t = world.tank;
    if (t.health <= 0) return;
    ctx.save();
    ctx.translate(t.x, t.y);

    // Flicker while invulnerable, so "that hit did not land" is visible.
    if (t.invulnerable > 0 && Math.floor(t.invulnerable * 20) % 2 === 0) ctx.globalAlpha = 0.45;

    ctx.save();
    ctx.rotate(t.hull);
    ctx.fillStyle = PALETTE.tankDark;
    ctx.fillRect(-t.radius, -t.radius * 0.95, t.radius * 2, t.radius * 1.9);
    ctx.fillStyle = PALETTE.tank;
    ctx.fillRect(-t.radius * 0.85, -t.radius * 0.7, t.radius * 1.7, t.radius * 1.4);
    ctx.restore();

    ctx.save();
    ctx.rotate(t.turret);
    ctx.fillStyle = PALETTE.turret;
    ctx.beginPath();
    ctx.arc(0, 0, t.radius * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(0, -3.5, t.radius * 1.6, 7);
    ctx.restore();

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawSparks(ctx) {
    for (const s of sparks) {
      ctx.globalAlpha = Math.max(0, Math.min(1, s.life * 3));
      ctx.fillStyle = s.colour;
      ctx.fillRect(s.x - 1.5, s.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloats(ctx) {
    ctx.textAlign = 'center';
    for (const f of floats) {
      ctx.globalAlpha = Math.max(0, Math.min(1, f.life / f.max));
      ctx.fillStyle = f.colour;
      ctx.font = f.max > 1 ? '700 34px system-ui, sans-serif' : '600 14px system-ui, sans-serif';
      ctx.fillText(f.text, f.x, f.y);
    }
    ctx.globalAlpha = 1;
  }

  return { camera, resize, draw, consumeEvents, worldToScreen, screenToWorld, viewWidth, viewHeight };
}
