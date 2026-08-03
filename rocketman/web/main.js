/**
 * Boot, game loop and HUD.
 *
 * The loop is a fixed-timestep accumulator: the simulation only ever advances
 * in whole 50ms ticks, and the renderer interpolates between them. Rendering
 * and simulation are deliberately decoupled — a dropped frame must never
 * change the outcome of a match, or none of the determinism guarantees in
 * engine/ mean anything once there is a real player attached.
 */

import { createWorld, tick } from '../engine/sim.js';
import { updateAI, DIFFICULTIES } from '../engine/ai.js';
import {
  FACTIONS,
  UNITS,
  BUILDINGS,
  BUILD_ORDER,
  TICKS_PER_SECOND,
  ABILITIES,
} from '../engine/content.js';
import { techAllows, availableBuildings } from '../engine/economy.js';
import { abilityReady } from '../engine/abilities.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';

const MS_PER_TICK = 1000 / TICKS_PER_SECOND;
const VIEWER = 0;

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ menu -- */

function boot() {
  const menu = $('menu');
  const factionList = $('factionList');

  let chosenFaction = 'ascendancy';

  for (const faction of Object.values(FACTIONS)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'faction';
    card.dataset.faction = faction.id;
    card.style.setProperty('--faction', faction.color);
    card.innerHTML = `
      <h3>${faction.name}</h3>
      <p>${faction.blurb}</p>
      <ul>${faction.units
        .map((u) => `<li><b>${UNITS[u].name}</b> — ${UNITS[u].hint}</li>`)
        .join('')}</ul>`;
    card.addEventListener('click', () => {
      chosenFaction = faction.id;
      for (const el of factionList.children) el.classList.toggle('on', el === card);
    });
    factionList.appendChild(card);
  }
  factionList.firstElementChild.classList.add('on');

  const difficulty = $('difficulty');
  for (const [id, profile] of Object.entries(DIFFICULTIES)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = profile.label;
    if (id === 'normal') option.selected = true;
    difficulty.appendChild(option);
  }

  $('seed').value = String(Math.floor(Math.random() * 100000));

  $('start').addEventListener('click', () => {
    const seed = parseInt($('seed').value, 10) || 1;
    const enemyFaction = chosenFaction === 'ascendancy' ? 'bulwark' : 'ascendancy';
    menu.hidden = true;
    $('game').hidden = false;
    startMatch({ seed, faction: chosenFaction, enemyFaction, difficulty: difficulty.value });
  });
}

/* ------------------------------------------------------------------ game -- */

function startMatch({ seed, faction, enemyFaction, difficulty }) {
  const world = createWorld({
    seed,
    players: [
      { faction, name: 'You' },
      { faction: enemyFaction, isAI: true, difficulty },
    ],
  });

  const canvas = $('view');
  const minimap = $('minimap');
  const renderer = createRenderer(canvas, world, VIEWER);
  const input = createInput(canvas, world, VIEWER, renderer, {
    onMessage: toast,
    onSelectionChange: () => renderHud(),
  });
  input.attachMinimap(minimap);

  renderer.resize();
  window.addEventListener('resize', () => renderer.resize());

  // Open looking at your own base, close enough to read individual chassis.
  // Starting at 1:1 shows most of a 72-cell map at once, which is accurate and
  // completely useless — the first thing a player needs to see is their base.
  const start = world.map.starts[VIEWER];
  renderer.camera.zoom = 1.6;
  renderer.centreOn(start.x, start.y);

  const clock = { accumulator: 0, last: performance.now(), paused: false, speed: 1 };

  window.addEventListener('keydown', (ev) => {
    if (ev.target && ev.target.tagName === 'INPUT') return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      clock.paused = !clock.paused;
      toast(clock.paused ? 'Paused' : 'Resumed');
    } else if (ev.key === '+' || ev.key === '=') {
      clock.speed = Math.min(4, clock.speed * 2);
      toast(`Speed ×${clock.speed}`);
    } else if (ev.key === '-') {
      clock.speed = Math.max(0.5, clock.speed / 2);
      toast(`Speed ×${clock.speed}`);
    }
  });

  function frame(now) {
    const elapsed = Math.min(250, now - clock.last);
    clock.last = now;

    if (!clock.paused && !world.over) {
      clock.accumulator += elapsed * clock.speed;
      // Cap catch-up so a backgrounded tab does not fast-forward the match on
      // its way back.
      let budget = 8;
      while (clock.accumulator >= MS_PER_TICK && budget-- > 0) {
        clock.accumulator -= MS_PER_TICK;
        stepOnce();
      }
      if (clock.accumulator > MS_PER_TICK * 8) clock.accumulator = 0;
    }

    renderer.state.alpha = Math.min(1, clock.accumulator / MS_PER_TICK);
    renderer.stepSparks();
    renderer.draw(input.selection);
    renderer.drawMinimap(minimap);
    updateTopBar();

    requestAnimationFrame(frame);
  }

  function stepOnce() {
    const commands = input.takeCommands();
    for (const player of world.players) {
      if (player.isAI && !player.defeated) commands.push(...updateAI(world, player));
    }
    tick(world, commands);

    renderer.consumeEvents(world.events);
    input.pruneSelection();

    // The HUD only needs refreshing a few times a second; rebuilding DOM at
    // 20Hz is pure waste and makes buttons feel unclickable.
    if (world.tick % 5 === 0) renderHud();
    if (world.over) showResult();
  }

  requestAnimationFrame(frame);

  /**
   * Read-only inspection hook for the end-to-end suite.
   *
   * A canvas game is otherwise opaque to a browser test — there is no DOM to
   * assert against for "did the mech actually move". This returns a summary
   * and nothing that can write back, so it cannot become a gameplay side door.
   */
  window.__rocketman = () => ({
    tick: world.tick,
    over: world.over,
    winner: world.winner,
    selection: [...input.selection],
    players: world.players.map((p) => ({
      faction: p.faction,
      scrap: Math.round(p.scrap),
      mined: Math.round(p.scrapMined),
      powerMade: p.powerMade,
      powerUsed: p.powerUsed,
      tech: [...p.tech],
      killed: p.stats.killed,
      lost: p.stats.lost,
    })),
    counts: [...world.entities.values()].reduce((acc, e) => {
      const key = `${e.player}:${e.defId}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  });

  /* ------------------------------------------------------------- HUD -- */

  function updateTopBar() {
    const player = world.players[VIEWER];
    $('scrap').textContent = Math.floor(player.scrap).toLocaleString();

    const power = $('power');
    const headroom = player.powerMade - player.powerUsed;
    power.textContent = `${player.powerMade} / ${player.powerUsed}`;
    power.classList.toggle('warn', headroom < 0);

    const seconds = Math.floor(world.tick / TICKS_PER_SECOND);
    $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(
      seconds % 60
    ).padStart(2, '0')}`;
  }

  function renderHud() {
    renderSelection();
    renderCommands();
  }

  function renderSelection() {
    const panel = $('selection');
    const selected = input.selectedEntities();
    panel.innerHTML = '';

    if (selected.length === 0) {
      panel.innerHTML = '<p class="hint">Left-drag to select. Right-click to order.</p>';
      return;
    }

    if (selected.length === 1) {
      const e = selected[0];
      const card = document.createElement('div');
      card.className = 'detail';
      const shield =
        e.maxShield > 0
          ? `<div class="stat"><span>Shield</span><b>${Math.round(e.shield)} / ${e.maxShield}</b></div>`
          : '';
      const cargo = e.harvest
        ? `<div class="stat"><span>Cargo</span><b>${Math.round(e.cargo)} / ${e.def.capacity}</b></div>`
        : '';
      card.innerHTML = `
        <h4>${e.def.name}</h4>
        <div class="stat"><span>Hull</span><b>${Math.round(e.hp)} / ${e.maxHp}</b></div>
        ${shield}${cargo}
        <p class="hint">${e.def.hint || ''}</p>`;
      panel.appendChild(card);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'chips';
    for (const e of selected.slice(0, 24)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.title = e.def.name;
      chip.innerHTML = `<span>${e.def.name}</span>
        <i style="width:${Math.round((e.hp / e.maxHp) * 100)}%"></i>`;
      chip.addEventListener('click', () => {
        input.selectSingle(e, false);
        renderer.centreOn(e.x, e.y);
      });
      grid.appendChild(chip);
    }
    panel.appendChild(grid);
    if (selected.length > 24) {
      const more = document.createElement('p');
      more.className = 'hint';
      more.textContent = `+${selected.length - 24} more`;
      panel.appendChild(more);
    }
  }

  function renderCommands() {
    const panel = $('commands');
    panel.innerHTML = '';
    const player = world.players[VIEWER];
    const selected = input.selectedEntities();

    const hq = selected.find((e) => e.def.builds === 'buildings' && !e.constructing);
    const factory = selected.find((e) => e.def.builds === 'units' && !e.constructing);

    if (hq) {
      panel.appendChild(sectionTitle('Construct'));
      const row = document.createElement('div');
      row.className = 'buttons';
      const unlocked = new Set(availableBuildings(world, VIEWER));

      BUILD_ORDER.forEach((id, i) => {
        const def = BUILDINGS[id];
        const locked = !unlocked.has(id);
        const poor = player.scrap < def.cost;
        row.appendChild(
          commandButton({
            label: def.name,
            sub: `${def.cost} · ${def.power >= 0 ? '+' : ''}${def.power}⚡`,
            hint: def.hint,
            hotkey: String(i + 1),
            disabled: locked || poor,
            reason: locked ? 'Needs more tech' : poor ? 'Not enough scrap' : '',
            onClick: () => input.beginPlacement(id),
          })
        );
      });
      panel.appendChild(row);
    }

    if (factory) {
      panel.appendChild(sectionTitle(`${factory.def.name} — Production`));
      const row = document.createElement('div');
      row.className = 'buttons';

      const roster = ['collector', ...FACTIONS[player.faction].units];
      for (const id of roster) {
        const def = UNITS[id];
        if (def.builtAt !== factory.defId) continue;
        const allowed = techAllows(world, VIEWER, id);
        const poor = player.scrap < def.cost;
        row.appendChild(
          commandButton({
            label: def.name,
            sub: `${def.cost} · ${(def.buildTime / TICKS_PER_SECOND).toFixed(0)}s`,
            hint: def.hint,
            disabled: !allowed || poor,
            reason: !allowed ? 'Needs more tech' : poor ? 'Not enough scrap' : '',
            onClick: () =>
              input.emit({
                type: 'train',
                player: VIEWER,
                buildingId: factory.id,
                defId: id,
              }),
          })
        );
      }
      panel.appendChild(row);

      if (factory.queue.length > 0) {
        const queue = document.createElement('div');
        queue.className = 'queue';
        factory.queue.forEach((item, index) => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'queued';
          const progress = index === 0 ? 1 - item.remaining / item.total : 0;
          chip.innerHTML = `<span>${UNITS[item.defId].name}</span>
            <i style="width:${Math.round(progress * 100)}%"></i>`;
          chip.title = 'Click to cancel (full refund)';
          chip.addEventListener('click', () =>
            input.emit({ type: 'cancelTrain', player: VIEWER, buildingId: factory.id, index })
          );
          queue.appendChild(chip);
        });
        panel.appendChild(queue);
      }
    }

    // Ability button, shown whenever anything selected has one.
    const withAbility = selected.filter((e) => e.ability);
    if (withAbility.length > 0) {
      const def = withAbility[0].ability.def;
      const ready = withAbility.some((e) => abilityReady(world, e));
      const cooling = Math.max(...withAbility.map((e) => e.ability.cooldown));

      panel.appendChild(sectionTitle('Ability'));
      const row = document.createElement('div');
      row.className = 'buttons';
      row.appendChild(
        commandButton({
          label: def.name,
          sub: ready ? 'Ready' : `${Math.ceil(cooling / TICKS_PER_SECOND)}s`,
          hint: def.hint,
          hotkey: 'F',
          disabled: !ready,
          reason: 'On cooldown',
          highlight: ready,
          onClick: () => input.useAbility(),
        })
      );
      panel.appendChild(row);
    }

    if (panel.children.length === 0) {
      panel.innerHTML =
        '<p class="hint">Select the Command Rig to build, or a Foundry to make mechs.</p>';
    }
  }

  function showResult() {
    const overlay = $('result');
    if (!overlay.hidden) return;
    const won = world.winner === VIEWER;
    const player = world.players[VIEWER];

    overlay.hidden = false;
    overlay.innerHTML = `
      <div class="resultCard ${won ? 'won' : 'lost'}">
        <h2>${won ? 'Victory' : 'Defeat'}</h2>
        <div class="stat"><span>Time</span><b>${Math.floor(world.tick / TICKS_PER_SECOND / 60)}m ${
          Math.floor(world.tick / TICKS_PER_SECOND) % 60
        }s</b></div>
        <div class="stat"><span>Scrap mined</span><b>${Math.round(player.scrapMined).toLocaleString()}</b></div>
        <div class="stat"><span>Kills</span><b>${player.stats.killed}</b></div>
        <div class="stat"><span>Losses</span><b>${player.stats.lost}</b></div>
        <button type="button" id="again">Play again</button>
      </div>`;
    $('again').addEventListener('click', () => window.location.reload());
  }

  renderHud();
}

/* --------------------------------------------------------------- widgets -- */

function sectionTitle(text) {
  const h = document.createElement('h5');
  h.textContent = text;
  return h;
}

function commandButton({ label, sub, hint, hotkey, disabled, reason, highlight, onClick }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cmd';
  if (disabled) button.classList.add('off');
  if (highlight) button.classList.add('ready');
  button.disabled = !!disabled;
  button.title = disabled && reason ? `${hint}\n\n${reason}` : hint || '';
  button.innerHTML = `
    ${hotkey ? `<kbd>${hotkey}</kbd>` : ''}
    <strong>${label}</strong>
    <em>${sub}</em>`;
  if (!disabled) button.addEventListener('click', onClick);
  return button;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
}

boot();

export { boot, startMatch };
