/**
 * Boot, screen flow, game loop and HUD.
 *
 * The loop is a fixed-timestep accumulator: the simulation only ever advances
 * in whole 50ms ticks, and the renderer interpolates between them. Rendering
 * and simulation are deliberately decoupled — a dropped frame must never
 * change the outcome of a match, or none of the determinism guarantees in
 * engine/ mean anything once there is a real player attached.
 *
 * This file also owns the campaign's *state transitions* — which screen is up,
 * when a profile is written to disk — while engine/profile.js owns what a
 * profile is and web/campaign-ui.js owns how it looks. Keeping "when do we
 * save" in exactly one place is what stops a debrief and a Hangar purchase
 * racing each other to overwrite the save file.
 */

import { createWorld } from '../engine/sim.js';
import { DIFFICULTIES } from '../engine/ai.js';
import {
  FACTIONS,
  UNITS,
  BUILDINGS,
  BUILD_ORDER,
  TICKS_PER_SECOND,
} from '../engine/content.js';
import { techAllows, availableBuildings } from '../engine/economy.js';
import { VETERANCY, SELL_REFUND } from '../engine/content.js';
import { abilityReady, CHASSIS_SLOT, HERO_SLOT } from '../engine/abilities.js';
import { superweaponReady } from '../engine/economy.js';
import { missionWorldConfig, missionOutcome, MISSIONS } from '../engine/campaign.js';
import { describeObjective, objectiveProgressText } from '../engine/objectives.js';
import { recruitFor, applyMissionResult, buyUpgrade, nextMission } from '../engine/profile.js';
import {
  createRecorder,
  record,
  advanceTick,
  commandsAt,
  rebuildWorld,
  serializeMatch,
  deserializeMatch,
} from '../engine/replay.js';
import {
  loadProfile,
  saveProfile,
  clearProfile,
  isEphemeral,
  saveMatch,
  loadMatch,
  clearMatch,
} from './storage.js';
import { createSound } from './sound.js';
import {
  renderCampaign,
  renderBriefing,
  renderDebrief,
  renderHangar,
  formatTime,
} from './campaign-ui.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';

const MS_PER_TICK = 1000 / TICKS_PER_SECOND;
const VIEWER = 0;

const $ = (id) => document.getElementById(id);

const SCREENS = ['title', 'campaign', 'briefing', 'hangar', 'debrief', 'skirmish', 'game'];

function showScreen(name) {
  for (const id of SCREENS) {
    const node = $(id);
    if (node) node.hidden = id !== name;
  }
}

/* ----------------------------------------------------------------- boot -- */

let profile = loadProfile();
/** Torn down between matches so a second match cannot inherit the first's loop. */
let activeMatch = null;
/** One sound system for the whole session, so the mute choice survives matches. */
const sound = createSound();
/** The last finished match's recording, for "Watch replay" on the end screens. */
let lastRecording = null;

function persist() {
  saveProfile(profile);
}

function boot() {
  buildSkirmishMenu();

  $('playCampaign').addEventListener('click', openCampaign);
  $('playSkirmish').addEventListener('click', () => showScreen('skirmish'));
  $('skirmishBack').addEventListener('click', () => showScreen('title'));
  $('resumeMatch').addEventListener('click', resumeSavedMatch);

  if (isEphemeral()) {
    $('storageWarning').hidden = false;
  }

  const pending = nextMission(profile);
  $('campaignSub').textContent = pending
    ? `Next: ${String(pending.index).padStart(2, '0')} · ${pending.name}`
    : 'Campaign complete — replay for salvage';

  refreshResumeButton();
  showScreen('title');
}

/* -------------------------------------------------------- resume & replay -- */

/**
 * The parsed autosave, if there is one worth offering. Parsing happens here,
 * at read time, so a save corrupted while the tab was closed downgrades to
 * "no Resume button" rather than to a button that crashes the page.
 */
function savedMatch() {
  const raw = loadMatch();
  if (!raw) return null;
  const save = deserializeMatch(raw);
  if (!save || save.ticks < 1) return null;
  return save;
}

function refreshResumeButton() {
  const save = savedMatch();
  const button = $('resumeMatch');
  button.hidden = !save;
  if (!save) return;
  const name = save.config.mission ? save.config.mission.name : 'Skirmish';
  const seconds = Math.floor(save.ticks / TICKS_PER_SECOND);
  $('resumeSub').textContent = `${name} — ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} in`;
}

function resumeSavedMatch() {
  const save = savedMatch();
  if (!save) {
    refreshResumeButton();
    return;
  }
  startMatch(save.config, { mission: save.config.mission || null, resume: save });
}

function watchRecording(save) {
  if (!save) return;
  startMatch(save.config, { mission: save.config.mission || null, watch: save });
}

/* ------------------------------------------------------ campaign screens -- */

const campaignHandlers = {
  onBrief: openBriefing,
  onHangar: openHangar,
  onSkirmish: () => showScreen('skirmish'),
  onReset: () => {
    profile = clearProfile();
    openCampaign();
  },
};

function openCampaign() {
  endMatch();
  renderCampaign(profile, campaignHandlers);
  showScreen('campaign');
}

function openBriefing(mission) {
  // Pilots join the roster the moment a briefing names them, so the crew list
  // on the briefing screen is never a lie.
  profile = recruitFor(profile, mission);
  persist();

  renderBriefing(mission, profile, {
    onLaunch: launchMission,
    onBack: openCampaign,
  });
  showScreen('briefing');
}

function openHangar() {
  renderHangar(profile, {
    onBuy: (id) => {
      profile = buyUpgrade(profile, id);
      persist();
      openHangar();
    },
    onBack: openCampaign,
  });
  showScreen('hangar');
}

function launchMission(mission) {
  const config = missionWorldConfig(mission, profile);
  startMatch(config, { mission });
}

function finishMission(world, mission) {
  const outcome = missionOutcome(world, mission);
  const before = profile;
  profile = applyMissionResult(profile, mission, outcome);
  persist();

  renderDebrief(mission, outcome, before, profile, {
    onContinue: openCampaign,
    onRetry: (m) => {
      endMatch();
      launchMission(m);
    },
    // Only offered when the debrief follows a live match this session — a
    // debrief reached after a page reload has no recording to show.
    onWatch: lastRecording ? () => watchRecording(lastRecording) : null,
  });
  showScreen('debrief');
}

/* ------------------------------------------------------- skirmish setup -- */

function buildSkirmishMenu() {
  const factionList = $('factionList');
  let chosen = 'ascendancy';

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
      chosen = faction.id;
      for (const el of factionList.children) el.classList.toggle('on', el === card);
    });
    factionList.appendChild(card);
  }
  factionList.firstElementChild.classList.add('on');

  const difficulty = $('difficulty');
  for (const [id, prof] of Object.entries(DIFFICULTIES)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = prof.label;
    if (id === 'normal') option.selected = true;
    difficulty.appendChild(option);
  }

  $('seed').value = String(Math.floor(Math.random() * 100000));

  $('start').addEventListener('click', () => {
    const seed = parseInt($('seed').value, 10) || 1;
    const enemy = chosen === 'ascendancy' ? 'bulwark' : 'ascendancy';
    startMatch(
      {
        seed,
        players: [
          { faction: chosen, name: 'You' },
          { faction: enemy, isAI: true, difficulty: difficulty.value },
        ],
      },
      { mission: null }
    );
  });
}

/* ------------------------------------------------------------------ game -- */

function endMatch() {
  if (!activeMatch) return;
  activeMatch.stopped = true;
  activeMatch.teardown();
  activeMatch = null;
}

/**
 * Start a match in one of three modes, all sharing one loop:
 *
 * - live (default): a fresh world, recorded as it is played.
 * - resume: rebuild the world from `resume`'s command log — determinism means
 *   re-simulation *is* loading — then keep playing and recording on the end
 *   of the same log.
 * - watch: rebuild from tick zero at viewing speed, feeding the log's
 *   commands in at the ticks they were originally given. Input still selects
 *   and pans; its commands are discarded rather than applied.
 */
function startMatch(config, { mission, resume = null, watch = null }) {
  endMatch();

  const world = resume ? rebuildWorld(resume) : createWorld(config);
  const recorder = watch
    ? null
    : resume
      ? { config: resume.config, log: resume.log }
      : createRecorder(config);
  const canvas = $('view');
  const minimap = $('minimap');
  const renderer = createRenderer(canvas, world, VIEWER);
  const input = createInput(canvas, world, VIEWER, renderer, {
    onMessage: toast,
    onSelectionChange: () => renderHud(),
    onModeChange: (unit) => showControlMode(unit),
  });
  input.attachMinimap(minimap);

  const match = { stopped: false, teardown: () => {} };
  activeMatch = match;

  showScreen('game');
  renderer.resize();

  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);

  // Open looking at your own base, close enough to read individual chassis.
  const start = world.map.starts[VIEWER];
  renderer.camera.zoom = 1.6;
  renderer.centreOn(start.x, start.y);

  // A campaign mission puts you in the cockpit: the map follows your pilot
  // and the arrow keys drive them. It is *Just You and Your Rocket Crew* —
  // the hero should be someone you steer, not a token you click at. C hands
  // control back to the ordinary RTS controls at any point.
  const hero = [...world.entities.values()].find(
    (e) => e.player === VIEWER && e.kind === 'unit' && e.pilotId
  );
  if (mission && hero) {
    input.selectSingle(hero, false);
    input.setDriving(true);
    renderer.centreOn(hero.x, hero.y);
  }

  const clock = { accumulator: 0, last: performance.now(), paused: false, speed: 1 };

  const onKey = (ev) => {
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
    } else if (ev.key === 'm' || ev.key === 'M') {
      toast(sound.toggleMute() ? 'Sound off' : 'Sound on');
    }
  };
  window.addEventListener('keydown', onKey);

  match.teardown = () => {
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    delete window.__rocketman;
  };

  // Touch controls exist only where there is a touch to give them. On a
  // desktop they would be three dead buttons and a stick sitting over the
  // battlefield.
  const stick = $('stick');
  const actions = $('touchActions');
  if (input.isTouch) {
    input.attachStick(stick, $('stickNub'));
    actions.hidden = false;
    $('btnAbility').onclick = () => input.useAbility(CHASSIS_SLOT);
    $('btnSkyfall').onclick = () => input.useAbility(HERO_SLOT);
    $('btnAttack').onclick = () => {
      // Arms the same attack-move a long press gives, for players who would
      // rather press a button than hold the screen.
      toast('Tap a spot to attack-move there.');
      input.armAttackMove();
    };
  }

  $('selectAll').onclick = () => {
    const n = input.selectAllUnits();
    toast(n ? `${n} machine${n === 1 ? '' : 's'} selected` : 'Nothing to select');
  };

  $('missionName').textContent = `${watch ? 'Replay — ' : ''}${mission ? mission.name : 'Skirmish'}`;
  $('objectives').hidden = !mission;
  $('quitMatch').onclick = () => {
    // Leaving a live match mid-fight is what the autosave is *for*: write the
    // current recording so the title screen can offer to resume it. A finished
    // or spectated match has nothing to come back to.
    if (!watch) {
      if (!world.over) saveMatch(serializeMatch(recorder, world.tick));
      else clearMatch();
    }
    if (mission && !watch) {
      openCampaign();
    } else {
      endMatch();
      refreshResumeButton();
      showScreen('title');
    }
  };

  let ended = false;
  /** Ticks between autosaves — every five seconds of play, plus on quit. */
  const AUTOSAVE_EVERY = 100;

  function frame(now) {
    if (match.stopped) return;
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

    // Camera. Driving locks it to the machine; otherwise the player pans.
    // Interpolated the same way the unit is drawn, or the view would judder
    // at the 20Hz simulation rate while the machine itself looks smooth.
    const driven = input.cameraFollows ? input.drivenEntity() : null;
    if (driven) {
      renderer.centreOn(
        driven.x - driven.vx * (1 - renderer.state.alpha),
        driven.y - driven.vy * (1 - renderer.state.alpha)
      );
    }
    // Edge scrolling and arrow-key panning. This call was missing entirely,
    // so neither had ever worked.
    input.updateCamera(Math.min(0.1, elapsed / 1000));

    renderer.stepSparks();
    renderer.draw(input.selection);
    renderer.drawMinimap(minimap);
    updateTopBar();

    requestAnimationFrame(frame);
  }

  function stepOnce() {
    // One definition of a turn, shared with resume and rebuild: player
    // commands, then the AI, then the tick — advanceTick owns that order.
    // When spectating, the mouse still selects and pans but its commands go
    // nowhere; the log is the only author the simulation listens to.
    let playerCommands;
    if (watch) {
      input.takeCommands();
      playerCommands = commandsAt(watch, world.tick) || [];
    } else {
      playerCommands = input.takeCommands();
      record(recorder, world.tick, playerCommands);
    }
    advanceTick(world, playerCommands);

    if (!watch && world.tick % AUTOSAVE_EVERY === 0 && !world.over) {
      saveMatch(serializeMatch(recorder, world.tick));
    }

    renderer.consumeEvents(world.events);
    sound.consume(world.events, world, renderer, VIEWER);
    input.pruneSelection();

    for (const ev of world.events) {
      if (ev.type === 'objectiveComplete') {
        toast(ev.optional ? 'Bonus objective complete' : 'Objective complete');
      } else if (ev.type === 'objectiveFailed' && !ev.optional) {
        toast('Objective failed');
      } else if (ev.type === 'superweaponReady' && ev.player === VIEWER) {
        toast('Orbital Lance charged');
      } else if (ev.type === 'superweaponFired' && ev.player !== VIEWER) {
        toast('Incoming orbital strike');
      } else if (ev.type === 'promoted' && world.entities.get(ev.id)?.player === VIEWER) {
        toast(`${VETERANCY[ev.rank].name} promotion`);
      } else if (ev.type === 'repairStalled' && ev.player === VIEWER) {
        toast('Repair stopped — out of scrap');
      } else if (ev.type === 'reinforcement' && ev.player === VIEWER) {
        // An unannounced arrival is the biggest thing that happens in a
        // mission, so it gets the camera as well as the toast — otherwise it
        // lands off-screen and the player finds it ten minutes later.
        //
        // The camera only. Selecting the newcomer would also hand them the
        // cockpit mid-drive, which is jarring at best and, in a mission whose
        // objective is "bring Ash home alive", a good way to get her killed
        // while the player is looking somewhere else. Their chip is on the
        // roster bar; taking the seat stays their decision.
        toast(ev.message || `${ev.name || 'Reinforcements'} joined the fight`);
        renderer.centreOn(ev.x, ev.y);
      }
    }

    // The HUD only needs refreshing a few times a second; rebuilding DOM at
    // 20Hz is pure waste and makes buttons feel unclickable.
    if (world.tick % 5 === 0) {
      renderHud();
      renderRoster();
      if (input.isTouch) renderTouchControls();
      if (mission) renderObjectives();
    }

    if (world.over && !ended) {
      ended = true;
      if (!watch) {
        // The fight is decided, so the mid-match save is spent — but the same
        // recording, stamped at the final tick, becomes the replay.
        clearMatch();
        lastRecording = deserializeMatch(serializeMatch(recorder, world.tick));
        refreshResumeButton();
      }
      // Let the final explosion land before cutting to the debrief.
      setTimeout(() => {
        if (match.stopped) return;
        // A spectated mission must not pay out twice — the live run already
        // did. Replays of either mode end on the plain result card.
        if (mission && !watch) finishMission(world, mission);
        else showResult();
      }, 1400);
    }
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
    result: world.result,
    mission: mission ? mission.id : null,
    mode: watch ? 'replay' : resume ? 'resumed' : 'live',
    muted: sound.muted,
    driving: input.driving,
    driven: (() => {
      const e = input.drivenEntity();
      return e ? { id: e.id, defId: e.defId, x: e.x, y: e.y, pilot: e.pilotName || null } : null;
    })(),
    camera: { x: renderer.camera.x, y: renderer.camera.y, zoom: renderer.camera.zoom },
    /** The player character, whether or not it is currently being driven. */
    /** Prop census, so a test can find the neighbourhood without a screenshot. */
    props: (() => {
      const out = {};
      for (const e of world.entities.values()) {
        if (e.kind !== 'prop' || e.dead) continue;
        out[e.defId] = (out[e.defId] || 0) + 1;
      }
      return out;
    })(),
    propAt: null,
    hero: (() => {
      for (const e of world.entities.values()) {
        if (e.player === VIEWER && e.kind === 'unit' && e.pilotId && !e.dead) {
          return { id: e.id, x: e.x, y: e.y, pilot: e.pilotName || null };
        }
      }
      return null;
    })(),
    selection: [...input.selection],
    objectives: world.objectives.map((o) => ({
      key: o.key,
      text: describeObjective(o),
      optional: o.optional,
      complete: o.complete,
      failed: o.failed,
      progress: o.progress,
      total: o.total,
    })),
    players: world.players.map((p) => ({
      faction: p.faction,
      scrap: Math.round(p.scrap),
      mined: Math.round(p.scrapMined),
      powerMade: p.powerMade,
      powerUsed: p.powerUsed,
      tech: [...p.tech],
      upgrades: p.upgrades,
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

    // mm:ss, zero-padded so the readout does not jitter in width as it ticks.
    // `formatTime` is the prose form ("1m 38s") used on the debrief; deriving
    // this from it by string surgery was one rename away from breaking.
    const seconds = Math.floor(world.tick / TICKS_PER_SECOND);
    $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(
      seconds % 60
    ).padStart(2, '0')}`;
  }

  /**
   * Keep the on-screen controls honest: the stick only when someone is in the
   * cockpit, and the ability buttons labelled with what they actually fire
   * and whether it is ready. A dead button that looks alive is worse on a
   * phone than on a desktop, because there is no tooltip to explain it.
   */
  function renderTouchControls() {
    // The stick is shown whenever there is anything to drive, not only while
    // driving. Hiding it the moment an order is issued strands a phone player
    // outside the cockpit for the rest of the mission: touching the stick is
    // the only way back in, and `C` does not exist on a phone. Dimmed when
    // idle so it still reads as "not currently flying anything".
    const driven = input.drivenEntity();
    const drivable = driven || input.drivableUnit();
    stick.hidden = !drivable;
    stick.classList.toggle('idle', !driven);

    const selected = input.selectedEntities();
    const chassis = selected.find((e) => e.ability);
    const crew = selected.find((e) => e.heroAbility);

    const paint = (id, slot, holder) => {
      const btn = $(id);
      if (!holder) {
        btn.classList.add('off');
        btn.classList.remove('ready');
        return;
      }
      const ready = abilityReady(world, holder, slot);
      btn.querySelector('b').textContent = holder[slot].def.name;
      const left = Math.ceil(holder[slot].cooldown / TICKS_PER_SECOND);
      btn.querySelector('em').textContent = ready ? 'ready' : `${left}s`;
      btn.classList.toggle('ready', ready);
      btn.classList.toggle('off', !ready);
    };
    paint('btnAbility', CHASSIS_SLOT, chassis);
    paint('btnSkyfall', HERO_SLOT, crew);
  }

  /** Which control scheme is live, and who is in the seat. */
  function showControlMode(unit) {
    const chip = $('controlMode');
    if (!chip) return;
    chip.hidden = !unit;
    if (unit) {
      $('controlName').textContent = unit.pilotName || unit.def.name;
    }
  }

  function renderObjectives() {
    const panel = $('objectives');
    panel.innerHTML = '<h5>Objectives</h5>';
    for (const o of world.objectives) {
      const state = o.failed ? 'failed' : o.complete ? 'done' : 'open';
      const progress = objectiveProgressText(o);
      panel.appendChild(
        Object.assign(document.createElement('div'), {
          className: `obj ${state}${o.optional ? ' bonus' : ''}`,
          innerHTML: `<i></i>${describeObjective(o)}${
            progress ? `<span>${progress}</span>` : ''
          }`,
        })
      );
    }
  }

  function renderHud() {
    renderSelection();
    renderCommands();
  }

  /**
   * The bottom roster: named pilots first, then one chip per unit type.
   *
   * This is the map's navigation, not decoration. An RTS on a 72-cell map
   * with fog is only as easy to move around as its shortcuts, and hunting for
   * a Collector by dragging the minimap is the worst of them.
   */
  function renderRoster() {
    const list = $('rosterList');
    const heroes = [];
    const groups = new Map();

    for (const e of world.entities.values()) {
      if (e.player !== VIEWER || e.kind !== 'unit' || e.dead) continue;
      if (e.pilotId) {
        heroes.push(e);
        continue;
      }
      const g = groups.get(e.defId) || { defId: e.defId, def: e.def, units: [] };
      g.units.push(e);
      groups.set(e.defId, g);
    }
    heroes.sort((a, b) => a.id - b.id);

    // Rebuilding the whole bar every quarter-second would drop the scroll
    // position and fight the mouse, so the shape is keyed and only rebuilt
    // when the roster actually changes.
    const key = [
      ...heroes.map((e) => e.pilotId),
      ...[...groups.values()].map((g) => `${g.defId}:${g.units.length}`),
    ].join('|');
    if (key !== list.dataset.key) {
      list.dataset.key = key;
      list.innerHTML = '';
      for (const hero of heroes) list.appendChild(heroChip(hero));
      for (const g of groups.values()) list.appendChild(groupChip(g));
    }

    // The live parts — hull and Skyfall readiness — are cheap to patch in
    // place, so they update every pass without touching the DOM structure.
    for (const hero of heroes) {
      const chip = list.querySelector(`[data-pilot="${hero.pilotId}"]`);
      if (!chip) continue;
      const f = Math.max(0, hero.hp / hero.maxHp);
      chip.querySelector('i').style.width = `${Math.round(f * 100)}%`;
      chip.classList.toggle('hurt', f < 0.45);
      chip.classList.toggle('jump', !!hero.heroAbility && hero.heroAbility.cooldown === 0);
    }
  }

  function heroChip(hero) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'rosterChip pilot';
    chip.dataset.pilot = hero.pilotId;
    chip.title = `${hero.pilotName} — ${hero.def.name}. Click to select and jump the camera there.`;
    const short = (hero.pilotName || '').split(' ').pop().replace(/["]/g, '');
    chip.innerHTML = `<strong>${short}</strong><em>${hero.def.name}</em>
      <span class="hpbar"><i style="width:100%"></i></span>`;
    chip.addEventListener('click', () => input.focusOn(hero));
    return chip;
  }

  function groupChip(g) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'rosterChip';
    chip.dataset.group = g.defId;
    chip.title = `Select all ${g.def.name}s`;
    chip.innerHTML = `<strong>${g.def.name}</strong><em>×${g.units.length}</em>`;
    chip.addEventListener('click', () => input.selectByDefId(g.defId));
    return chip;
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
      const rank =
        e.vet > 0
          ? `<div class="stat"><span>Rank</span><b class="rank">${VETERANCY[e.vet].name}</b></div>`
          : '';
      card.innerHTML = `
        <h4>${e.def.name}${e.pilotName ? ` <small>${e.pilotName}</small>` : ''}</h4>
        <div class="stat"><span>Hull</span><b>${Math.round(e.hp)} / ${e.maxHp}</b></div>
        ${shield}${cargo}${rank}
        <p class="hint">${e.def.hint || ''}</p>`;
      panel.appendChild(card);
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'chips';
    for (const e of selected.slice(0, 24)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${e.pilotId ? ' pilot' : ''}`;
      chip.title = e.pilotName || e.def.name;
      chip.innerHTML = `<span>${e.pilotName ? e.pilotName.split(' ')[0] : e.def.name}</span>
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
    const defs = player.defs;
    const selected = input.selectedEntities();

    const hq = selected.find((e) => e.def.builds === 'buildings' && !e.constructing);
    const factory = selected.find((e) => e.def.builds === 'units' && !e.constructing);

    if (hq) {
      panel.appendChild(sectionTitle('Construct'));
      const row = document.createElement('div');
      row.className = 'buttons';
      const unlocked = new Set(availableBuildings(world, VIEWER));

      BUILD_ORDER.forEach((id, i) => {
        const def = defs.buildings[id];
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
        const def = defs.units[id];
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
          chip.innerHTML = `<span>${defs.units[item.defId].name}</span>
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

    // Structure orders. Sell and repair are the Command & Conquer economy
    // controls: a damaged Refinery is worth patching, and a Foundry you have
    // outgrown is worth half its cost back.
    const structures = selected.filter((e) => e.kind === 'building' && !e.constructing);
    if (structures.length > 0) {
      const lance = structures.find((e) => e.def.superweapon);
      panel.appendChild(sectionTitle('Structure'));
      const row = document.createElement('div');
      row.className = 'buttons';

      if (lance) {
        const ready = superweaponReady(lance);
        const left = Math.ceil((lance.def.superweapon.charge - lance.charge) / TICKS_PER_SECOND);
        row.appendChild(
          commandButton({
            label: lance.def.superweapon.name,
            sub: ready ? 'Ready' : !lance.powered ? 'No power' : `${left}s`,
            hint: lance.def.superweapon.hint,
            disabled: !ready,
            reason: lance.powered ? 'Still charging' : 'Unpowered',
            highlight: ready,
            onClick: () => input.armStrike(lance),
          })
        );
      }

      const damaged = structures.filter((e) => e.hp < e.maxHp);
      const anyRepairing = structures.some((e) => e.repairing);
      row.appendChild(
        commandButton({
          label: anyRepairing ? 'Stop repair' : 'Repair',
          sub: anyRepairing ? 'Working' : `${damaged.length} damaged`,
          hint: 'Patch a structure up, paying scrap as it goes.',
          disabled: damaged.length === 0 && !anyRepairing,
          reason: 'Nothing to repair',
          highlight: anyRepairing,
          onClick: () =>
            input.toggleRepair(
              structures.map((e) => e.id),
              !anyRepairing
            ),
        })
      );

      const sellable = structures.filter(
        (e) =>
          e.defId !== 'command' ||
          [...world.entities.values()].filter(
            (b) => b.player === VIEWER && b.defId === 'command' && !b.dead
          ).length > 1
      );
      const refund = sellable.reduce(
        (n, e) => n + Math.round(defs.buildings[e.defId].cost * SELL_REFUND * (e.hp / e.maxHp)),
        0
      );
      row.appendChild(
        commandButton({
          label: 'Sell',
          sub: sellable.length ? `+${refund.toLocaleString()}` : '—',
          hint: 'Scrap the structure for half its cost, scaled by what is left of it.',
          disabled: sellable.length === 0,
          reason: 'Your last Command Rig cannot be sold',
          onClick: () => input.sellSelected(sellable.map((e) => e.id)),
        })
      );

      panel.appendChild(row);
    }

    // Ability buttons: the chassis ability, plus the crew ability if a named
    // pilot is in the selection. Two slots, two buttons, two cooldowns.
    const abilityRow = document.createElement('div');
    abilityRow.className = 'buttons';

    const withAbility = selected.filter((e) => e.ability);
    if (withAbility.length > 0) {
      const def = withAbility[0].ability.def;
      const ready = withAbility.some((e) => abilityReady(world, e, CHASSIS_SLOT));
      const cooling = Math.max(...withAbility.map((e) => e.ability.cooldown));
      abilityRow.appendChild(
        commandButton({
          label: def.name,
          sub: ready ? 'Ready' : `${Math.ceil(cooling / TICKS_PER_SECOND)}s`,
          hint: def.hint,
          hotkey: 'F',
          disabled: !ready,
          reason: 'On cooldown',
          highlight: ready,
          onClick: () => input.useAbility(CHASSIS_SLOT),
        })
      );
    }

    const withCrew = selected.filter((e) => e.heroAbility);
    if (withCrew.length > 0) {
      const def = withCrew[0].heroAbility.def;
      const ready = withCrew.some((e) => abilityReady(world, e, HERO_SLOT));
      const cooling = Math.max(...withCrew.map((e) => e.heroAbility.cooldown));
      abilityRow.appendChild(
        commandButton({
          label: def.name,
          sub: ready ? 'Ready' : `${Math.ceil(cooling / TICKS_PER_SECOND)}s`,
          hint: def.hint,
          hotkey: 'G',
          disabled: !ready,
          reason: 'Recharging',
          highlight: ready,
          onClick: () => input.useAbility(HERO_SLOT),
        })
      );
    }

    // On touch the two big round buttons already are the abilities, with the
    // same cooldowns on them. Repeating them in the panel spends a third of a
    // phone screen saying something the player can already see and press.
    if (abilityRow.children.length > 0 && !input.isTouch) {
      panel.appendChild(sectionTitle(withCrew.length ? 'Abilities · Crew' : 'Ability'));
      panel.appendChild(abilityRow);
    }

    if (panel.children.length === 0) {
      panel.innerHTML =
        '<p class="hint">Select the Command Rig to build, or a Foundry to make mechs.</p>';
    }
  }

  /** Skirmish end card — also the end card for any watched replay. */
  function showResult() {
    const overlay = $('result');
    if (!overlay.hidden) return;
    const won = world.winner === VIEWER;
    const player = world.players[VIEWER];

    overlay.hidden = false;
    overlay.innerHTML = `
      <div class="resultCard ${won ? 'won' : 'lost'}">
        <h2>${watch ? 'Replay over' : won ? 'Victory' : 'Defeat'}</h2>
        <div class="stat"><span>Time</span><b>${formatTime(world.tick)}</b></div>
        <div class="stat"><span>Scrap mined</span><b>${Math.round(
          player.scrapMined
        ).toLocaleString()}</b></div>
        <div class="stat"><span>Kills</span><b>${player.stats.killed}</b></div>
        <div class="stat"><span>Losses</span><b>${player.stats.lost}</b></div>
        ${!watch && lastRecording ? '<button type="button" id="watchReplay" class="ghost">Watch replay</button>' : ''}
        <button type="button" id="again">Back to menu</button>
      </div>`;
    $('again').addEventListener('click', () => {
      overlay.hidden = true;
      endMatch();
      refreshResumeButton();
      showScreen('title');
    });
    const watchButton = $('watchReplay');
    if (watchButton) {
      watchButton.addEventListener('click', () => {
        overlay.hidden = true;
        watchRecording(lastRecording);
      });
    }
  }

  renderHud();
  renderRoster();
  if (mission) renderObjectives();
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
