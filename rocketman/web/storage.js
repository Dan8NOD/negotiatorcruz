/**
 * Save-file persistence.
 *
 * The only file in the project that knows localStorage exists. engine/profile.js
 * owns what a profile *is*; this owns getting it in and out of the browser, so
 * the entire progression system stays testable without a DOM.
 *
 * Every path here is defensive. localStorage throws in private-mode Safari, is
 * absent in some embedded webviews, and can contain anything at all — none of
 * which should cost a player their campaign or crash the page. The fallback is
 * an in-memory profile: the session still plays, it just does not persist.
 */

import { createProfile, serialize, deserialize } from '../engine/profile.js';

const KEY = 'rocketman.profile.v1';

let memoryFallback = null;
let warned = false;

function store() {
  try {
    const ls = window.localStorage;
    // Presence is not enough — Safari's private mode throws only on write.
    const probe = '__rocketman_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    if (!warned) {
      warned = true;
      // eslint-disable-next-line no-console
      console.warn('Rocketman: local storage unavailable — campaign progress will not persist.');
    }
    return null;
  }
}

export function loadProfile() {
  const ls = store();
  if (!ls) return memoryFallback || (memoryFallback = createProfile());

  const raw = ls.getItem(KEY);
  if (!raw) return createProfile();
  // deserialize is already hardened against a corrupt or hand-edited save.
  return deserialize(raw);
}

export function saveProfile(profile) {
  const ls = store();
  if (!ls) {
    memoryFallback = profile;
    return false;
  }
  try {
    ls.setItem(KEY, serialize(profile));
    return true;
  } catch {
    // Quota exhausted, or storage revoked mid-session. Keep playing.
    memoryFallback = profile;
    return false;
  }
}

export function clearProfile() {
  const ls = store();
  memoryFallback = null;
  if (ls) {
    try {
      ls.removeItem(KEY);
    } catch {
      /* nothing useful to do */
    }
  }
  return createProfile();
}

/** True when progress is only being held in memory for this page load. */
export function isEphemeral() {
  return store() === null;
}

/* ------------------------------------------------------------ match saves -- */

/*
 * The in-progress match, stored beside the profile under its own key. The
 * format is engine/replay.js's serialised recording — config plus command log —
 * so "load" here is only custody of the string; whether it still *means* a
 * match is deserializeMatch's call, made at read time, every time.
 *
 * One key, one *plate*. A gateway chains straight into the next map of a run
 * (see `run` in main.js), and a chain is several worlds — which one recording
 * cannot describe, and which a second save format holding the finished plates
 * would describe only until it disagreed with the profile it was derived from.
 * So the key always holds the plate currently being played, and Resume offers
 * that plate and nothing else. Nothing earned is at stake: every plate writes
 * its salvage, XP and discoveries into the profile the moment it ends, so what
 * a reload mid-chain costs is the combined debrief, not the run.
 */

const MATCH_KEY = 'rocketman.match.v1';
let memoryMatch = null;

export function saveMatch(serialized) {
  const ls = store();
  if (!ls) {
    memoryMatch = serialized;
    return false;
  }
  try {
    ls.setItem(MATCH_KEY, serialized);
    return true;
  } catch {
    // A full quota mid-match should degrade to "resume works until the tab
    // closes", not to a throw inside the game loop.
    memoryMatch = serialized;
    return false;
  }
}

export function loadMatch() {
  const ls = store();
  if (!ls) return memoryMatch;
  try {
    return ls.getItem(MATCH_KEY);
  } catch {
    return memoryMatch;
  }
}

export function clearMatch() {
  memoryMatch = null;
  const ls = store();
  if (ls) {
    try {
      ls.removeItem(MATCH_KEY);
    } catch {
      /* nothing useful to do */
    }
  }
}
