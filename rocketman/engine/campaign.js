/**
 * The campaign: "Just You and Your Rocket Crew".
 *
 * Missions are data. Each one is a world configuration plus a list of
 * objectives, so a new mission is written here and nowhere else — no
 * simulation code changes, no per-mission scripting hooks, and every objective
 * type is already covered by tests.
 *
 * The teaching order is deliberate. Each mission introduces exactly one new
 * system and then makes you use it under pressure:
 *
 *   1  movement, attacking, jump jets      — no economy at all
 *   2  harvesting and the Refinery         — economy under harassment
 *   3  power, and what a brownout costs    — offence against reactors
 *   4  defence, turrets, holding ground    — survival
 *   5  the whole loop against a real base  — tech, air, composition
 *   6  siege, range, and losing a base     — protect while you push
 *   7  everything, with the whole crew     — the finale
 *
 * The story is thin on purpose. It exists to make losing a named pilot feel
 * like something, which is the only narrative job that matters in an RTS.
 */

import { TICKS_PER_SECOND, secs } from './content.js';
import { missionRewards, PILOTS } from './progression.js';
import { DEFAULT_MAP_SIZE } from './grid.js';

/** Ticks, from minutes — mission timers read better written this way. */
const mins = (m) => Math.round(m * 60 * TICKS_PER_SECOND);

export const CAMPAIGN_TITLE = 'Just You and Your Rocket Crew';

export const CAMPAIGN_INTRO = `
The drop was supposed to put four hundred machines on the ground.

It put down eleven, across sixty kilometres, in the dark. Everything with a
transponder burned on the way in. What is left of the Ascendancy on this rock is
you, a salvage rig, and the pilots who walked away from their landing sites.

The Bulwark has been here eight years. They have reactors, foundries, and a
siege line. They do not know you are here yet.

That is the only advantage you get.
`.trim();

/**
 * A mission's `player` and `enemy` blocks are passed straight into
 * `createWorld` as player configs; `objectives` goes in as the mission.
 */
export const MISSIONS = [
  {
    id: 'hard_landing',
    index: 1,
    name: 'Hard Landing',
    subtitle: 'Sector 9 — the Coldwater flats',
    seed: 10412,
    mapSize: 112,
    reward: 400,
    parTime: mins(4),
    teaches: 'Move, attack, and use jump jets.',
    briefing: `
Ash came down eleven kilometres off-mark with two escorts and no transponder.
There is a Bulwark listening post between her and the rest of us, and the moment
it calls this in we stop being a surprise.

You have three machines. No rig, no scrap, no reinforcements. Take the post
apart before it finishes its transmission.

Ash's jump jets will carry her over the ridge line rather than around it. Use
them — walking the long way is what the post is expecting.
`.trim(),
    debrief: `
The post went dark before it finished. Nobody heard it.

Ash says the ridge is climbable in three places and that she found the salvage
rig half-buried at the bottom of the second one. It still runs.

We have an economy again. Barely.
`.trim(),
    /**
     * Someone the briefing did not know about.
     *
     * Mission one is three machines and no economy, so an unannounced fourth
     * walking out of the fog is the single biggest thing that can happen in
     * it — and a railspike is exactly the tool for a listening post you were
     * expected to walk up to.
     */
    reinforcements: [
      {
        at: secs(40),
        pilot: 'halcyon',
        message: 'Unregistered transponder on the ridge — it is one of ours.',
      },
    ],
    player: {
      faction: 'ascendancy',
      name: 'You',
      start: {
        base: false,
        collectors: 0,
        units: ['vireo', 'vireo'],
        heroes: ['ash'],
        scrap: 0,
      },
    },
    enemy: {
      faction: 'bulwark',
      isAI: true,
      difficulty: 'easy',
      start: {
        base: false,
        collectors: 0,
        units: ['tick', 'tick'],
        buildings: ['sensor', 'turret'],
        scrap: 0,
      },
    },
    objectives: [
      { kind: 'destroyStructures', player: 1, text: 'Destroy the Bulwark listening post' },
    ],
    bonusObjectives: [
      { kind: 'protect', pilot: 'ash', text: 'Bring Ash home alive', reward: 200 },
    ],
  },

  {
    id: 'scrap_rights',
    index: 2,
    name: 'Scrap Rights',
    subtitle: 'The Coldwater wrecks',
    seed: 20887,
    mapSize: 128,
    reward: 500,
    parTime: mins(7),
    teaches: 'Harvesting, the Refinery, and defending an economy.',
    briefing: `
The flats are one enormous debris field — eight years of Bulwark write-offs,
none of it guarded, because until this morning there was nobody to guard it
from.

Get the rig working. Build a Refinery so the Collectors have somewhere closer
than the Command Rig to unload, and pull four thousand out of the ground.

The Bulwark will notice. They will send exactly enough to check, and not enough
to matter. Do not let that give you ideas.
`.trim(),
    debrief: `
Four thousand, and the field is barely scratched.

Box turned up on foot two days later, dragging a lance assembly behind him. He
had walked forty kilometres and his first question was whether we had a Foundry
yet. We do now.
`.trim(),
    player: {
      faction: 'ascendancy',
      start: {
        scrap: 2500,
        collectors: 3,
        units: ['vireo'],
        heroes: ['ash', 'nim', 'halcyon'],
      },
    },
    enemy: {
      faction: 'bulwark',
      isAI: true,
      difficulty: 'easy',
      start: { scrap: 3000 },
    },
    objectives: [
      { kind: 'accumulate', player: 0, amount: 4000, text: 'Mine 4,000 scrap' },
      { kind: 'build', player: 0, defId: 'refinery', count: 1, text: 'Build a Refinery' },
    ],
    bonusObjectives: [
      { kind: 'build', player: 0, defId: 'foundry', count: 1, text: 'Build a Foundry', reward: 150 },
    ],
  },

  {
    id: 'brownout',
    index: 3,
    name: 'Brownout',
    subtitle: 'Bulwark forward station Kesh',
    seed: 31174,
    mapSize: 128,
    reward: 650,
    parTime: mins(8),
    teaches: 'Power. What a brownout does to the other side.',
    briefing: `
Station Kesh is a wall of turrets. Attacking it head-on is how you lose a crew.

Box has a better idea, and he built the place, so listen to him: the turrets are
on the same grid as everything else. Kill the reactors and the guns go quiet —
all of them, at once, until the Bulwark rebuilds.

Take out both reactors first. Then walk in.

The same is true of your base, incidentally. Build your own power *before* you
need it.
`.trim(),
    debrief: `
Box was right. The moment the second reactor went up the whole line went dark,
and we walked through a turret emplacement that could not fire.

He did not say anything about it afterwards. He just sat in the Ember with the
canopy open for about an hour.
`.trim(),
    reinforcements: [
      {
        at: secs(75),
        pilot: 'roan',
        message: 'Roan Ijaz walked out of the crater field. He brought a Cinder.',
      },
    ],
    player: {
      faction: 'ascendancy',
      start: {
        scrap: 5000,
        collectors: 4,
        units: ['vireo', 'kestrel'],
        heroes: ['ash', 'nim', 'box', 'halcyon'],
        buildings: ['refinery'],
      },
    },
    enemy: {
      faction: 'bulwark',
      isAI: true,
      difficulty: 'normal',
      start: { scrap: 6000, buildings: ['reactor', 'reactor', 'turret', 'turret'] },
    },
    objectives: [
      {
        kind: 'destroyCount',
        player: 1,
        defId: 'reactor',
        count: 2,
        text: 'Destroy two Bulwark reactors',
      },
      { kind: 'destroyStructures', player: 1, text: 'Level the station' },
    ],
    bonusObjectives: [
      { kind: 'build', player: 0, defId: 'techlab', count: 1, text: 'Build a Tech Lab', reward: 200 },
    ],
  },

  {
    id: 'anvil_line',
    index: 4,
    name: 'The Anvil Line',
    subtitle: 'Coldwater, the long night',
    seed: 44021,
    mapSize: 128,
    reward: 800,
    parTime: null,
    teaches: 'Defence. Turrets, power discipline, and holding ground.',
    briefing: `
They know. Whatever Kesh managed to transmit before it went dark was enough.

There is an Anvil column coming across the flats and we cannot beat it in the
open. We do not have to. We have to still be here in six minutes.

Turrets. Reactors to run them. Keep the Command Rig standing — if we lose the
rig we lose the campaign, not the mission.
`.trim(),
    debrief: `
Six minutes. We counted every one of them.

The line broke about forty seconds before the relief window and Sable brought
the last of them down with an EMP burst she had been holding since the start,
because she thought we might need it more later.

She was right about that too.
`.trim(),
    player: {
      faction: 'ascendancy',
      start: {
        scrap: 7000,
        collectors: 5,
        units: ['kestrel', 'vireo', 'vireo'],
        heroes: ['ash', 'nim', 'box', 'sable', 'halcyon', 'roan'],
        buildings: ['refinery', 'foundry', 'reactor'],
        tech: ['techlab'],
      },
    },
    enemy: {
      faction: 'bulwark',
      isAI: true,
      difficulty: 'hard',
      start: { scrap: 9000, buildings: ['reactor', 'refinery', 'foundry'] },
    },
    objectives: [
      { kind: 'survive', ticks: mins(6), text: 'Hold for six minutes' },
      { kind: 'protect', player: 0, defId: 'command', atLeast: 1, text: 'The Command Rig must survive' },
    ],
    bonusObjectives: [
      { kind: 'build', player: 0, defId: 'turret', count: 4, text: 'Emplace four turrets', reward: 200 },
    ],
  },

  {
    id: 'cold_open',
    index: 5,
    name: 'Cold Open',
    subtitle: 'Bulwark manufactory, grid 4',
    seed: 52630,
    mapSize: 144,
    reward: 1000,
    parTime: mins(12),
    teaches: 'The whole loop: tech, air, and army composition.',
    briefing: `
No tricks this time. They have a working base and so do you.

Wren has the Harrier flying, which means we finally have something that ignores
terrain — and something that dies instantly to flak, so look before you commit
her.

Everything you have learned. Take the manufactory apart.
`.trim(),
    debrief: `
It took most of a day and we lost machines we could not replace, but grid 4 is
gone and with it their nearest source of Anvils.

Wren landed with two-thirds of a wing and asked when we were going again.
`.trim(),
    /**
     * The one the campaign has been holding back. Ghost was written off with
     * the third wave; he arrives in the middle of the hardest fight in the
     * game, driving Bulwark hardware he did not ask permission for.
     */
    reinforcements: [
      {
        at: mins(2.5),
        pilot: 'ghost',
        message: 'Bulwark contact in our rear — belay that. It is Solveig. He is alive.',
      },
    ],
    player: {
      faction: 'ascendancy',
      start: {
        scrap: 7000,
        collectors: 4,
        units: ['kestrel', 'vireo'],
        heroes: ['ash', 'nim', 'box', 'sable', 'wren', 'halcyon', 'roan'],
        // "They have a working base and so do you" — the briefing's words. A
        // player opening with one Refinery against five structures is not that
        // mission, and once veterancy exists an early deficit compounds
        // instead of merely hurting.
        // "No tricks this time. They have a working base and so do you" — so
        // the two sides open level. The briefing also has Wren flying a
        // Harrier, which is tier-two tech; a player who cannot build a second
        // one is being sold a mission the setup does not give them.
        //
        // This mission is deliberately the closest fight in the campaign, and
        // veterancy makes early trades compound. If a balance change ever
        // tips it, the campaign-completable test goes red rather than a
        // player discovering it.
        buildings: ['refinery', 'foundry', 'reactor', 'techlab'],
      },
    },
    enemy: {
      faction: 'bulwark',
      isAI: true,
      difficulty: 'normal',
      start: { scrap: 7000, buildings: ['reactor', 'refinery', 'foundry', 'techlab'] },
    },
    objectives: [{ kind: 'destroyStructures', player: 1, text: 'Destroy the manufactory' }],
    bonusObjectives: [
      {
        kind: 'field',
        player: 0,
        defId: 'harrier',
        count: 3,
        text: 'Field three Harriers at once',
        reward: 250,
      },
    ],
  },

  {
    id: 'longbow_country',
    index: 6,
    name: 'Longbow Country',
    subtitle: 'The shelf above Coldwater',
    seed: 61905,
    mapSize: 144,
    reward: 1200,
    parTime: mins(10),
    teaches: 'Siege. Range you cannot answer, and a base you cannot abandon.',
    briefing: `
They have moved Longbows onto the shelf. Deployed, those things outrange every
turret we own — they can shell the rig from ground we cannot shoot back at.

So do not shoot back. Get on top of them. Ash goes over the shelf wall rather
than up the ramp; Sable holds them still when she gets there.

The rig has to survive this. There is no second rig.
`.trim(),
    debrief: `
Four Longbows, all of them deployed, none of them able to depress far enough to
hit something already standing on them.

Ash came back with her left shoulder assembly gone and no memory of losing it.
The rig is intact. That was the whole job.
`.trim(),
    player: {
      faction: 'ascendancy',
      start: {
        scrap: 8000,
        collectors: 5,
        units: ['kestrel', 'kestrel', 'vireo'],
        heroes: ['ash', 'nim', 'box', 'sable', 'wren', 'halcyon', 'roan', 'ghost'],
        buildings: ['refinery', 'foundry', 'reactor', 'techlab'],
      },
    },
    enemy: {
      faction: 'bulwark',
      isAI: true,
      difficulty: 'hard',
      start: {
        scrap: 12000,
        units: ['longbow', 'longbow', 'longbow', 'anvil', 'anvil'],
        buildings: ['reactor', 'reactor', 'refinery', 'foundry', 'techlab', 'turret'],
      },
    },
    objectives: [
      { kind: 'destroyCount', player: 1, defId: 'longbow', count: 3, text: 'Destroy the siege line' },
      { kind: 'protect', player: 0, defId: 'command', atLeast: 1, text: 'The Command Rig must survive' },
    ],
    bonusObjectives: [
      { kind: 'destroyStructures', player: 1, text: 'Clear the shelf entirely', reward: 300 },
    ],
  },

  {
    id: 'rocket_crew',
    index: 7,
    name: 'Just You and Your Rocket Crew',
    subtitle: 'Bulwark central command',
    seed: 70777,
    mapSize: 144,
    reward: 2000,
    parTime: mins(15),
    teaches: null,
    briefing: `
Eleven machines came down. Five pilots walked away. Everything since then has
been built out of things the Bulwark threw away.

Central command is the last of it. Every reactor, every foundry, the siege
reserve, and whoever has been giving the orders for eight years.

Take the whole thing.

It is just you and your rocket crew. It was always going to be.
`.trim(),
    debrief: `
Central command fell at 04:12 local.

Ash flew the last approach with her jets on empty and put the Kestrel through
the roof of the command structure, which is not a manoeuvre and is not in any
manual, and worked.

The Ascendancy has one rig, one field base, and five pilots on this rock.

It is enough. It was always going to be.
`.trim(),
    player: {
      faction: 'ascendancy',
      start: {
        scrap: 9000,
        collectors: 6,
        units: ['kestrel', 'kestrel', 'ember', 'vireo'],
         heroes: ['ash', 'nim', 'box', 'sable', 'wren', 'halcyon', 'roan', 'ghost'],
        buildings: ['refinery', 'foundry', 'reactor', 'reactor', 'techlab'],
      },
    },
    enemy: {
      faction: 'bulwark',
      isAI: true,
      difficulty: 'hard',
      start: {
        scrap: 16000,
        units: ['anvil', 'anvil', 'longbow', 'ward', 'vulture'],
        buildings: [
          'reactor',
          'reactor',
          'reactor',
          'refinery',
          'refinery',
          'foundry',
          'techlab',
          'hangar',
          'turret',
          'turret',
        ],
      },
    },
    objectives: [
      { kind: 'destroyStructures', player: 1, text: 'Destroy Bulwark central command' },
    ],
    bonusObjectives: [
      { kind: 'protect', pilot: 'ash', text: 'Every pilot comes home', reward: 500 },
    ],
  },
];

export function missionById(id) {
  return MISSIONS.find((m) => m.id === id) || null;
}

export function missionByIndex(index) {
  return MISSIONS[index] || null;
}

/**
 * Turn a mission plus a saved profile into `createWorld` options.
 *
 * The profile contributes the loadout — purchased upgrades, and the pilots at
 * whatever level they have reached — while the mission contributes the map,
 * the opening forces and the objectives. Neither knows about the other, which
 * is what lets a mission be replayed with a stronger crew.
 */
export function missionWorldConfig(mission, profile = { upgrades: [], pilots: {} }) {
  const pilots = Object.entries(profile.pilots || {}).map(([id, record]) => ({
    id,
    name: record.name,
    chassis: record.chassis,
    level: record.level || 1,
  }));

  return {
    seed: mission.seed,
    mapSize: mission.mapSize || DEFAULT_MAP_SIZE,
    mission,
    players: [
      {
        ...mission.player,
        name: mission.player.name || 'You',
        upgrades: profile.upgrades || [],
        pilots,
      },
      { ...mission.enemy },
    ],
  };
}

/**
 * Read a finished world into everything the debrief screen and the profile
 * need. Pure: it inspects the world and returns a summary without touching
 * either the world or the profile.
 */
export function missionOutcome(world, mission) {
  const player = world.players[0];
  const won = world.result === 'won';

  const stats = {
    ticks: world.tick,
    killed: player.stats.killed,
    lost: player.stats.lost,
    mined: player.scrapMined,
  };

  const rewards = missionRewards(mission, stats);

  // Bonus objectives pay out only on a win; clearing one in a mission you then
  // lose is not an achievement, it is a consolation prize.
  const bonuses = world.objectives.filter((o) => o.optional);
  const cleared = bonuses.filter((o) => o.complete || (o.standing && !o.failed));
  const bonusSalvage = won ? cleared.reduce((n, o) => n + (o.reward || 0), 0) : 0;

  // XP is per pilot, weighted by what they personally destroyed, plus a flat
  // share for turning up — a scout who spotted for the whole mission and shot
  // nothing should still come out of it better than they went in.
  const fielded = (mission.player && mission.player.start && mission.player.start.heroes) || [];
  const participation = won ? Math.round(rewards.xp * 0.4) : Math.round(rewards.xp * 0.15);
  const pilotXp = {};
  for (const id of fielded) {
    if (!PILOTS[id]) continue;
    const record = world.pilotKills[id];
    pilotXp[id] = participation + (record ? Math.round(record.value * 0.35) : 0);
  }

  return {
    won,
    rewards,
    bonusSalvage,
    bonusesCleared: cleared.length,
    bonusTotal: bonuses.length,
    pilotXp,
    pilotsLost: [...world.pilotsLost],
    stats,
    objectives: world.objectives.map((o) => ({
      key: o.key,
      text: o.text,
      optional: o.optional,
      complete: o.complete,
      failed: o.failed,
      standing: o.standing,
    })),
  };
}

export { mins };
