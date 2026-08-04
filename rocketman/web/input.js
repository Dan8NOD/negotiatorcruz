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

import { CELL, BUILDINGS, UNITS, BUILD_ORDER } from '../engine/content.js';
import { canPlace } from '../engine/grid.js';
import { withinBuildRadius } from '../engine/sim.js';
import { isExplored } from '../engine/vision.js';
import { techAllows, canAfford } from '../engine/economy.js';
import { abilityReady } from '../engine/abilities.js';
import { superweaponReady } from '../engine/economy.js';

/** Camera pan speed in cells per second. */
const PAN_SPEED = 26;
const EDGE_MARGIN = 18;

/**
 * Keys that drive a machine while direct control is engaged, as eight-way
 * intent. Arrows and WASD both work; holding two gives the diagonal.
 *
 * These overlap the RTS hotkeys on purpose — `a` is attack-move and `s` is
 * stop when you are commanding, and steering when you are piloting. Only one
 * of those meanings is live at a time, and the HUD says which.
 */
const STEER_KEYS = {
  arrowup: [0, -1],
  w: [0, -1],
  arrowdown: [0, 1],
  s: [0, 1],
  arrowleft: [-1, 0],
  a: [-1, 0],
  arrowright: [1, 0],
  d: [1, 0],
};

export function createInput(canvas, world, viewerId, renderer, hooks = {}) {
  const selection = new Set();
  const commands = [];
  const groups = new Map();
  const keys = new Set();

  const drag = { active: false, x0: 0, y0: 0, x1: 0, y1: 0, moved: false };
  const pointer = { x: 0, y: 0, inside: false };
  let placementDefId = null;
  /** True while the player is picking a target for a targeted ability. */
  let abilityArmed = false;
  /** The Lance whose strike is currently being aimed, if any. */
  let strikeEmitter = null;

  /** Direct control: driving one machine from the keyboard. */
  let driving = false;
  let drivenId = null;
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
    abilityArmed = false;
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

  function issueAttackMove(wx, wy, queued) {
    setDriving(false);
    const ids = selectedEntities()
      .filter((e) => mine(e) && e.kind === 'unit' && !e.harvest)
      .map((e) => e.id);
    if (ids.length === 0) return;
    emit({ type: 'attackMove', player: viewerId, ids, x: wx, y: wy, queue: queued });
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
    } else {
      const unit = pickDrivable();
      if (!unit) {
        notify('Select a machine to take direct control of it.');
        return;
      }
      cancelPlacement();
      cancelStrike();
      abilityArmed = false;
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
    steerX = dx;
    steerY = dy;
    emit({ type: 'steer', player: viewerId, ids: [unit.id], dx, dy });
  }

  /* -------------------------------------------------------- abilities -- */

  /** Units in the selection that have an ability off cooldown. */
  function readyAbilityUnits() {
    return selectedEntities().filter((e) => e.ability && abilityReady(world, e));
  }

  function triggerAbility(wx, wy) {
    const units = readyAbilityUnits();
    if (units.length === 0) {
      notify('No ability ready.');
      return false;
    }
    emit({
      type: 'ability',
      player: viewerId,
      ids: units.map((e) => e.id),
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
  function useAbility() {
    const units = readyAbilityUnits();
    if (units.length === 0) {
      notify('No ability ready.');
      return;
    }
    const needsTarget = units.some((e) => e.ability.def.targeted);
    if (needsTarget) {
      abilityArmed = true;
      notify(`${units[0].ability.def.name}: pick a target point.`);
    } else {
      triggerAbility(units[0].x, units[0].y);
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
    abilityArmed = false;
    strikeEmitter = building;
    renderer.state.strikeAim = { radius: building.def.superweapon.radius };
    notify(`${building.def.superweapon.name} armed — pick a target.`);
  }

  function cancelStrike() {
    strikeEmitter = null;
    renderer.state.strikeAim = null;
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
    } else if (ev.button === 2) {
      if (placementDefId || abilityArmed || strikeEmitter) {
        cancelPlacement();
        cancelStrike();
        abilityArmed = false;
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

  canvas.addEventListener('mouseleave', () => {
    pointer.inside = false;
  });

  window.addEventListener('mouseup', (ev) => {
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

  /* -------------------------------------------------- keyboard events -- */

  const HOTKEY_TO_BUILDING = {};
  BUILD_ORDER.forEach((id, i) => {
    HOTKEY_TO_BUILDING[String(i + 1)] = id;
  });

  window.addEventListener('keydown', (ev) => {
    const key = ev.key.toLowerCase();
    keys.add(key === ' ' ? 'space' : key);
    if (ev.shiftKey) keys.add('shift');

    if (ev.target && ev.target.tagName === 'INPUT') return;

    // Direct control claims the movement keys while it is engaged, so `a`
    // steers left instead of issuing an attack-move. Both meanings cannot be
    // live at once; the HUD shows which mode you are in.
    if (driving && STEER_KEYS[key]) {
      ev.preventDefault();
      updateSteering();
      return;
    }
    if (key === 'c') {
      toggleDriving();
      return;
    }

    // Control groups: Ctrl+digit assigns, digit recalls.
    if (/^[0-9]$/.test(key)) {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        groups.set(key, [...selection]);
        notify(`Group ${key} set (${selection.size}).`);
      } else if (groups.has(key)) {
        selection.clear();
        for (const id of groups.get(key)) {
          const e = world.entities.get(id);
          if (e && !e.dead) selection.add(id);
        }
        announceSelection();
      } else if (HOTKEY_TO_BUILDING[key] && hasHQSelected()) {
        beginPlacement(HOTKEY_TO_BUILDING[key]);
      }
      return;
    }

    switch (key) {
      case 'escape':
        cancelPlacement();
        cancelStrike();
        abilityArmed = false;
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
        useAbility();
        break;
      case 'e': {
        // Jump to the next idle collector — the single most useful key in any
        // RTS and the one most often missing.
        const idle = [...world.entities.values()].find(
          (e) => mine(e) && e.harvest && e.harvest.state === 'idle'
        );
        if (idle) {
          selectSingle(idle, false);
          renderer.centreOn(idle.x, idle.y);
        } else {
          notify('No idle collectors.');
        }
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

    // Arrows only. WASD used to pan as well, which meant pressing `a` for
    // attack-move *also* slid the camera left — two commands from one key.
    if (!driving) {
      if (keys.has('arrowleft')) dx -= 1;
      if (keys.has('arrowright')) dx += 1;
      if (keys.has('arrowup')) dy -= 1;
      if (keys.has('arrowdown')) dy += 1;
    }

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
    sellSelected: (ids) => emit({ type: 'sell', player: viewerId, ids }),
    toggleRepair: (ids, on) => emit({ type: 'repair', player: viewerId, ids, on }),
    selectSingle,
    emit,
    updateSteering,
    drivenEntity,
    setDriving,
    toggleDriving,
    get driving() {
      return driving;
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
