# Structure art — the drawing contract

Everything here concerns one function: `drawBuildingDetail` in
`rocketman/web/render.js` (~line 1344). Read this before writing a case; the
conventions are consistent across every existing structure and matching them
is most of what makes a new building look like it belongs.

## Contents

- [What is already drawn for you](#what-is-already-drawn-for-you)
- [The coordinate contract](#the-coordinate-contract)
- [The palette](#the-palette)
- [Animation](#animation)
- [The glow pass](#the-glow-pass)
- [Particles](#particles)
- [Worked example](#worked-example)
- [Gotchas](#gotchas)

## What is already drawn for you

By the time your case runs, `drawStructureBody` has laid down, in order:

1. A drop shadow, offset south-east — structures sit *on* the ground.
2. The extruded south face in `#0d1218`, which is what gives every building
   its sense of height.
3. The roof plate: a linear gradient lit from the north-west, `#2e3947` →
   `#212b36` → `#19212a`.
4. Vertical panel seams, one per cell boundary.
5. The faction trim band along the top edge, plus a white highlight under it.

And after your case returns, `drawBuildings` may draw over the top: an HP
bar, a production progress bar, a selection bracket, a repair outline, a
superweapon charge bar, veterancy pips, and — during a brownout — a dark
scrim with a ⚡ glyph centred on the building.

So your job is only the middle layer: the thing that makes this building
recognisable at a glance. Do not redraw the body, the trim, or the outline.
A structure that is under construction never reaches your case at all —
`drawConstruction` handles that state completely.

## The coordinate contract

Your case receives pixels, not cells, and two pre-computed centres:

```js
const cx = px + pw / 2;
const cy = py + ph / 2 - 2;   // the -2 lifts detail onto the roof
```

`CELL` is 24px, so a `[3, 3]` building is 72×72 and a `[1, 1]` turret is
24×24. The usable area is the **roof plate**, not the full footprint:

```
px+2 ────────────────────────── px+pw-2
  │  faction trim band (~5px)          │   ← do not draw here
py+7 ─────────────────────────────────      ← your ceiling
  │                                    │
  │        draw in here                │
  │                                    │
py+ph-5 ──────────────────────────────      ← your floor
  │  extruded south face               │   ← do not draw here
py+ph-2 ──────────────────────────────
```

Anything below `py + ph - 5` lands on the dark south face and reads as a
smear rather than a feature. `cy` is already centred in the usable band, so
building outward from `cx, cy` keeps you inside it without arithmetic.

Small buildings are tight. A `[1, 1]` structure gives you roughly a 20×12
band — the Turret and Sensor Mast both solve this the same way, with a
single ~8px radius circle at `cx, cy` and one moving element on top. Do not
try to fit a scene into one cell.

## The palette

The whole game is desaturated blue-grey steel with one hot accent. Reusing
these exact values is what keeps a new building from looking pasted in.

| Role | Value |
|---|---|
| Deep inset / hole / doorway | `#0e141b`, `#101820`, `#0f151c` |
| Panel fill, slightly lifted | `#151d26` |
| Mid metal — spires, barrels, hoppers | `#232e3a`, `#28323e` |
| Rim light on any metal edge | `rgba(140, 160, 180, 0.4)` – `0.55` |
| Panel seams / recesses | `rgba(0, 0, 0, 0.35)` |
| Faction accent | the `color` argument |

`color` is the player's faction colour and it is how ownership reads at a
glance. It is already spent on the roof trim, so use it for **exactly one**
thing in your detail — a barrel tip, a lit strip, a door frame. Two or three
faction-coloured elements and the building stops reading as steel.

Hot light is one of three, matching what the thing does: cyan
`rgba(120, 220, 255, …)` for power, green `rgba(120, 220, 160, …)` for
sensors and information, red/orange `rgba(255, 120, 100, …)` for weapons and
warnings.

## Animation

Use `frameClock`, a frame counter that ticks even when the game is paused.
It is presentation-only and must never influence anything the simulation
reads.

```js
Math.sin(frameClock * 0.08 + e.id)   // smooth throb; + e.id desyncs instances
(frameClock >> 4) % 3 === 0          // blink, on for one beat in three
frameClock * 0.05                    // a rotating sweep angle
```

Adding `e.id` to the phase matters more than it looks: without it, six
Reactors in a base pulse in perfect lockstep and read as a screensaver.

`Math.random()` is legal in `render.js` and used freely for flicker and
particle jitter. It is **forbidden in `engine/`** — the simulation is
deterministic and replay depends on it. If you find yourself wanting
randomness in a structure's *behaviour* rather than its appearance, use the
seeded RNG in `engine/rng.js` instead.

You can read live simulation state off the entity: `e.facing` (the Turret
tracks its target with it), `e.charge` (the Lance irises open as it fills),
`e.queue`, `e.powered`, `e.hp`, `e.vet`. Driving art from real state is
free and is the difference between decoration and information.

## The glow pass

Anything that emits light goes inside `glow(() => { ... })`. That queues the
draw for a single additive pass that runs after buildings, units and
projectiles, which is the cheap trick that buys the whole arcade look. Drawn
normally instead, a light source just looks like a pale sticker.

```js
glow(() => {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 12);
  g.addColorStop(0, `rgba(120, 220, 255, ${throb})`);
  g.addColorStop(1, 'rgba(120, 220, 255, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, TAU);
  ctx.fill();
});
```

The callback runs later, so anything it depends on must be captured in the
closure rather than left on `ctx` — a `ctx.save()`/`translate()` around the
`glow()` call has already been unwound by the time it fires.

## Particles

`addParticle(type, x, y, opts)` takes **cell coordinates**, while everything
else in your case is in pixels. This is the single most common mistake; the
conversion is `/ CELL`:

```js
addParticle('smoke', (cx + 6) / CELL, (cy - 4) / CELL);
```

Types: `spark`, `smoke`, `flame`, `fire`, `flash`, `ring`, `debris`,
`trail`, `weld`, `dust`, `ember`, `groundfire`. Gate emission behind a
probability — `if (Math.random() < 0.2)` — because your case runs every
frame and the system hard-caps at 900 particles before it starts dropping
them silently. Damage smoke is already emitted for you below 45% HP; adding
an idle plume on top of that is usually too much.

## Worked example

A Hangar, showing the common techniques together: a dark bay mouth, an
approach stripe in the faction colour, structural ribs, and a beacon that
blinks only while something is in the production queue.

```js
case 'hangar': {
  // Bay mouth: a wide, deep opening on the south edge of the roof plate,
  // sized off pw so it scales if the footprint ever changes.
  const bayW = pw * 0.5;
  const bayH = ph * 0.26;
  ctx.fillStyle = '#0e141b';
  ctx.fillRect(cx - bayW / 2, cy + 2, bayW, bayH);
  ctx.strokeStyle = 'rgba(140,160,180,0.5)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx - bayW / 2, cy + 2, bayW, bayH);

  // Approach stripe — the one faction-coloured element.
  ctx.fillStyle = color;
  ctx.fillRect(cx - 1.5, cy + 4, 3, bayH - 4);

  // Barrel-vault ribs across the roof: three arcs read as a hangar shell.
  ctx.strokeStyle = 'rgba(140,160,180,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const y = cy - 10 + i * 5;
    ctx.beginPath();
    ctx.moveTo(cx - pw * 0.3, y);
    ctx.quadraticCurveTo(cx, y - 4, cx + pw * 0.3, y);
    ctx.stroke();
  }

  // Beacon: lit only while building something, so the art carries state.
  if (e.queue && e.queue.length > 0 && (frameClock >> 3) % 2 === 0) {
    glow(() => {
      ctx.fillStyle = 'rgba(255, 180, 100, 0.9)';
      ctx.beginPath();
      ctx.arc(cx + pw * 0.32, cy - 12, 2, 0, TAU);
      ctx.fill();
    });
  }
  break;
}
```

Note what it does *not* do: no outline, no roof fill, no HP indicator, no
faction colour beyond the one stripe. Roughly 30 lines, and most of the
thinking is choosing which two or three shapes say "hangar" at 72 pixels.

## Gotchas

- **Detail on the south face.** Drawing below `py + ph - 5` puts it on the
  dark extrusion. If a feature looks muddy, this is why.
- **Pixels vs cells.** `addParticle` is cells. Everything else is pixels.
- **Forgetting `break;`.** It is a `switch`, and falling through into
  `default:` draws the generic panel on top of your work.
- **`e.defId`, not `e.id`.** `e.id` is the unique entity id — useful as an
  animation phase offset, useless as a type test.
- **Unbalanced `ctx.save()`.** Every `save()` needs its `restore()` on every
  path out of the case, or the transform leaks into every entity drawn after
  it and the whole frame skews.
- **Testing only the healthy state.** Brownout draws a scrim over you, low
  HP adds smoke, and selection adds brackets. Check all three.
- **Reaching for an image asset.** There are none. The game has no build
  step, no bundler and no runtime dependency; every pixel is drawn with
  canvas calls at runtime, and adding a sprite sheet would break that.
