/**
 * The campaign save file.
 *
 * Pure data and pure functions — no localStorage, no JSON parsing of untrusted
 * blobs, no browser. `web/storage.js` owns persistence; this owns what a
 * profile *is* and how it changes. That split is why the whole progression
 * loop is testable under `node --test`.
 *
 * Everything here returns a new profile rather than mutating the argument, so
 * a debrief screen can show "before and after" without keeping a manual copy.
 */

import { PILOTS, UPGRADES, upgradeAvailable, levelForXp, MAX_PILOT_LEVEL } from './progression.js';
import { MISSIONS } from './campaign.js';

/** Bumped when the shape changes in a way `migrate` has to handle. */
export const PROFILE_VERSION = 1;

/**
 * A fresh campaign. Only Ash starts on the roster — the crew assembling one at
 * a time is the story, and a mission that hands you five pilots at once has
 * nothing left to give you in mission three.
 */
export function createProfile() {
  return {
    version: PROFILE_VERSION,
    salvage: 0,
    /** Mission ids cleared, in order. */
    completed: [],
    /** Per-mission best result, for the mission-select screen. */
    records: {},
    upgrades: [],
    pilots: {
      ash: newPilot('ash'),
    },
    totals: { killed: 0, lost: 0, mined: 0, missions: 0 },
  };
}

function newPilot(id) {
  const def = PILOTS[id];
  return { id, name: def.name, chassis: def.chassis, xp: 0, level: 1, missions: 0, kills: 0 };
}

/**
 * Pilots join as the story introduces them, which is expressed as "whoever a
 * mission expects to field". Reading it off the mission data means the roster
 * can never drift out of step with the briefings that mention them.
 */
export function rosterForMission(mission) {
  const deploying = (mission.player.start && mission.player.start.heroes) || [];
  // Pilots who turn up mid-mission are on the roster too — otherwise they
  // would earn XP no profile could hold and vanish at the debrief. The
  // briefing screen reads `start.heroes` directly, so including them here
  // does not spoil the arrival.
  const arriving = (mission.reinforcements || []).map((r) => r.pilot).filter(Boolean);
  return [...deploying, ...arriving];
}

/** Add any pilots a mission needs who are not on the roster yet. */
export function recruitFor(profile, mission) {
  const next = { ...profile, pilots: { ...profile.pilots } };
  let changed = false;

  for (const id of rosterForMission(mission)) {
    if (next.pilots[id] || !PILOTS[id]) continue;
    next.pilots[id] = newPilot(id);
    changed = true;
  }
  return changed ? next : profile;
}

/** The next mission the player has not cleared, or null once the campaign is done. */
export function nextMission(profile) {
  return MISSIONS.find((m) => !profile.completed.includes(m.id)) || null;
}

/** Is this mission playable? Missions unlock strictly in order. */
export function missionUnlocked(profile, mission) {
  const index = MISSIONS.findIndex((m) => m.id === mission.id);
  if (index <= 0) return true;
  return profile.completed.includes(MISSIONS[index - 1].id);
}

export function campaignComplete(profile) {
  return MISSIONS.every((m) => profile.completed.includes(m.id));
}

/* ------------------------------------------------------------- rewards -- */

/**
 * Record a finished mission.
 *
 * A replayed mission still pays kill and bonus salvage but only pays its base
 * reward once — otherwise the optimal campaign is mission one, forever.
 */
export function applyMissionResult(profile, mission, outcome) {
  const {
    won,
    rewards,
    bonusSalvage = 0,
    pilotXp = {},
    stats = {},
  } = outcome;

  const next = {
    ...profile,
    pilots: { ...profile.pilots },
    records: { ...profile.records },
    completed: [...profile.completed],
    totals: { ...profile.totals },
  };

  next.totals.killed += stats.killed || 0;
  next.totals.lost += stats.lost || 0;
  next.totals.mined += Math.round(stats.mined || 0);
  next.totals.missions += 1;

  for (const [pilotId, xp] of Object.entries(pilotXp)) {
    const pilot = next.pilots[pilotId];
    if (!pilot) continue;
    const gained = { ...pilot, xp: pilot.xp + xp, missions: pilot.missions + 1 };
    gained.level = Math.min(MAX_PILOT_LEVEL, levelForXp(gained.xp));
    next.pilots[pilotId] = gained;
  }

  if (!won) return next;

  const firstClear = !profile.completed.includes(mission.id);
  const payout = (firstClear ? rewards.salvage : rewards.salvage - rewards.base) + bonusSalvage;
  next.salvage += Math.max(0, payout);

  if (firstClear) next.completed.push(mission.id);

  const previous = profile.records[mission.id];
  const record = {
    ticks: stats.ticks || 0,
    killed: stats.killed || 0,
    lost: stats.lost || 0,
    bonuses: outcome.bonusesCleared || 0,
  };
  if (!previous || record.ticks < previous.ticks) next.records[mission.id] = record;

  return next;
}

/* ------------------------------------------------------------ upgrades -- */

export function canBuy(profile, upgradeId) {
  const up = UPGRADES[upgradeId];
  if (!up) return { ok: false, reason: 'Unknown upgrade' };
  if (profile.upgrades.includes(upgradeId)) return { ok: false, reason: 'Already installed' };
  if (!upgradeAvailable(profile.upgrades, upgradeId)) {
    const missing = (up.requires || []).filter((r) => !profile.upgrades.includes(r));
    return { ok: false, reason: `Requires ${missing.map((m) => UPGRADES[m].name).join(', ')}` };
  }
  if (profile.salvage < up.cost) return { ok: false, reason: 'Not enough salvage' };
  return { ok: true };
}

export function buyUpgrade(profile, upgradeId) {
  const check = canBuy(profile, upgradeId);
  if (!check.ok) return profile;
  return {
    ...profile,
    salvage: profile.salvage - UPGRADES[upgradeId].cost,
    upgrades: [...profile.upgrades, upgradeId].sort(),
  };
}

/* -------------------------------------------------------- serialisation -- */

export function serialize(profile) {
  return JSON.stringify(profile);
}

/**
 * Read a profile back.
 *
 * A save file is untrusted input — it has been sitting in localStorage where
 * anything could have edited it, and a corrupt one must produce a playable
 * campaign rather than a crashed page. Unknown upgrades and pilots are dropped
 * rather than carried, so removing content from the game never bricks a save.
 */
export function deserialize(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return createProfile();
  }
  if (!raw || typeof raw !== 'object') return createProfile();

  const fresh = createProfile();
  const known = new Set(MISSIONS.map((m) => m.id));

  const profile = {
    version: PROFILE_VERSION,
    salvage: Number.isFinite(raw.salvage) ? Math.max(0, Math.floor(raw.salvage)) : 0,
    completed: Array.isArray(raw.completed) ? raw.completed.filter((id) => known.has(id)) : [],
    records: raw.records && typeof raw.records === 'object' ? { ...raw.records } : {},
    upgrades: Array.isArray(raw.upgrades)
      ? [...new Set(raw.upgrades.filter((id) => UPGRADES[id]))].sort()
      : [],
    pilots: {},
    totals: { ...fresh.totals, ...(raw.totals && typeof raw.totals === 'object' ? raw.totals : {}) },
  };

  const source = raw.pilots && typeof raw.pilots === 'object' ? raw.pilots : {};
  for (const [id, record] of Object.entries(source)) {
    if (!PILOTS[id] || !record || typeof record !== 'object') continue;
    const xp = Number.isFinite(record.xp) ? Math.max(0, record.xp) : 0;
    profile.pilots[id] = {
      id,
      name: PILOTS[id].name,
      chassis: PILOTS[id].chassis,
      xp,
      level: Math.min(MAX_PILOT_LEVEL, levelForXp(xp)),
      missions: Number.isFinite(record.missions) ? record.missions : 0,
      kills: Number.isFinite(record.kills) ? record.kills : 0,
    };
  }

  // A save with no valid pilots would be unplayable; put the crew's first
  // member back rather than refusing to load.
  if (Object.keys(profile.pilots).length === 0) profile.pilots.ash = newPilot('ash');

  return profile;
}
