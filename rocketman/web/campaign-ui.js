/**
 * Campaign screens: mission select, briefing, debrief, and the Hangar.
 *
 * Pure presentation. Every function here takes a profile and returns markup or
 * calls a callback; none of them touch the simulation or persist anything. The
 * caller (main.js) owns the profile and decides when to save, which keeps the
 * "what changed" logic in one place instead of scattered across six screens.
 */

import { MISSIONS, CAMPAIGN_TITLE, CAMPAIGN_INTRO } from '../engine/campaign.js';
import {
  UPGRADES,
  BRANCHES,
  PILOTS,
  levelForXp,
  xpToNextLevel,
  MAX_PILOT_LEVEL,
  PERK_LEVEL,
} from '../engine/progression.js';
import { missionUnlocked, canBuy, campaignComplete } from '../engine/profile.js';
import { TICKS_PER_SECOND } from '../engine/content.js';

const $ = (id) => document.getElementById(id);

export function formatTime(ticks) {
  const s = Math.floor(ticks / TICKS_PER_SECOND);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/* ------------------------------------------------------- mission select -- */

export function renderCampaign(profile, handlers) {
  const root = $('campaign');
  root.innerHTML = '';

  const header = el('div', 'campaignHead');
  header.appendChild(el('h2', null, CAMPAIGN_TITLE));
  header.appendChild(
    el(
      'p',
      'salvageLine',
      `<span>Salvage</span> <b>${profile.salvage.toLocaleString()}</b>`
    )
  );
  root.appendChild(header);

  if (profile.completed.length === 0) {
    root.appendChild(el('pre', 'intro', CAMPAIGN_INTRO));
  }
  if (campaignComplete(profile)) {
    root.appendChild(
      el(
        'p',
        'done',
        'Campaign complete. Missions can be replayed for salvage and pilot experience.'
      )
    );
  }

  const list = el('div', 'missionList');
  for (const mission of MISSIONS) {
    const unlocked = missionUnlocked(profile, mission);
    const cleared = profile.completed.includes(mission.id);
    const record = profile.records[mission.id];

    const card = el('button', `mission${cleared ? ' cleared' : ''}${unlocked ? '' : ' locked'}`);
    card.type = 'button';
    card.disabled = !unlocked;
    card.innerHTML = `
      <span class="no">${String(mission.index).padStart(2, '0')}</span>
      <span class="body">
        <strong>${mission.name}</strong>
        <em>${mission.subtitle}</em>
        ${mission.teaches ? `<span class="teaches">${mission.teaches}</span>` : ''}
        ${
          record
            ? `<span class="record">Best ${formatTime(record.ticks)} · ${record.killed} kills</span>`
            : ''
        }
      </span>
      <span class="badge">${cleared ? 'Cleared' : unlocked ? 'Available' : 'Locked'}</span>`;
    if (unlocked) card.addEventListener('click', () => handlers.onBrief(mission));
    list.appendChild(card);
  }
  root.appendChild(list);

  const actions = el('div', 'campaignActions');
  const hangar = el('button', 'ghost', 'Hangar');
  hangar.type = 'button';
  hangar.addEventListener('click', handlers.onHangar);
  actions.appendChild(hangar);

  const skirmish = el('button', 'ghost', 'Skirmish');
  skirmish.type = 'button';
  skirmish.addEventListener('click', handlers.onSkirmish);
  actions.appendChild(skirmish);

  const reset = el('button', 'ghost danger', 'Reset campaign');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    // Destroying a save is worth one confirmation.
    if (window.confirm('Erase all campaign progress, salvage and pilots?')) handlers.onReset();
  });
  actions.appendChild(reset);
  root.appendChild(actions);
}

/* -------------------------------------------------------------- briefing -- */

export function renderBriefing(mission, profile, handlers) {
  const root = $('briefing');
  root.innerHTML = '';

  const card = el('div', 'brief');
  card.innerHTML = `
    <span class="no">Mission ${String(mission.index).padStart(2, '0')}</span>
    <h2>${mission.name}</h2>
    <em>${mission.subtitle}</em>
    <pre>${mission.briefing}</pre>`;

  const objectives = el('div', 'briefObjectives');
  objectives.appendChild(el('h5', null, 'Objectives'));
  for (const o of mission.objectives || []) {
    objectives.appendChild(el('div', 'obj', `<i></i>${o.text || o.kind}`));
  }
  for (const o of mission.bonusObjectives || []) {
    objectives.appendChild(
      el('div', 'obj bonus', `<i></i>${o.text || o.kind}${o.reward ? ` <b>+${o.reward}</b>` : ''}`)
    );
  }
  card.appendChild(objectives);

  const crew = (mission.player.start && mission.player.start.heroes) || [];
  if (crew.length) {
    const roster = el('div', 'briefCrew');
    roster.appendChild(el('h5', null, 'Crew deploying'));
    const row = el('div', 'crewRow');
    for (const id of crew) {
      const pilot = PILOTS[id];
      const record = profile.pilots[id];
      const level = record ? record.level : 1;
      row.appendChild(
        el(
          'div',
          'crewChip',
          `<strong>${pilot.name}</strong><em>${pilot.chassis} · Level ${level}</em>`
        )
      );
    }
    roster.appendChild(row);
    card.appendChild(roster);
  }

  const actions = el('div', 'briefActions');
  const launch = el('button', 'primary', 'Deploy');
  launch.type = 'button';
  launch.id = 'deployMission';
  launch.addEventListener('click', () => handlers.onLaunch(mission));
  actions.appendChild(launch);

  const back = el('button', 'ghost', 'Back');
  back.type = 'button';
  back.addEventListener('click', handlers.onBack);
  actions.appendChild(back);
  card.appendChild(actions);

  root.appendChild(card);
}

/* --------------------------------------------------------------- debrief -- */

export function renderDebrief(mission, outcome, before, after, handlers) {
  const root = $('debrief');
  root.innerHTML = '';

  const card = el('div', `debriefCard ${outcome.won ? 'won' : 'lost'}`);
  card.innerHTML = `
    <h2>${outcome.won ? 'Mission complete' : 'Mission failed'}</h2>
    <em>${mission.name}</em>`;

  const objectives = el('div', 'debriefObjectives');
  for (const o of outcome.objectives) {
    const state = o.failed ? 'failed' : o.complete || (o.standing && !o.failed) ? 'done' : 'missed';
    objectives.appendChild(
      el(
        'div',
        `obj ${state}${o.optional ? ' bonus' : ''}`,
        `<i></i>${o.text || o.key}<span>${
          state === 'done' ? '✓' : state === 'failed' ? '✕' : '—'
        }</span>`
      )
    );
  }
  card.appendChild(objectives);

  if (outcome.won) {
    const salvage = el('div', 'payout');
    salvage.appendChild(row('Mission reward', outcome.rewards.base));
    salvage.appendChild(row('Kill bonus', outcome.rewards.killBonus));
    if (outcome.rewards.speedBonus) salvage.appendChild(row('Under par', outcome.rewards.speedBonus));
    if (outcome.bonusSalvage) salvage.appendChild(row('Bonus objectives', outcome.bonusSalvage));
    salvage.appendChild(row('Salvage now', after.salvage, true));
    card.appendChild(salvage);
  }

  const stats = el('div', 'payout');
  stats.appendChild(row('Time', formatTime(outcome.stats.ticks), false, true));
  stats.appendChild(row('Destroyed', outcome.stats.killed, false, true));
  stats.appendChild(row('Lost', outcome.stats.lost, false, true));
  card.appendChild(stats);

  // Pilot XP, with any level-up called out — this is the bit players read.
  const crew = Object.keys(outcome.pilotXp);
  if (crew.length) {
    const xp = el('div', 'crewXp');
    xp.appendChild(el('h5', null, 'Crew'));
    for (const id of crew) {
      const wasLevel = before.pilots[id] ? before.pilots[id].level : 1;
      const now = after.pilots[id];
      if (!now) continue;
      const levelled = now.level > wasLevel;
      const lost = outcome.pilotsLost.includes(id);
      xp.appendChild(
        el(
          'div',
          `crewChip${levelled ? ' up' : ''}${lost ? ' down' : ''}`,
          `<strong>${now.name}</strong>
           <em>+${outcome.pilotXp[id]} XP${levelled ? ` · Level ${now.level}` : ''}${
             lost ? ' · shot down' : ''
           }</em>
           ${
             levelled && now.level === PERK_LEVEL
               ? `<span class="perk">${PILOTS[id].perk.name} unlocked — ${PILOTS[id].perk.hint}</span>`
               : ''
           }`
        )
      );
    }
    card.appendChild(xp);
  }

  if (outcome.won && mission.debrief) {
    card.appendChild(el('pre', 'debriefStory', mission.debrief));
  }

  const actions = el('div', 'briefActions');
  const cont = el('button', 'primary', outcome.won ? 'Continue' : 'Back to missions');
  cont.type = 'button';
  cont.id = 'debriefContinue';
  cont.addEventListener('click', handlers.onContinue);
  actions.appendChild(cont);

  const retry = el('button', 'ghost', 'Replay mission');
  retry.type = 'button';
  retry.addEventListener('click', () => handlers.onRetry(mission));
  actions.appendChild(retry);

  // Watch the match back. Only offered when main.js actually has a recording
  // in hand, so the button never leads nowhere.
  if (handlers.onWatch) {
    const watch = el('button', 'ghost', 'Watch replay');
    watch.type = 'button';
    watch.id = 'debriefWatch';
    watch.addEventListener('click', handlers.onWatch);
    actions.appendChild(watch);
  }
  card.appendChild(actions);

  root.appendChild(card);
}

/**
 * A line in the payout table. Individual awards read as "+400"; the running
 * balance and the plain statistics are absolute values — "+775 salvage now"
 * would claim the mission paid out the whole bank.
 */
function row(label, value, isTotal = false, plain = false) {
  const signed = !plain && !isTotal && typeof value === 'number';
  const text = typeof value === 'string' ? value : Number(value).toLocaleString();
  return el(
    'div',
    `payoutRow${isTotal ? ' total' : ''}`,
    `<span>${label}</span><b>${signed ? '+' : ''}${text}</b>`
  );
}

/* ---------------------------------------------------------------- hangar -- */

export function renderHangar(profile, handlers) {
  const root = $('hangar');
  root.innerHTML = '';

  const head = el('div', 'campaignHead');
  head.appendChild(el('h2', null, 'Hangar'));
  head.appendChild(
    el('p', 'salvageLine', `<span>Salvage</span> <b id="hangarSalvage">${profile.salvage.toLocaleString()}</b>`)
  );
  root.appendChild(head);

  root.appendChild(
    el(
      'p',
      'hint',
      'Upgrades are permanent and apply to every mission from here on, including missions you replay.'
    )
  );

  /* --- crew ---------------------------------------------------------- */
  const crew = el('div', 'hangarCrew');
  crew.appendChild(el('h5', null, 'The crew'));
  const crewRow = el('div', 'crewRow');
  for (const record of Object.values(profile.pilots)) {
    const def = PILOTS[record.id];
    const next = xpToNextLevel(record.xp);
    const hasPerk = record.level >= PERK_LEVEL;
    crewRow.appendChild(
      el(
        'div',
        `crewCard${hasPerk ? ' perked' : ''}`,
        `<strong>${def.name}</strong>
         <em>${def.chassis} · Level ${record.level}${
           record.level >= MAX_PILOT_LEVEL ? ' (max)' : ''
         }</em>
         <p>${def.blurb}</p>
         <div class="xpBar"><i style="width:${
           next ? Math.round(((record.xp - (next.at - next.need)) / next.need) * 100) : 100
         }%"></i></div>
         <span class="xpText">${
           next ? `${next.need.toLocaleString()} XP to level ${record.level + 1}` : 'Fully trained'
         }</span>
         <span class="perk ${hasPerk ? 'on' : 'off'}">${def.perk.name} — ${def.perk.hint}${
           hasPerk ? '' : ` (level ${PERK_LEVEL})`
         }</span>`
      )
    );
  }
  crew.appendChild(crewRow);
  root.appendChild(crew);

  /* --- upgrades ------------------------------------------------------ */
  for (const branch of BRANCHES) {
    const section = el('div', 'branch');
    section.appendChild(el('h5', null, branch.name));
    section.appendChild(el('p', 'hint', branch.blurb));

    const grid = el('div', 'upgradeGrid');
    for (const up of Object.values(UPGRADES)) {
      if (up.branch !== branch.id) continue;
      const owned = profile.upgrades.includes(up.id);
      const check = canBuy(profile, up.id);

      const card = el('button', `upgrade${owned ? ' owned' : check.ok ? '' : ' off'}`);
      card.type = 'button';
      card.disabled = owned || !check.ok;
      card.dataset.upgrade = up.id;
      card.innerHTML = `
        <strong>${up.name}</strong>
        <em>${up.hint}</em>
        <span class="price">${
          owned ? 'Installed' : check.ok ? `${up.cost.toLocaleString()} salvage` : check.reason
        }</span>`;
      if (!owned && check.ok) card.addEventListener('click', () => handlers.onBuy(up.id));
      grid.appendChild(card);
    }
    section.appendChild(grid);
    root.appendChild(section);
  }

  const actions = el('div', 'campaignActions');
  const back = el('button', 'primary', 'Back to missions');
  back.type = 'button';
  back.addEventListener('click', handlers.onBack);
  actions.appendChild(back);
  root.appendChild(actions);
}
