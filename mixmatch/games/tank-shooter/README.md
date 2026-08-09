# NOD Tank Shooter

A twin-stick robot arena shooter. Five machines, five questions, escalating
waves, one of you leaves.

Built for the Mix & Match arcade alongside the NOD Space Shooter — same short
round, different plane and different pressure. That one is about reading a
bullet pattern; this one is about position and target priority.

```bash
npm run serve
# then open http://127.0.0.1:4321/mixmatch/games/tank-shooter/web/tank-shooter.html

npm run test:tankshooter
```

Nothing to build and nothing to fetch. Vector art, no sprites, no fonts, no
audio files — the page is self-contained so a round starts the instant it is
asked for rather than after a network round trip somebody paid a token for.

---

## Controls

| | Desktop | Touch |
| --- | --- | --- |
| Drive | `W` `A` `S` `D` or arrows | left thumb, anywhere on the left half |
| Aim | mouse | right thumb, anywhere on the right half |
| Fire | click or `Space` | right thumb held |
| Boost | `Shift` | shove the left stick past full throw |

The sticks float — each appears wherever the thumb lands, because a fixed
stick on a phone is a stick you have to look at.

---

## The design rule

An arena shooter is only interesting while the player is being asked a
question. One enemy asks one question, and two enemies that ask the same
question are one enemy with two sprites — the player learns a single answer and
both stop mattering.

So every hostile is built around a distinct pressure, and the roster is
enforced by tests rather than by intention:

| | Asks | Answer |
| --- | --- | --- |
| **Scuttler** | are you still moving? | keep moving; they die on contact |
| **Gunhead** | are you behind something? | break the sightline during the telegraph |
| **Lobber** | are you moving *predictably*? | change direction — it leads, but never perfectly |
| **Warden** | will you give up ground to get behind it? | flank it, or bring the Lance |
| **Hive** | are you shooting the right thing? | kill the hive, not the brood |

The counter-play is mechanical rather than statistical on purpose. A warden
cannot be out-damaged from the front at any fire rate — the suite asserts it
takes over eight seconds — so the answer is to move, not to hold the trigger
longer. That distinction is the whole difference between a game and a damage
race.

Three guns, and none is simply better: their best-case damage is held within
50% of each other, and whichever tops that chart has to have the shortest
reach. A gun that wins everywhere makes the pickups a lottery.

---

## Layout

```
engine/          no DOM, no canvas, no Math.random
  rng.js         seeded mulberry32
  content.js     the tank, the guns, the hostiles, the wave curve — and the mix
  sim.js         the world, one fixed 60 Hz tick at a time
web/
  tank-shooter.html   self-contained page
  render.js           canvas, vector art, effects driven off world.events
  input.js            keyboard/mouse and floating touch sticks
  main.js             the loop, the HUD, and the arcade hook
test/
  content.test.js     the balance claims
  sim.test.js         whole runs, played headless
```

The engine takes a seed and a stream of `{moveX, moveY, aim, fire, boost}` and
touches nothing else. That is what lets the suite play thousands of ticks in
milliseconds, and it is what would let a run be stored as a list of inputs and
replayed exactly.

### Why determinism matters here specifically

In an arcade charging a token a play, a disputed run — *"it spawned three
wardens at once and ate my token"* — is answerable if the seed reproduces the
run exactly, and is otherwise one person's word against a leaderboard. It is
also the only way a score could ever be checked server-side without trusting
the client's arithmetic.

`Math.hypot` is deliberately avoided for the same reason `rocketman` avoids it:
ECMA-262 leaves it implementation-approximated, and a determinism claim is only
worth as much as its least specified operation.

---

## The arcade hook

The game does not know what a token is. It announces a finished run and stops
caring:

```js
window.__nodArcade = {
  onRunComplete(result) {
    // { seed, score, wave, kills, ticks, seconds, accuracy, result }
  },
};
```

Set it before the run starts. Whatever embeds the game decides whether that
costs anything.

That split is deliberate. `mixmatch/config/tokens.js` already says an arcade
play is one token and that `arcade_play` is still `planned`; a game that
reached for a balance itself would be a second place where that price lives,
and the entire point of that module is that there is exactly one. The game is
registered in `mixmatch/config/games.js` as `unwired` — finished, playable, and
connected to no balance.

A listener that throws is caught and logged. The player has already finished
their round; whether it was recorded is not something to show them a stack
trace about.

`window.__tankShooter()` returns a small read-only snapshot for tests — the
same idea as `window.__rocketman` next door, because "the page did not throw"
is not the same fact as "the game is running."

---

## What the tests are actually for

`content.test.js` checks the claims the tables make about themselves, because
the claims *are* the game. "No two hostiles ask the same question" is a
sentence worth nothing six months from now when someone adds a sixth machine
that charges in a straight line and detonates.

`sim.test.js` plays whole runs with a deliberately mediocre bot — it cannot
dodge, cannot use cover, cannot prioritise, and retreats from everything. It is
a floor, not a target. Three bugs came out of pointing it at twenty seeds, and
none of them reproduced on the seed being developed against:

- **Hostiles wedging on cover.** They drove in straight lines with no
  avoidance, so one wall was enough to strand a scuttler permanently. A wave
  only ends when the field is clear, so the *run* never ended. Five of thirty
  seeds hung, one on wave 1.
- **A gunhead outside its own range.** Stationary, spawned at the far edge,
  660 units from a 620-unit gun. It could not close, could not fire, and could
  not die. It now redeploys when it has had no shot for a second and a half.
- **A lobber holding station behind cover.** In its standoff band, out of line
  of sight, against a player backing away — neither able to reach the other,
  forever. It now closes when blocked, and requires line of sight to fire at
  all, which the gunhead already did.

Obstacle steering fixed most of it. `WAVES.stallSeconds` is the backstop that
makes termination a property of the game rather than a thing that happens to be
true of the seeds someone tested: after 26 seconds a wave gets impatient,
standoffs collapse and everything speeds up. A player who is winning never sees
it — a clean wave resolves in well under twenty seconds.

Two more worth recording:

- **A piercing round hitting its last target twice.** The "have I hit this
  already" guard was keyed on remaining pierce, so the shot that spent its last
  pierce stopped recording hits and struck the same hostile again the following
  tick. Only ever the final target in a line, which is exactly the sort of
  thing playing does not find.
- **An arena that rendered nothing.** The canvas was sized while its screen was
  still `hidden`, so it measured zero, the zoom collapsed to zero, and the game
  ran perfectly while drawing an empty screen. Nothing threw. Only a screenshot
  found it.
