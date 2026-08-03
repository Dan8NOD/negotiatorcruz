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
import { techAllows, canAfford } from '../engine/economy.js';
import { abilityReady } from '../engine/abilities.js';

/** Camera pan speed in cells per second. */
const PAN_SPEED = 26;
const EDGE_MARGIN = 18;

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
    abilityArmed = false;
    if (hooks.onSelectionChange) hooks.onSelectionChange(selectedEntities());
  }

  /* --------------------------------------------------------- ordering -- */

  function issueOrder(wx, wy, queued) {
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
    const ids = selectedEntities()
      .filter((e) => mine(e) && e.kind === 'unit' && !e.harvest)
      .map((e) => e.id);
    if (ids.length === 0) return;
    emit({ type: 'attackMove', player: viewerId, ids, x: wx, y: wy, queue: queued });
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
      if (placementDefId || abilityArmed) {
        cancelPlacement();
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
        abilityArmed = false;
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
  });

  window.addEventListener('blur', () => keys.clear());

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
    const speed = (PAN_SPEED * dt) / renderer.camera.zoom;
    let dx = 0;
    let dy = 0;

    if (keys.has('arrowleft') || keys.has('a')) dx -= 1;
    if (keys.has('arrowright') || keys.has('d')) dx += 1;
    if (keys.has('arrowup') || keys.has('w')) dy -= 1;
    if (keys.has('arrowdown')) dy += 1;
    // 's' is the stop hotkey, so it does not double as pan-down.

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
    useAbility,
    selectSingle,
    emit,
    get placementDefId() {
      return placementDefId;
    },
    get abilityArmed() {
      return abilityArmed;
    },
  };
}

export { UNITS, BUILDINGS, BUILD_ORDER, CELL };
