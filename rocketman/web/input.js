/**
 * Mouse, keyboard and selection.
 *
 * Everything the player does leaves this file as a *command object* pushed
 * onto a queue, never as a direct mutation. That is the same path the AI uses
 * and the same path a network would use, so anything playable here is
 * recordable and replayable for free.
 *
 * The control scheme is the one thirty years of RTS players already have in
 * their hands: left-drag to select, right-click to order, letter keys for
 * stances, digits for control groups. Novel controls are a tax on the exact
 * audience most likely to enjoy this.
 */

import { CELL, BUILDINGS, UNITS, BUILD_ORDER, BUILD_HOTKEYS } from '../engine/content.js';
import { canPlace } from '../engine/grid.js';
import { withinBuildRadius } from '../engine/sim.js';
import { isExplored } from '../engine/vision.js';
import { techAllows, canAfford } from '../engine/economy.js';
import { abilityReady, CHASSIS_SLOT, HERO_SLOT } from '../engine/abilities.js';
import { superweaponReady } from '../engine/economy.js';

/** Camera pan speed in cells per second. */
const PAN_SPEED = 26;
const EDGE_MARGIN = 18;

/**
 * Keys that drive a machine while direct control is engaged, as eight-way
 * intent. WASD only; holding two gives the diagonal.
 *
 * These overlap the RTS hotkeys on purpose — `a` is attack-move and `s` is
 * stop when you are commanding, and steering when you are piloting. Only one
 * of those meanings is live at a time, and the HUD says which.
 */
const STEER_KEYS = {
  w: [0, -1],
  s: [0, 1],
  a: [-1, 0],
  d: [1, 0],
};

/**
 * Camera pan keys. Always the arrows, never anything else.
 *
 * They used to steer the machine while direct control was engaged and pan the
 * camera the rest of the time, which meant the most-used key on the keyboard
 * did two unrelated things depending on a mode you might not have noticed you
 * were in. Every game this one is modelled on has exactly one answer to "what
 * do the arrow keys do", and it is *move the view*.
 *
 * Driving keeps WASD, which is where a pilot's hand already is.
 */
const PAN_KEYS = {
  arrowup: [0, -1],
  arrowdown: [0, 1],
  arrowleft: [-1, 0],
  arrowright: [1, 0],
};

export function createInput(canvas, world, viewerId, renderer, hooks = {}) {
  const selection = new Set();
  const commands = [];
  const groups = new Map();
  const keys = new Set();

  const drag = { active: false, x0: 0, y0: 0, x1: 0, y1: 0, moved: false };
  /** Middle-button camera grab. */
  const pan = { active: false, x: 0, y: 0 };
  const pointer = { x: 0, y: 0, inside: false };
  let placementDefId = null;
  /** True while the player is picking a target for a targeted ability. */
  let abilityArmed = false;
  /** Which ability slot the armed targeting belongs to. */
  let armedSlot = CHASSIS_SLOT;
  /** The Lance whose strike is currently being aimed, if any. */
  let strikeEmitter = null;

  /** Direct control: driving one machine from the keyboard. */
  let driving = false;
  let drivenId = null;
  /**
   * Set when the player drags the map while driving.
   *
   * The camera normally locks to the machine being driven, which is right
   * until you are on a phone: there is no C key to escape with, so a locked
   * camera means that once you take the cockpit you can never look anywhere
   * else for the rest of the mission. A drag suspends the lock; touching the
   * stick again — or picking anyone off the roster — restores it.
   */
  let cameraFreed = false;
  /** Last steer vector sent, so a held key costs one command and not twenty
   *  a second — which is what keeps a recorded match small. */
  let steerX = 0;
  let steerY = 0;

  const emit = (cmd) => commands.push(cmd);
  const notify = (msg) => hooks.onMessage && hooks.onMessage(msg);

  /* -------------------------------------------------------- selection -- */

  function mine(e) {
    return e && !e.dead && e.player === viewerId;
  }

  function selectedEntities() {
    const out = [];
    for (const id of selection) {
      const e = world.entities.get(id);
      if (e && !e.dead) out.push(e);
    }
    return out;
  }

  function pruneSelection() {
    for (const id of [...selection]) {
      const e = world.entities.get(id);
      if (!e || e.dead) selection.delete(id);
    }
  }

  function entityAt(wx, wy) {
    let best = null;
    let bestD = Infinity;
    for (const e of world.entities.values()) {
      if (e.dead || !renderer.seenBy(e)) continue;

      if (e.kind === 'building') {
        if (wx >= e.cx && wy >= e.cy && wx < e.cx + e.size[0] && wy < e.cy + e.size[1]) {
          // A unit standing on a building should still be clickable, so
          // buildings lose ties.
          if (bestD > 900) {
            best = e;
            bestD = 900;
          }
        }
        continue;
      }

      const d = Math.hypot(e.x - wx, e.y - wy);
      if (d <= e.radius + 0.35 && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  function boxSelect(x0, y0, x1, y1, additive) {
    const a = renderer.screenToWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = renderer.screenToWorld(Math.max(x0, x1), Math.max(y0, y1));
    if (!additive) selection.clear();

    const hits = [];
    for (const e of world.entities.values()) {
      if (!mine(e) || e.kind !== 'unit') continue;
      if (e.x < a.x || e.x > b.x || e.y < a.y || e.y > b.y) continue;
      hits.push(e);
    }

    // Dragging a box over a base should grab the army, not the harvesters.
    const combat = hits.filter((e) => !e.harvest);
    for (const e of combat.length > 0 ? combat : hits) selection.add(e.id);
    announceSelection();
  }

  function selectSingle(e, additive) {
    if (!additive) selection.clear();
    if (e) {
      if (additive && selection.has(e.id)) selection.delete(e.id);
      else selection.add(e.id);
    }
    announceSelection();
  }

  /** Select every visible unit of the same type on screen — the double-click. */
  function selectSameType(proto) {
    selection.clear();
    for (const e of world.entities.values()) {
      if (!mine(e) || e.kind !== 'unit' || e.defId !== proto.defId) continue;
      const s = renderer.worldToScreen(e.x, e.y);
      if (s.x < 0 || s.y < 0 || s.x > renderer.viewWidth() || s.y > renderer.viewHeight()) continue;
      selection.add(e.id);
    }
    announceSelection();
  }

  function announceSelection() {
    cancelPlacement();
    cancelStrike();
    disarmAbility();
    retargetDriving();
    if (hooks.onSelectionChange) hooks.onSelectionChange(selectedEntities());
  }

  /* --------------------------------------------------------- ordering -- */

  function issueOrder(wx, wy, queued) {
    // Clicking somewhere is an unambiguous statement that you have let go of
    // the sticks, so the mouse always wins.
    setDriving(false);
    const units = selectedEntities().filter((e) => mine(e) && e.kind === 'unit');
    const buildings = selectedEntities().filter((e) => mine(e) && e.kind === 'building');

    // A right-click with only a factory selected sets its rally point.
    if (units.length === 0 && buildings.length > 0) {
      for (const b of buildings) {
        if (b.def.rally) emit({ type: 'rally', player: viewerId, buildingId: b.id, x: wx, y: wy });
      }
      return;
    }
    if (units.length === 0) return;

    const ids = units.map((e) => e.id);
    const target = entityAt(wx, wy);

    if (target && target.player !== viewerId && renderer.seenBy(target)) {
      emit({ type: 'attack', player: viewerId, ids, targetId: target.id, queue: queued });
      return;
    }

    // Right-clicking scrap with collectors selected is a harvest order; with
    // anything else it is just a move, because that is what the player meant.
    const cell = { x: Math.floor(wx), y: Math.floor(wy) };
    const onScrap = world.map.resource[cell.y * world.map.width + cell.x] > 0;
    const harvesters = units.filter((e) => e.harvest);

    if (onScrap && harvesters.length > 0) {
      emit({
        type: 'harvest',
        player: viewerId,
        ids: harvesters.map((e) => e.id),
        x: wx,
        y: wy,
      });
      const rest = units.filter((e) => !e.harvest);
      if (rest.length) {
        emit({ type: 'move', player: viewerId, ids: rest.map((e) => e.id), x: wx, y: wy, queue: queued });
      }
      return;
    }

    emit({ type: 'move', player: viewerId, ids, x: wx, y: wy, queue: queued });
  }

  /** Next tap on the field is an attack-move, for the touch action button. */
  let attackMoveArmed = false;
  function armAttackMove() {
    attackMoveArmed = true;
    cancelPlacement();
    cancelStrike();
    abilityArmed = false;
  }

  function issueAttackMove(wx, wy, queued) {
    attackMoveArmed = false;
    setDriving(false);
    const ids = selectedEntities()
      .filter((e) => mine(e) && e.kind === 'unit' && !e.harvest)
      .map((e) => e.id);
    if (ids.length === 0) return;
    emit({ type: 'attackMove', player: viewerId, ids, x: wx, y: wy, queue: queued });
  }

  /* ------------------------------------------------------ roster bar -- */

  /*
   * Selection helpers the bottom bar drives. They live here rather than in
   * main.js because selection state does, and because a click on a portrait
   * has to behave exactly like the equivalent keyboard or mouse action —
   * including handing the cockpit over when direct control is engaged.
   */

  /** Centre the camera on something, and take the sticks if we are driving. */
  function focusOn(e) {
    if (!e || e.dead) return;
    cameraFreed = false;
    selectSingle(e, false);
    renderer.centreOn(e.x, e.y);
  }

  /** Every combat machine we own. Collectors stay out of it — box-select
   *  already refuses to grab them, and pulling the economy into an army
   *  selection is how you accidentally send four Collectors at a turret. */
  function selectAllUnits() {
    selection.clear();
    const combat = [];
    for (const e of world.entities.values()) {
      if (mine(e) && e.kind === 'unit' && !e.harvest) combat.push(e);
    }
    for (const e of combat) selection.add(e.id);
    announceSelection();
    if (combat.length) {
      // Frame the group rather than one member, so "select all" also answers
      // "where is my army".
      let x = 0;
      let y = 0;
      for (const e of combat) {
        x += e.x;
        y += e.y;
      }
      renderer.centreOn(x / combat.length, y / combat.length);
    }
    return combat.length;
  }

  /** Every machine of one type, wherever it is — the roster bar's group chips. */
  function selectByDefId(defId) {
    selection.clear();
    const hits = [];
    for (const e of world.entities.values()) {
      if (mine(e) && e.kind === 'unit' && e.defId === defId) hits.push(e);
    }
    for (const e of hits) selection.add(e.id);
    announceSelection();
    if (hits.length) renderer.centreOn(hits[0].x, hits[0].y);
    return hits.length;
  }

  /* --------------------------------------------------- direct control -- */

  /**
   * Which machine the keyboard should drive.
   *
   * A single selected unit is the obvious answer. Failing that, the hero —
   * in the campaign the named pilot's mech *is* the player character, so
   * pressing a direction with nothing selected should move them.
   */
  function pickDrivable() {
    const selected = selectedEntities().filter((e) => mine(e) && e.kind === 'unit');
    if (selected.length === 1) return selected[0];
    for (const e of world.entities.values()) {
      if (mine(e) && e.kind === 'unit' && e.pilotId && !e.dead) return e;
    }
    return selected[0] || null;
  }

  /** The machine currently being driven, or null. Releases a dead one. */
  function drivenEntity() {
    if (!driving) return null;
    const e = world.entities.get(drivenId);
    if (!e || e.dead) {
      setDriving(false);
      return null;
    }
    return e;
  }

  /** Tell a machine to stand still, if we ever told it to move. */
  function releaseSteering() {
    if (drivenId !== null && (steerX !== 0 || steerY !== 0)) {
      emit({ type: 'steer', player: viewerId, ids: [drivenId], dx: 0, dy: 0 });
    }
    steerX = 0;
    steerY = 0;
  }

  function setDriving(on) {
    if (on === driving) return;

    if (!on) {
      releaseSteering();
      drivenId = null;
      driving = false;
      cameraFreed = false;
    } else {
      const unit = pickDrivable();
      if (!unit) {
        notify('Select a machine to take direct control of it.');
        return;
      }
      cancelPlacement();
      cancelStrike();
      disarmAbility();
      drivenId = unit.id;
      driving = true;
      // Driving something you cannot see selected is disorienting, so the
      // selection follows the cockpit.
      selection.clear();
      selection.add(unit.id);
      if (hooks.onSelectionChange) hooks.onSelectionChange(selectedEntities());
    }

    if (hooks.onModeChange) hooks.onModeChange(driving ? drivenEntity() : null);
    if (driving) updateSteering();
  }

  function toggleDriving() {
    setDriving(!driving);
  }

  /**
   * Follow a selection change while driving: pilot whatever was just picked,
   * or hand back control if it was not a machine of ours.
   */
  function retargetDriving() {
    if (!driving) return;
    const unit = pickDrivable();
    if (!unit) {
      setDriving(false);
      return;
    }
    if (unit.id === drivenId) return;
    releaseSteering();
    drivenId = unit.id;
    if (hooks.onModeChange) hooks.onModeChange(unit);
    updateSteering();
  }

  /**
   * Turn held keys into a steer command, but only when the direction actually
   * changed. The engine holds the vector until told otherwise.
   */
  function updateSteering() {
    if (!driving) return;
    const unit = drivenEntity();
    if (!unit) return;

    let dx = 0;
    let dy = 0;
    for (const key of Object.keys(STEER_KEYS)) {
      if (!keys.has(key)) continue;
      dx += STEER_KEYS[key][0];
      dy += STEER_KEYS[key][1];
    }
    // Opposite keys cancel; two adjacent keys give a clean diagonal.
    dx = Math.max(-1, Math.min(1, dx));
    dy = Math.max(-1, Math.min(1, dy));

    if (dx === steerX && dy === steerY) return;
    if (dx !== 0 || dy !== 0) cameraFreed = false;
    steerX = dx;
    steerY = dy;
    emit({ type: 'steer', player: viewerId, ids: [unit.id], dx, dy });
  }

  /* -------------------------------------------------------- abilities -- */

  /** Units in the selection whose ability in `slot` is off cooldown. */
  function readyAbilityUnits(slot = CHASSIS_SLOT) {
    return selectedEntities().filter((e) => e[slot] && abilityReady(world, e, slot));
  }

  function triggerAbility(wx, wy, slot = armedSlot) {
    const units = readyAbilityUnits(slot);
    if (units.length === 0) {
      notify('No ability ready.');
      return false;
    }
    emit({
      type: 'ability',
      player: viewerId,
      ids: units.map((e) => e.id),
      slot,
      x: wx,
      y: wy,
    });
    abilityArmed = false;
    return true;
  }

  /**
   * Fire, or arm targeting first if the ability needs a point. Untargeted
   * abilities go off immediately — making the player click for a self-buff is
   * a click that carries no information.
   */
  function useAbility(slot = CHASSIS_SLOT) {
    const units = readyAbilityUnits(slot);
    if (units.length === 0) {
      notify(slot === HERO_SLOT ? 'Skyfall is still recharging.' : 'No ability ready.');
      return;
    }
    const needsTarget = units.some((e) => e[slot].def.targeted);
    if (needsTarget) {
      abilityArmed = true;
      armedSlot = slot;
      // Skyfall reaches half the map, so the reticle has to show how far.
      renderer.state.abilityAim = { radius: units[0][slot].def.distance || 0 };
      notify(`${units[0][slot].def.name}: pick a target point.`);
    } else {
      triggerAbility(units[0].x, units[0].y, slot);
    }
  }

  /* ------------------------------------------------------ superweapon -- */

  /**
   * Arm a superweapon strike. Deliberately a two-step action — arm, then click
   * a point — because a one-click doomsday button is a misclick away from
   * being wasted, and the charge takes four minutes to get back.
   */
  function armStrike(building) {
    if (!building || !superweaponReady(building)) {
      notify('The Lance is still charging.');
      return;
    }
    cancelPlacement();
    disarmAbility();
    strikeEmitter = building;
    renderer.state.strikeAim = { radius: building.def.superweapon.radius };
    notify(`${building.def.superweapon.name} armed — pick a target.`);
  }

  function cancelStrike() {
    strikeEmitter = null;
    renderer.state.strikeAim = null;
  }

  function disarmAbility() {
    abilityArmed = false;
    armedSlot = CHASSIS_SLOT;
    renderer.state.abilityAim = null;
  }

  function fireStrike(wx, wy) {
    if (!strikeEmitter) return;
    // Firing into unexplored ground would be a free map-wide snipe; the Lance
    // can only hit what you have actually found.
    if (!isExplored(world, viewerId, wx, wy)) {
      notify('You cannot call a strike on ground you have never seen.');
      return;
    }
    emit({
      type: 'superweapon',
      player: viewerId,
      buildingId: strikeEmitter.id,
      x: wx,
      y: wy,
    });
    cancelStrike();
  }

  /* -------------------------------------------------------- placement -- */

  function beginPlacement(defId) {
    const def = BUILDINGS[defId];
    if (!def) return;
    if (!techAllows(world, viewerId, defId)) {
      notify(`${def.name} needs ${(def.requires || ['more tech']).join(', ')}.`);
      return;
    }
    if (!canAfford(world.players[viewerId], def.cost)) {
      notify(`Not enough scrap for ${def.name}.`);
      return;
    }
    placementDefId = defId;
    updatePlacementPreview();
  }

  function cancelPlacement() {
    placementDefId = null;
    renderer.state.placement = null;
  }

  function updatePlacementPreview() {
    if (!placementDefId) {
      renderer.state.placement = null;
      return;
    }
    const def = BUILDINGS[placementDefId];
    const w = renderer.screenToWorld(pointer.x, pointer.y);
    // Centre the footprint on the cursor; anchoring at a corner makes large
    // structures feel like they are being dragged by one edge.
    const cx = Math.round(w.x - def.size[0] / 2);
    const cy = Math.round(w.y - def.size[1] / 2);

    renderer.state.placement = {
      defId: placementDefId,
      cx,
      cy,
      legal:
        canPlace(world.map, def.size, cx, cy) &&
        withinBuildRadius(world, viewerId, def.size, cx, cy) &&
        canAfford(world.players[viewerId], def.cost),
    };
  }

  function confirmPlacement() {
    const p = renderer.state.placement;
    if (!p) return;
    if (!p.legal) {
      notify('Cannot build there.');
      return;
    }
    emit({ type: 'build', player: viewerId, defId: p.defId, cx: p.cx, cy: p.cy });
    // Shift keeps the tool armed for laying down a row of turrets.
    if (!keys.has('shift')) cancelPlacement();
  }

  /* ----------------------------------------------------- mouse events -- */

  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  canvas.addEventListener('mousedown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    if (ev.button === 0) {
      if (strikeEmitter) {
        const w = renderer.screenToWorld(x, y);
        fireStrike(w.x, w.y);
        return;
      }
      if (abilityArmed) {
        const w = renderer.screenToWorld(x, y);
        triggerAbility(w.x, w.y);
        return;
      }
      if (placementDefId) {
        confirmPlacement();
        return;
      }
      drag.active = true;
      drag.moved = false;
      drag.x0 = drag.x1 = x;
      drag.y0 = drag.y1 = y;
    } else if (ev.button === 1) {
      // Middle-button grab: drag the world under the cursor. Edge scrolling
      // gets you across the map and the minimap jumps you anywhere, but
      // neither is any good for the small, precise "shift the view two
      // buildings left" that happens constantly while placing structures.
      ev.preventDefault();
      pan.active = true;
      pan.x = x;
      pan.y = y;
      cameraFreed = true;
    } else if (ev.button === 2) {
      if (placementDefId || abilityArmed || strikeEmitter) {
        cancelPlacement();
        cancelStrike();
        disarmAbility();
        return;
      }
      const w = renderer.screenToWorld(x, y);
      issueOrder(w.x, w.y, ev.shiftKey);
    }
  });

  canvas.addEventListener('mousemove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ev.clientX - rect.left;
    pointer.y = ev.clientY - rect.top;
    pointer.inside = true;
    renderer.state.hoverPixel.x = pointer.x;
    renderer.state.hoverPixel.y = pointer.y;

    if (pan.active) {
      // Drag the world, not the camera: the cell under the cursor stays under
      // the cursor, which is the only grab that feels like grabbing.
      const scale = renderer.scale();
      renderer.camera.x -= (pointer.x - pan.x) / scale;
      renderer.camera.y -= (pointer.y - pan.y) / scale;
      pan.x = pointer.x;
      pan.y = pointer.y;
      renderer.clampCamera();
    }

    if (drag.active) {
      drag.x1 = pointer.x;
      drag.y1 = pointer.y;
      if (Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 5) drag.moved = true;
      renderer.state.selectionBox = drag.moved
        ? { x0: drag.x0, y0: drag.y0, x1: drag.x1, y1: drag.y1 }
        : null;
    }

    if (placementDefId) updatePlacementPreview();
  });

  canvas.addEventListener('auxclick', (ev) => {
    if (ev.button === 1) ev.preventDefault();
  });

  canvas.addEventListener('mouseleave', () => {
    pointer.inside = false;
    pan.active = false;
  });

  window.addEventListener('mouseup', (ev) => {
    if (ev.button === 1) pan.active = false;
    if (ev.button !== 0 || !drag.active) return;
    drag.active = false;
    renderer.state.selectionBox = null;

    if (drag.moved) {
      boxSelect(drag.x0, drag.y0, drag.x1, drag.y1, ev.shiftKey);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const w = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
    const hit = entityAt(w.x, w.y);
    if (hit && mine(hit) && ev.detail >= 2 && hit.kind === 'unit') selectSameType(hit);
    else selectSingle(hit && (mine(hit) || renderer.seenBy(hit)) ? hit : null, ev.shiftKey);
  });

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      renderer.zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    },
    { passive: false }
  );


  /* ------------------------------------------------------------ touch -- */

  /**
   * Touch control.
   *
   * An RTS built for drag-select and right-click has *no* working input on a
   * phone, so this is a second scheme rather than a translation of the first.
   * The grammar it settles on is the one every touch strategy game has
   * converged on, because it is the only one that leaves the map draggable:
   *
   *   drag           pan the camera — always, on any part of the field
   *   two fingers    pinch to zoom
   *   tap a machine  select it
   *   tap the ground move there (or attack what you tapped)
   *   long press     attack-move, the deliberate version of the above
   *
   * The distinction that makes it work is drag-versus-tap, decided by
   * distance and time rather than by mode: below TAP_SLOP pixels and
   * TAP_MS milliseconds it was a tap, otherwise the camera moved and nothing
   * is ordered. Without that, every attempt to look around issues a move
   * order to wherever your thumb lifted.
   */
  const TAP_SLOP = 12;
  const TAP_MS = 320;
  const LONG_PRESS_MS = 420;

  const touch = {
    /** Live pointers, by pointerId. */
    points: new Map(),
    startX: 0,
    startY: 0,
    startAt: 0,
    moved: false,
    /** Camera position when the drag began, so panning is absolute. */
    camX: 0,
    camY: 0,
    pinchDist: 0,
    pinchZoom: 1,
    longPress: null,
    /** True once a gesture has been claimed by pan/pinch and cannot be a tap. */
    consumed: false,
  };

  /** Is this a touch device? Decides whether the on-screen controls exist. */
  const isTouch =
    typeof window !== 'undefined' &&
    (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);

  function localPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function cancelLongPress() {
    if (touch.longPress) {
      clearTimeout(touch.longPress);
      touch.longPress = null;
    }
  }

  canvas.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.pointerType === 'mouse') return; // the mouse path already works
      canvas.setPointerCapture(ev.pointerId);
      const p = localPoint(ev);
      touch.points.set(ev.pointerId, p);

      if (touch.points.size === 1) {
        touch.startX = p.x;
        touch.startY = p.y;
        touch.startAt = performance.now();
        touch.moved = false;
        touch.consumed = false;
        touch.camX = renderer.camera.x;
        touch.camY = renderer.camera.y;
        renderer.state.hoverPixel.x = p.x;
        renderer.state.hoverPixel.y = p.y;

        // Long press is the deliberate order: attack-move, which is what a
        // player actually wants when sending an army somewhere contested.
        cancelLongPress();
        touch.longPress = setTimeout(() => {
          if (touch.moved || touch.points.size !== 1) return;
          touch.consumed = true;
          const w = renderer.screenToWorld(p.x, p.y);
          issueAttackMove(w.x, w.y, false);
          notify('Attack-move ordered.');
        }, LONG_PRESS_MS);
      } else if (touch.points.size === 2) {
        // A second finger turns the gesture into a pinch, and cancels
        // whatever the first was about to do.
        cancelLongPress();
        touch.consumed = true;
        const [a, b] = [...touch.points.values()];
        touch.pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        touch.pinchZoom = renderer.camera.zoom;
      }
    },
    { passive: false }
  );

  canvas.addEventListener(
    'pointermove',
    (ev) => {
      if (ev.pointerType === 'mouse') return;
      if (!touch.points.has(ev.pointerId)) return;
      const p = localPoint(ev);
      touch.points.set(ev.pointerId, p);
      renderer.state.hoverPixel.x = p.x;
      renderer.state.hoverPixel.y = p.y;

      if (touch.points.size >= 2) {
        const [a, b] = [...touch.points.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        // Zoom about the midpoint, so the map grows out from between the
        // fingers rather than from the middle of the screen.
        const before = renderer.screenToWorld(midX, midY);
        renderer.camera.zoom = Math.max(
          renderer.camera.minZoom,
          Math.min(renderer.camera.maxZoom, touch.pinchZoom * (dist / touch.pinchDist))
        );
        const after = renderer.screenToWorld(midX, midY);
        renderer.camera.x += before.x - after.x;
        renderer.camera.y += before.y - after.y;
        renderer.clampCamera();
        return;
      }

      const dx = p.x - touch.startX;
      const dy = p.y - touch.startY;
      if (!touch.moved && Math.hypot(dx, dy) > TAP_SLOP) {
        touch.moved = true;
        cancelLongPress();
      }
      if (!touch.moved) return;

      if (placementDefId) {
        // Siting a structure: the finger is the cursor, not the camera.
        updatePlacementPreview();
        return;
      }

      // Looking around releases the camera from the cockpit until the player
      // drives again.
      cameraFreed = true;

      // Drag the world under the finger. Absolute from the gesture's start,
      // so a slow drag does not accumulate rounding drift.
      const s = renderer.scale();
      renderer.camera.x = touch.camX - dx / s;
      renderer.camera.y = touch.camY - dy / s;
      renderer.clampCamera();
    },
    { passive: false }
  );

  function endTouch(ev) {
    if (ev.pointerType === 'mouse') return;
    const p = touch.points.get(ev.pointerId);
    touch.points.delete(ev.pointerId);
    cancelLongPress();
    if (!p) return;

    const wasTap =
      !touch.moved &&
      !touch.consumed &&
      touch.points.size === 0 &&
      performance.now() - touch.startAt < TAP_MS;
    if (!wasTap) return;

    const w = renderer.screenToWorld(p.x, p.y);

    // Aiming modes consume the tap outright.
    if (strikeEmitter) {
      fireStrike(w.x, w.y);
      return;
    }
    if (abilityArmed) {
      triggerAbility(w.x, w.y);
      return;
    }
    if (placementDefId) {
      confirmPlacement();
      return;
    }
    if (attackMoveArmed) {
      issueAttackMove(w.x, w.y, false);
      return;
    }

    // A tap on one of ours selects it; a tap on anything else is an order for
    // whatever is already selected. That ordering matters: it means tapping
    // your own machine never accidentally walks your army into it.
    const hit = entityAt(w.x, w.y);
    if (hit && mine(hit) && hit.kind !== 'prop') {
      selectSingle(hit, false);
      return;
    }
    if (selection.size > 0) {
      issueOrder(w.x, w.y, false);
      return;
    }
    selectSingle(hit && renderer.seenBy(hit) ? hit : null, false);
  }

  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', (ev) => {
    touch.points.delete(ev.pointerId);
    cancelLongPress();
  });

  /* --------------------------------------------------------- thumbstick -- */

  /**
   * Analogue stick for direct control.
   *
   * Emits the same eight-way `steer` command the arrow keys do rather than a
   * continuous vector: the engine takes integer intent so that a replay
   * recorded on a phone and one recorded on a laptop are the same file, and
   * so a thumb resting a few degrees off-axis does not produce a different
   * simulation than a keyboard would.
   */
  function attachStick(stickEl, nubEl) {
    if (!stickEl) return;
    let active = null;
    const radius = 42;

    const setNub = (dx, dy) => {
      nubEl.style.transform = `translate(${dx}px, ${dy}px)`;
    };

    const update = (ev) => {
      const rect = stickEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = ev.clientX - cx;
      let dy = ev.clientY - cy;
      const mag = Math.hypot(dx, dy);
      if (mag > radius) {
        dx = (dx / mag) * radius;
        dy = (dy / mag) * radius;
      }
      setNub(dx, dy);

      // Dead zone, then quantise to the eight directions the keyboard has.
      if (mag < 12) {
        steerTo(0, 0);
        return;
      }
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const sx = ax > mag * 0.38 ? Math.sign(dx) : 0;
      const sy = ay > mag * 0.38 ? Math.sign(dy) : 0;
      steerTo(sx, sy);
    };

    stickEl.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      active = ev.pointerId;
      stickEl.setPointerCapture(ev.pointerId);
      if (!driving) setDriving(true);
      update(ev);
    });
    stickEl.addEventListener('pointermove', (ev) => {
      if (active !== ev.pointerId) return;
      ev.preventDefault();
      update(ev);
    });
    const release = (ev) => {
      if (active !== ev.pointerId) return;
      active = null;
      setNub(0, 0);
      steerTo(0, 0);
    };
    stickEl.addEventListener('pointerup', release);
    stickEl.addEventListener('pointercancel', release);
  }

  /** Send a steer vector, but only when it actually changed. */
  function steerTo(dx, dy) {
    if (!driving) return;
    const unit = drivenEntity();
    if (!unit) return;
    // Driving again re-acquires the camera.
    if (dx !== 0 || dy !== 0) cameraFreed = false;
    if (dx === steerX && dy === steerY) return;
    steerX = dx;
    steerY = dy;
    emit({ type: 'steer', player: viewerId, ids: [unit.id], dx, dy });
  }

  /* -------------------------------------------------- keyboard events -- */

  const HOTKEY_TO_BUILDING = {};
  for (const id of BUILD_ORDER) {
    if (BUILD_HOTKEYS[id]) HOTKEY_TO_BUILDING[BUILD_HOTKEYS[id]] = id;
  }

  /**
   * Last control group recalled, and when — for the double-tap.
   *
   * Tapping a group's digit twice snaps the camera to it, which is how every
   * player of these games navigates: groups are not just a selection, they
   * are *places*. On a map this size that is the difference between knowing
   * where your army is and hunting for it on the minimap.
   */
  /** Which idle collector `e` landed on last, so a second press moves on. */
  let lastIdleId = null;

  let lastGroupKey = null;
  let lastGroupAt = 0;
  const GROUP_DOUBLE_TAP_MS = 400;

  window.addEventListener('keydown', (ev) => {
    const key = ev.key.toLowerCase();
    keys.add(key === ' ' ? 'space' : key);
    if (ev.shiftKey) keys.add('shift');

    if (ev.target && ev.target.tagName === 'INPUT') return;

    // Direct control claims WASD while it is engaged, so `a` steers left
    // instead of issuing an attack-move. Both meanings cannot be live at
    // once; the HUD shows which mode you are in. The arrows are never in
    // this fight -- they pan the camera in either mode.
    if (driving && STEER_KEYS[key]) {
      ev.preventDefault();
      updateSteering();
      return;
    }
    if (key === 'c') {
      toggleDriving();
      return;
    }

    // Control groups, and nothing else. Ctrl assigns, Shift adds to the
    // group, a bare digit recalls it, and a second tap goes there.
    if (/^[0-9]$/.test(key)) {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        groups.set(key, [...selection]);
        notify(`Group ${key} set (${selection.size}).`);
        return;
      }

      if (ev.shiftKey) {
        // Add the current selection to the group rather than replacing it —
        // how you reinforce a standing army without re-boxing the whole thing.
        const merged = new Set(groups.get(key) || []);
        for (const id of selection) merged.add(id);
        groups.set(key, [...merged]);
        notify(`Group ${key} now ${merged.size}.`);
        return;
      }

      if (!groups.has(key)) return;

      const live = groups.get(key).filter((id) => {
        const e = world.entities.get(id);
        return e && !e.dead;
      });
      if (live.length === 0) {
        notify(`Group ${key} is gone.`);
        return;
      }
      // Prune casualties as we go, so a group does not slowly become a list
      // of ghosts that quietly shrinks what a recall selects.
      groups.set(key, live);

      const now = performance.now();
      const again = key === lastGroupKey && now - lastGroupAt < GROUP_DOUBLE_TAP_MS;
      lastGroupKey = key;
      lastGroupAt = now;

      selection.clear();
      for (const id of live) selection.add(id);
      announceSelection();

      if (again) {
        let x = 0;
        let y = 0;
        for (const id of live) {
          const e = world.entities.get(id);
          x += e.x;
          y += e.y;
        }
        cameraFreed = false;
        renderer.centreOn(x / live.length, y / live.length);
      }
      return;
    }

    // Construction, on letters. Gated on having something that builds
    // selected, so they are inert the rest of the time.
    if (HOTKEY_TO_BUILDING[key] && hasHQSelected()) {
      beginPlacement(HOTKEY_TO_BUILDING[key]);
      return;
    }

    switch (key) {
      case 'escape':
        cancelPlacement();
        cancelStrike();
        disarmAbility();
        setDriving(false);
        break;
      case 'a': {
        const w = renderer.screenToWorld(pointer.x, pointer.y);
        issueAttackMove(w.x, w.y, ev.shiftKey);
        break;
      }
      case 's':
        emit({ type: 'stop', player: viewerId, ids: [...selection] });
        break;
      case 'h':
        emit({ type: 'hold', player: viewerId, ids: [...selection] });
        break;
      case 'f':
        useAbility(CHASSIS_SLOT);
        break;
      case 'g':
        useAbility(HERO_SLOT);
        break;
      case 'e': {
        // Cycle the idle collectors, not just jump to the first one.
        //
        // Pressing it twice used to land on the same machine, because "find
        // the first idle" is stable — so with three sitting around you could
        // only ever see one of them. Age of Empires walks the list, and that
        // is the difference between a key that reports a problem and a key
        // that lets you fix all of it.
        const idle = [...world.entities.values()]
          .filter((e) => mine(e) && e.harvest && e.harvest.state === 'idle')
          .sort((a, b) => a.id - b.id);
        if (idle.length === 0) {
          notify('No idle collectors.');
          break;
        }
        const at = idle.findIndex((e) => e.id === lastIdleId);
        const next = idle[(at + 1) % idle.length];
        lastIdleId = next.id;
        focusOn(next);
        if (idle.length > 1) notify(`${idle.length} collectors idle.`);
        break;
      }
      case 'f2': {
        // Select the whole army and frame it — the one key every player of
        // these games reaches for when a fight starts somewhere else.
        ev.preventDefault();
        const n = selectAllUnits();
        notify(n ? `${n} machine${n === 1 ? '' : 's'} selected` : 'Nothing to select');
        break;
      }
      case 'b': {
        const hq = [...world.entities.values()].find((e) => mine(e) && e.defId === 'command');
        if (hq) {
          selectSingle(hq, false);
          renderer.centreOn(hq.x, hq.y);
        }
        break;
      }
      case 'tab': {
        ev.preventDefault();
        cycleArmy();
        break;
      }
      default:
        break;
    }
  });

  window.addEventListener('keyup', (ev) => {
    const key = ev.key.toLowerCase();
    keys.delete(key === ' ' ? 'space' : key);
    if (!ev.shiftKey) keys.delete('shift');
    if (driving && STEER_KEYS[key]) updateSteering();
  });

  // Losing focus must stop the machine. Otherwise switching tabs mid-drive
  // leaves a key logically held and your pilot walks into the enemy base.
  window.addEventListener('blur', () => {
    keys.clear();
    updateSteering();
  });

  function hasHQSelected() {
    return selectedEntities().some((e) => e.def.builds === 'buildings');
  }

  function cycleArmy() {
    const army = [...world.entities.values()].filter(
      (e) => mine(e) && e.kind === 'unit' && !e.harvest
    );
    if (army.length === 0) return;
    const current = [...selection][0];
    const at = army.findIndex((e) => e.id === current);
    const next = army[(at + 1) % army.length];
    selectSingle(next, false);
    renderer.centreOn(next.x, next.y);
  }

  /* ------------------------------------------------------ camera pan -- */

  function updateCamera(dt) {
    // While driving, main.js locks the camera to the machine instead. Edge
    // scrolling is still allowed below, so you can glance around mid-fight.
    const speed = (PAN_SPEED * dt) / renderer.camera.zoom;
    let dx = 0;
    let dy = 0;

    // Arrows, whether or not you are driving. WASD is not a pan key: `a` is
    // attack-move and `s` is stop, and one key must not mean two things.
    for (const key of Object.keys(PAN_KEYS)) {
      if (!keys.has(key)) continue;
      dx += PAN_KEYS[key][0];
      dy += PAN_KEYS[key][1];
    }
    // Pressing an arrow is an unambiguous "look somewhere else", so it
    // releases the camera from the machine it was following until you drive
    // again.
    //
    // Edge scrolling deliberately does *not*: a pointer resting near a screen
    // edge is not a decision, and treating it as one means an idle mouse can
    // quietly unlock the camera mid-fight and leave the player wondering why
    // their pilot walked off the screen.
    if (dx || dy) cameraFreed = true;

    if (pointer.inside) {
      if (pointer.x < EDGE_MARGIN) dx -= 1;
      if (pointer.x > renderer.viewWidth() - EDGE_MARGIN) dx += 1;
      if (pointer.y < EDGE_MARGIN) dy -= 1;
      if (pointer.y > renderer.viewHeight() - EDGE_MARGIN) dy += 1;
    }

    if (dx || dy) {
      renderer.camera.x += dx * speed;
      renderer.camera.y += dy * speed;
      renderer.clampCamera();
      if (placementDefId) updatePlacementPreview();
    }
  }

  /* --------------------------------------------------------- minimap -- */

  function attachMinimap(minimapCanvas) {
    const toWorld = (ev) => {
      const rect = minimapCanvas.getBoundingClientRect();
      return {
        x: ((ev.clientX - rect.left) / rect.width) * world.map.width,
        y: ((ev.clientY - rect.top) / rect.height) * world.map.height,
      };
    };

    minimapCanvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    minimapCanvas.addEventListener('mousedown', (ev) => {
      const w = toWorld(ev);
      if (ev.button === 0) renderer.centreOn(w.x, w.y);
      else if (ev.button === 2) issueOrder(w.x, w.y, ev.shiftKey);
    });
  }

  /** Drain the queued commands for this tick. */
  function takeCommands() {
    const out = commands.splice(0, commands.length);
    return out;
  }

  return {
    selection,
    selectedEntities,
    pruneSelection,
    takeCommands,
    updateCamera,
    attachMinimap,
    beginPlacement,
    cancelPlacement,
    armStrike,
    cancelStrike,
    useAbility,
    selectAllUnits,
    selectByDefId,
    focusOn,
    sellSelected: (ids) => emit({ type: 'sell', player: viewerId, ids }),
    toggleRepair: (ids, on) => emit({ type: 'repair', player: viewerId, ids, on }),
    selectSingle,
    emit,
    updateSteering,
    drivenEntity,
    attachStick,
    drivableUnit: pickDrivable,
    armAttackMove,
    isTouch,
    setDriving,
    toggleDriving,
    get driving() {
      return driving;
    },
    /** Should the camera stay locked to the driven machine this frame? */
    get cameraFollows() {
      return driving && !cameraFreed;
    },
    get placementDefId() {
      return placementDefId;
    },
    get abilityArmed() {
      return abilityArmed;
    },
    get strikeArmed() {
      return !!strikeEmitter;
    },
  };
}

export { UNITS, BUILDINGS, BUILD_ORDER, CELL };
