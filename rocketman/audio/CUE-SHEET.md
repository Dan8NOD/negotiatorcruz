# Rocketman — cue sheet

**Generated from `web/audio-cues.js` by `tools/audio-cue-sheet.mjs`. Do not edit by hand** — change the catalogue and regenerate, or the sheet and the game will disagree on the day you are holding a microphone.

62 cues, 238 takes if every one is recorded to its full count. Nothing here is required: any cue without a recording plays its synthesised voice instead, so this is a list you can work down in any order and ship at any point.

## What to deliver

One folder per cue under `rocketman/audio/raw/`, named exactly as the cue is named, one file per take:

```
rocketman/audio/raw/weapon.autocannon/01.wav
rocketman/audio/raw/weapon.autocannon/02.wav
rocketman/audio/raw/ack.move/01-cruz.wav
rocketman/audio/raw/music.battle/siege-of-the-yard.wav
```

Takes are ordered by filename, so name them in the order you want them heard.

| | |
| --- | --- |
| **Format in** | WAV or AIFF, 24-bit, 48 kHz or higher. FLAC is fine. Anything ffmpeg reads works, but do not hand the pack an MP3 you can hand it the original of. |
| **Level in** | Peak somewhere around −6 dBFS with no clipping anywhere. Exact level does not matter — the pack normalises — but headroom does, because a clipped source stays clipped. |
| **Processing in** | Whatever the sound needs. EQ, layering, pitch, reverb: all yours, all before it reaches the folder. |
| **Do not** | Compress or limit for loudness, add fades, or trim tight. The pack does the trim and the level, and it does them identically across two hundred files, which by hand you will not. |
| **Channels** | Record what you like. World effects are folded to mono because the game pans them itself, and a stereo source through a panner is two images fighting. Interface and music stay stereo. |

## What the pack does to it

Only the mechanical part — the part that has to be identical across every file, and which is therefore exactly the part you should not be doing by hand at two in the morning:

1. **Trim** the lead-in silence at −50 dB, and the tail gently at −70 dB. A sound effect has to fire the instant the game asks for it; 80 ms of room tone in front of a gunshot is 80 ms of latency nothing downstream can win back.
2. **Fold** world effects to mono. Interface and music stay stereo.
3. **Normalise.** Anything shorter than 0.4s is peak-normalised to −6 dBFS; anything longer is loudness-normalised to −20 LUFS (music to −16). The split is there because integrated loudness is measured over 400 ms blocks — ask for the LUFS of a 45 ms gunshot and you get a number describing the silence around it.
4. **Limit** to −1 dBTP, after everything. Inter-sample peaks over 0 are what turn a clean recording into a crackle once a lossy encoder has been near it.
5. **Encode** to Opus in WebM and AAC in M4A at 48 kHz. Two formats because Safari before 17 will not play Opus and is still live on iPads that will never update.

**Every take of every cue comes out at the same level.** That is deliberate and it is the most important thing on this page: the mix lives in the `gain` column of `web/audio-cues.js`, not in the files. A repeater firing six times a second has to sit under a mortar firing once every three seconds, whatever the two recordings happened to peak at — and that is a decision about the game, which belongs somewhere the tests can read it and somewhere you can change without re-exporting audio.

So: **do not try to balance the cues against each other while recording.** Get each one sounding right on its own. Balance is a slider, later, in a file.

## The cues

### Weapons

One per weapon, and no two alike. The rule each of these follows: a weapon should be identifiable with the screen covered. Rate of fire already separates them — a repeater at six shots a second and a mortar at one every three could share a recording and still be told apart — so push the other way and separate them by *timbre*. That is what lets you tell an autocannon from a turret gun when both are firing off-screen at a third of a second.

| Cue | Takes | Length | What it has to say |
| --- | ----: | ------ | ------------------ |
| `weapon.arcprojector` | 4 | 0.2–0.8s | Chained lightning across a splash. Crackle with a path through it. |
| `weapon.autocannon` | 6 | 0.05–0.25s | The baseline gun. Dry mechanical crack — every other weapon is read against this one. |
| `weapon.bastioncannon` | 4 | 0.25–0.8s | The Robot Marine’s main gun, one shell every two and a half seconds. The cycle *is* the fight — the counter-play is to be somewhere else between shots — so the report has to be unmistakable and the reload has to be audible in it. Heavy, but under the siege mortar: the mortar stays the biggest report in the game. |
| `weapon.beamlance` | 3 | 0.2–0.8s | Continuous energy. Tone, not transient. |
| `weapon.empprojector` | 3 | 0.2–0.8s | Disables rather than damages. It should sound like something being switched off. |
| `weapon.flakburst` | 5 | 0.1–0.35s | Airburst flak. Three pops, because one pop is just a gun. |
| `weapon.lightrockets` | 4 | 0.1–0.35s | Two rockets, not four. Thinner and brighter than the pod, and gone sooner — it has to be recognised from its first fifty milliseconds. |
| `weapon.railspike` | 4 | 0.2–0.7s | Electromagnetic. A charge, then a crack with no powder in it — this is the one that must not sound like a cannon. |
| `weapon.rocketpod` | 4 | 0.2–0.6s | Four rockets off the rail. Hiss that climbs as they leave. |
| `weapon.scattergun` | 5 | 0.15–0.5s | Twenty-six damage at three cells. It should sound like a door closing. |
| `weapon.siegemortar` | 4 | 0.3–1s | One shell every three seconds. The heaviest report in the game; it can afford weight the repeater cannot. |
| `weapon.stormrepeater` | 8 | 0.03–0.12s | Six shots a second. Each one must be small, or the burst becomes a drill. |
| `weapon.talon` | 4 | 0.2–0.6s | Tube-launched. It thumps out cold before the motor lights. |
| `weapon.thermite` | 4 | 0.2–0.7s | Incendiary. Ignition rather than detonation — a whoosh with a chemical edge. |
| `weapon.turretgun` | 6 | 0.1–0.4s | Base defence. Heavier than a mech arm, because it is bolted to the ground — this and the autocannon are the two sounds a player hears most, and they must not converge. |
| `weapon.wardrepeater` | 8 | 0.04–0.16s | The Robot Marine’s off hand, three shots a second under its own cannon. Heavier than the storm repeater and slower, but the thing it must not be mistaken for is the autocannon — that is the sound the player hears most, and a boss whose chip damage reads as their own gun is a boss they cannot hear coming. Give it a harder, flatter attack with metal in it. |

### Impacts

What a warhead sounds like when it arrives. The counter triangle is the central decision in the game, so these four must be four unmistakably different arrivals — the player is reading which warhead hit them off the sound alone, mid-fight, without looking.

| Cue | Takes | Length | What it has to say |
| --- | ----: | ------ | ------------------ |
| `impact.emp` | 5 | 0.05–0.2s | The arrival that does no damage. Crackle, and then a hole where the sound should be. |
| `impact.energy` | 5 | 0.06–0.25s | Beam meeting plate. Sizzle, not thud. |
| `impact.explosive` | 6 | 0.06–0.25s | A warhead arriving. Thud with body under it. |
| `impact.kinetic` | 6 | 0.03–0.15s | Solid shot off armour plate. A ping, high and short. |

### Abilities

Two abilities are missing on purpose. `jumpjet` and `siege` already announce themselves through `world.leapStart` and `world.deployDown`, and recording them again would double every activation.

| Cue | Takes | Length | What it has to say |
| --- | ----: | ------ | ------------------ |
| `ability.dash` | 3 | 0.4–1.2s | Afterburn. A turbine spooling up and staying up. |
| `ability.empburst` | 3 | 0.5–1.5s | Everything in four cells goes quiet, and you hear it happen. |
| `ability.overshield` | 3 | 0.4–1.5s | Aegis Field. A shield is a chord, not a bang. |
| `ability.repairfield` | 3 | 0.4–1.5s | Field Repair. Welding over a warm pad. |
| `ability.skyfall` | 3 | 0.6–1.6s | The crew signature. The loudest thing a friendly unit does — when a pilot crosses half the map, the player should know without looking that it was one of theirs. |

### World

Everything that happens at a place on the map and is not a gun. These pan and fade with distance.

| Cue | Takes | Length | What it has to say |
| --- | ----: | ------ | ------------------ |
| `world.deathBuilding` | 4 | 0.6–2s | A structure collapsing. Longer than a mech, and it ends with what is left of it hitting the ground. |
| `world.deathMech` | 5 | 0.3–1s | A machine coming apart — torn metal and a descending groan. Not another explosion: the blast already played this tick, and this is the wreck arriving. |
| `world.deathProp` | 5 | 0.2–0.9s | Scenery destroyed. Rubble, and more of it the taller the thing was. |
| `world.deployDown` | 3 | 0.15–0.6s | Siege anchors going into the ground. Two clunks, the second one lower. |
| `world.deployUp` | 3 | 0.15–0.6s | Anchors coming out. The same machine, running backwards and lighter. |
| `world.emp` | 4 | 0.2–0.7s | Splash EMP landing on something. Fires often in a fight, so it must stay small. |
| `world.explosion` | 6 | 0.2–0.8s | The ordinary blast. Most common big sound in the game. |
| `world.explosionBig` | 4 | 0.5–2s | A fuel depot, an ammo store, a chain reaction. It should make the ordinary blast sound small. |
| `world.leapEnd` | 4 | 0.1–0.5s | The landing. Without it, a jump has a take-off and no arrival and the mech reads as having teleported. |
| `world.leapStart` | 4 | 0.15–0.6s | Jump jets lighting. Take-off. |
| `world.shieldBreak` | 4 | 0.1–0.5s | Cover gone. The player must hear this over a firefight, because it is the moment their timing changes. |
| `world.superweaponFired` | 2 | 0.6–2s | A Lance leaving the rail, heard from anywhere on the map. This is the telegraph doing its job — the player has a few seconds to move, and this is how they learn that. |
| `world.superweaponImpact` | 2 | 0.8–2.5s | The Lance arriving. The largest sound in the game, and the only one allowed to be. |

### Interface

Centred, never dropped, never pitch-shifted. An interface sound that goes missing reads as an *order* that went missing and the player will click again — which is why these are protected from the voice ceiling that world sounds are subject to.

| Cue | Takes | Length | What it has to say |
| --- | ----: | ------ | ------------------ |
| `ui.built` | 3 | 0.15–0.6s | The structure standing up. A different moment from the foundation, and it must sound like a different moment. |
| `ui.click` | 2 | 0.01–0.1s | A button, a placement, a hotkey. Flat and instant. |
| `ui.defeat` | 1 | 1–4s | The mission is lost. It should land without punishing — the player is going to press retry. |
| `ui.deny` | 2 | 0.05–0.3s | That order was refused. Must be distinguishable from a click at a glance, because the player will otherwise assume the order went through. |
| `ui.deposit` | 4 | 0.05–0.25s | Scrap arriving at the refinery. Repeats all mission long, so it has to survive a thousand plays without irritating. |
| `ui.objectiveBonus` | 2 | 0.2–1s | An optional objective done. Smaller than the required one, and clearly the same family. |
| `ui.objectiveComplete` | 2 | 0.3–1.2s | A required objective done. |
| `ui.objectiveFailed` | 2 | 0.4–1.5s | An objective lost. The mission continues, which is what separates this from defeat. |
| `ui.placed` | 2 | 0.08–0.4s | A foundation going down. The order was accepted; the thing is not built yet. |
| `ui.produced` | 3 | 0.08–0.4s | A unit rolled out of a factory. |
| `ui.promoted` | 3 | 0.3–1.2s | A pilot ranked up. Good news, and the player should look. |
| `ui.reinforcement` | 2 | 0.5–2s | A pilot the crew had written off walks out of the fog. The biggest thing that happens inside a mission — it gets a fanfare. |
| `ui.repairStalled` | 2 | 0.2–0.8s | Out of scrap mid-repair. A warning, and it should sound like one rather than like a notification. |
| `ui.sold` | 2 | 0.15–0.6s | A structure sold back. Scrap returning. |
| `ui.superweaponReady` | 2 | 0.4–1.5s | The Lance is charged and yours to fire. |
| `ui.victory` | 1 | 1–4s | The mission is won. Played once, remembered for the whole campaign. |

### Acknowledgements

The crew answering an order. Half of why an RTS feels responsive is that the acknowledgement arrives before the unit has moved a pixel.

These are the one family where take count is about *people* rather than about repetition: six takes of `ack.move` should be six readings, ideally more than one voice, because the player hears them constantly and a crew that answers identically every time is one pilot in twenty cockpits. Record them dry and close; the game puts them on a radio.

| Cue | Takes | Length | What it has to say |
| --- | ----: | ------ | ------------------ |
| `ack.ability` | 5 | 0.3–1.4s | An ability going off. Keyed up. |
| `ack.attack` | 6 | 0.3–1.4s | "Engaging." Lower and harder than a move order. |
| `ack.attackmove` | 5 | 0.3–1.6s | Attack-move. The same answer held longer — you are walking them into it, and they know. |
| `ack.deny` | 4 | 0.2–1s | Refusal. Not a sound any pilot enjoys making. |
| `ack.harvest` | 4 | 0.3–1.4s | Harvesting is work, and it answers like work. |
| `ack.move` | 6 | 0.3–1.4s | "Moving out." Rising, unbothered. |
| `ack.select` | 6 | 0.15–0.8s | Selection. An ident, not an answer — the shortest thing a pilot says. |
| `ack.stop` | 4 | 0.2–1s | "Holding." One flat syllable. |

## Music

Six states. A state is not a track: each folder can hold as many pieces as you like and the game picks between them, because the fastest way to wear a score out is to attach exactly one piece of music to the screen it plays on.

| State | Loops | What it scores |
| --- | --- | --- |
| `music.menu` | yes | Front end, mission select, the pause screen. Heard before anything has happened and after everything has. |
| `music.calm` | yes | Building, scouting, harvesting. Nothing is shooting. This is the bed that plays longest, so it has to be the one that hides best. |
| `music.battle` | yes | Contact. Something of yours is trading fire with something of theirs. |
| `music.desperate` | yes | Losing. Structures burning, or the Lance charged and pointed at you. |
| `music.victory` | plays once | The mission is won. Plays once over the end screen and stops. |
| `music.defeat` | plays once | The mission is lost. Plays once, and does not gloat. |

The four looping beds form an intensity ladder — `menu`, `calm`, `battle`, `desperate`. The game climbs it one step at a time and immediately, and comes back down one step at a time only after eight seconds of nothing happening. So `calm` and `battle` will be heard *next to each other*, repeatedly, in both directions: write them in the same key and at the same tempo and the transitions stop being events.

### Getting a loop out of a generative track

Suno will not hand you a seamless loop, and the beds have to loop for as long as a mission lasts. Two ways through it, in order of how well they work:

1. **Find the loop points and declare them.** Pick a bar line a little way in and the matching bar line near the end, and put the two times in the manifest as `loopStart` and `loopEnd`. The game loops between them sample-accurately, and everything before `loopStart` becomes an intro that plays once. This is the good option: no crossfade, no drift, and the track gets to have an opening.
2. **Crossfade the seam.** Overlap the tail onto the head by a bar or two in an editor and export the result. Works on anything, costs you the intro, and a pad that swells through the seam will still audibly duck.

Ask Suno for stems if it will give them: a `calm` bed that is the `battle` bed with the drums and the low brass muted is two states that transition perfectly, because they are the same performance. That trick is most of how commercial adaptive scores are built, and it is available here for the price of an export.

Keep the beds under about three minutes. They repeat for a whole mission and the loop is doing the work anyway.

## Order of work

If you want the pack to feel finished as early as possible rather than uniformly half-done, record in this order. It is roughly frequency of hearing:

1. `weapon.autocannon`, `weapon.turretgun`, `impact.kinetic`, `impact.explosive`, `world.explosion` — the sound of an ordinary firefight, and the five a player hears ten thousand times.
2. `ui.click`, `ui.deny`, `ack.select`, `ack.move`, `ack.attack` — everything the player triggers by hand. These are heard as *responsiveness*, not as audio.
3. `music.calm` and `music.battle` — the two beds that cover almost all of a mission.
4. The rest of the weapons, then the rest of the world.
5. `ui.victory`, `ui.defeat`, `music.victory`, `music.defeat` — heard once per mission, remembered for the whole campaign. Worth doing last and doing well.

Check progress at any point with:

```
npm run rocketman:audio:check
```
