const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const TICK_RATE = 30;
const W = 800, H = 600;

// --- Players -----------------------------------------------------------
const WALK_SPEED = 2;
const RUN_SPEED = 4.2;
const GHOST_SPEED = 2.5;
const PLAYER_SIZE = 28;
const PICKUP_RANGE = 40;
const DOOR_RANGE = 50;
// Clients draw the beam from these too, so what you see is what it feels
const FLASHLIGHT = { range: 170, halfAngle: 0.38 }; // about 22 degrees each side
const HIDE_RANGE = 36;
const PLAYER_COLORS = [0x4caf50, 0x42a5f5, 0xffa726, 0xec407a, 0xab47bc, 0x26c6da];

// --- Noise -------------------------------------------------------------
// Noise is local: every sound is a ring with a radius. The monster only
// hears rings that reach it, and every wall in between halves the radius.
const WALK_STEP_EVERY = 16;  // ticks between footsteps
const RUN_STEP_EVERY = 8;
const WALK_STEP_RADIUS = 55;
const RUN_STEP_RADIUS = 190;
const DOOR_CREAK_RADIUS = 110;   // opening a door carefully
const DOOR_SLAM_RADIUS = 350;    // running into a closed door
const DOOR_CLOSE_RADIUS = 80;
const MONSTER_DOOR_RADIUS = 220; // only drawn, it doesn't hear itself
const WALL_DAMPING = 0.5;
const HEARING_GAIN = 0.12;   // alertness gained per pixel the ring overshoots the monster
const NOISE_RING_TICKS = 24; // how long the client shows a ring

// --- Monster -----------------------------------------------------------
const MONSTER_SIZE = 44;
const STIR_AT = 35;          // stops snoring, rolls over
const WAKE_AT = 70;          // gets up to investigate
const ALERT_DECAY = 0.08;
const BUMP_RANGE = 45;       // walking into a sleeping monster is a bad idea
const VISION = 180;
const CHASE_VISION = 260;
const CATCH_RANGE = 28;
const HIDE_SEEN_RANGE = 110; // hiding right in front of it doesn't work
const INVESTIGATE_SPEED = 1.6;
const RETURN_SPEED = 1.3;
const SEARCH_TICKS = 100;
const LIGHT_ALERT = 1.2;     // per tick a flashlight is in its face while asleep
const STUCK_TICKS = 45;

// --- Map ---------------------------------------------------------------
// Kitchen top-left, bedroom top-right, hall bottom-left, living room
// bottom-right. Gaps in the walls are doorways.
const EXIT = { x: 20, y: 520, w: 120, h: 60 };

const WALLS = [
  { x: 0, y: 0, w: 800, h: 10 },
  { x: 0, y: 590, w: 800, h: 10 },
  { x: 0, y: 0, w: 10, h: 600 },
  { x: 790, y: 0, w: 10, h: 600 },

  { x: 390, y: 10, w: 20, h: 170 },
  { x: 390, y: 260, w: 20, h: 180 },
  { x: 390, y: 520, w: 20, h: 70 },

  { x: 10, y: 290, w: 240, h: 20 },
  { x: 330, y: 290, w: 60, h: 20 },

  { x: 410, y: 290, w: 260, h: 20 },
  { x: 750, y: 290, w: 40, h: 20 },
];

// Doors fill the wall gaps. A closed door is a wall for movement, light,
// sight and sound. They stay however the last person left them.
const DOORS = [
  { x: 390, y: 180, w: 20, h: 80 }, // kitchen <-> bedroom
  { x: 390, y: 440, w: 20, h: 80 }, // hall <-> living room
  { x: 250, y: 290, w: 80, h: 20 }, // kitchen <-> hall
  { x: 670, y: 290, w: 80, h: 20 }, // bedroom <-> living room
];
const DOOR_CLOSED_CHANCE = 0.5; // per door, at the start of each night

const ROOMS = [
  { name: "Kitchen", x: 10, y: 10, w: 380, h: 280, floor: 0x2a2f2a },
  { name: "Bedroom", x: 410, y: 10, w: 380, h: 280, floor: 0x2f2626 },
  { name: "Hall", x: 10, y: 310, w: 380, h: 280, floor: 0x26262c },
  { name: "Living room", x: 410, y: 310, w: 380, h: 280, floor: 0x2c2a24 },
];

const HIDES = [
  { name: "Pantry", x: 35, y: 150 },
  { name: "Wardrobe", x: 765, y: 150 },
  { name: "Under the couch", x: 760, y: 420 },
  { name: "Coat closet", x: 360, y: 345 },
];

const MONSTER_BEDS = [
  { x: 600, y: 120 }, // bedroom
  { x: 600, y: 500 }, // living room couch
  { x: 200, y: 140 }, // passed out in the kitchen
];

const LOOT_SPOTS = [
  { x: 80, y: 80 }, { x: 200, y: 60 }, { x: 320, y: 110 }, { x: 120, y: 230 }, { x: 310, y: 240 },
  { x: 480, y: 60 }, { x: 720, y: 70 }, { x: 520, y: 230 }, { x: 740, y: 240 }, { x: 660, y: 190 },
  { x: 480, y: 380 }, { x: 700, y: 360 }, { x: 540, y: 550 }, { x: 740, y: 540 }, { x: 640, y: 430 },
  { x: 250, y: 380 },
];

// `loud` is added to every footstep radius while carrying it.
// `slow` multiplies movement speed. Cheap and quiet vs. valuable and loud.
const LOOT_POOL = [
  { name: "Ring", value: 100, loud: 0, slow: 1 },
  { name: "Watch", value: 150, loud: 5, slow: 1 },
  { name: "Game console", value: 220, loud: 25, slow: 1 },
  { name: "Laptop", value: 250, loud: 30, slow: 1 },
  { name: "Silverware", value: 200, loud: 70, slow: 1 },
  { name: "Vase", value: 300, loud: 40, slow: 0.85 },
  { name: "Old TV", value: 350, loud: 140, slow: 0.65 },
  { name: "Diamond necklace", value: 400, loud: 10, slow: 1 },
  { name: "Painting", value: 500, loud: 70, slow: 0.8 },
  { name: "Golden statue", value: 700, loud: 110, slow: 0.6 },
];
const LOOT_PER_NIGHT = 7;

// Each night the quota grows and the monster gets sharper
function quotaFor(night) { return 300 + (night - 1) * 250; }
function hearingFor(night) { return 1 + 0.15 * (night - 1); }
function chaseSpeedFor(night) { return Math.min(4.0, 3.3 + 0.15 * (night - 1)); }
function sleepwalkChanceFor(night) { return (night - 1) / (TICK_RATE * 45); }

// --- State -------------------------------------------------------------
// The server owns all game state. Clients only send input and render.
const state = {
  players: {},
  monster: null,
  loot: [],
  doors: DOORS.map((d) => ({ ...d, open: true })),
  noises: [],
  events: [],
  night: 1,
  quota: quotaFor(1),
  score: 0,
  bank: 0,
  gameOver: false,
  result: null,
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// --- Geometry ----------------------------------------------------------
function solids() {
  return WALLS.concat(state.doors.filter((d) => !d.open));
}

function boxOverlaps(x, y, size, r) {
  const half = size / 2;
  return x + half > r.x && x - half < r.x + r.w && y + half > r.y && y - half < r.y + r.h;
}

function boxHitsWalls(x, y, size, rects = solids()) {
  return rects.some((r) => boxOverlaps(x, y, size, r));
}

function closedDoorAt(x, y, size) {
  return state.doors.findIndex((d) => !d.open && boxOverlaps(x, y, size, d));
}

function insideZone(x, y, zone) {
  return x > zone.x && x < zone.x + zone.w && y > zone.y && y < zone.y + zone.h;
}

function pointInWall(x, y) {
  return solids().some((w) => insideZone(x, y, w));
}

// Walks the segment in small steps and counts how many walls it enters
function wallsBetween(a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / 6));
  let count = 0, inWall = false;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const now = pointInWall(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    if (now && !inWall) count++;
    inWall = now;
  }
  return count;
}

function canSee(a, b, range) {
  return Math.hypot(b.x - a.x, b.y - a.y) < range && wallsBetween(a, b) === 0;
}

// --- Pathfinding -------------------------------------------------------
// Grid BFS. The house is small enough that recomputing every tick is cheap.
// Doors are left out of the grid on purpose: the monster just opens them.
const CELL = 20;
const GRID_W = W / CELL;
const GRID_H = H / CELL;

const walkable = [];
for (let cy = 0; cy < GRID_H; cy++) {
  walkable[cy] = [];
  for (let cx = 0; cx < GRID_W; cx++) {
    walkable[cy][cx] = !boxHitsWalls(cx * CELL + CELL / 2, cy * CELL + CELL / 2, MONSTER_SIZE, WALLS);
  }
}

function toCell(pos) {
  return {
    cx: Math.max(0, Math.min(GRID_W - 1, Math.floor(pos.x / CELL))),
    cy: Math.max(0, Math.min(GRID_H - 1, Math.floor(pos.y / CELL))),
  };
}

// Returns the next point to walk to on the way to `target`. If the target
// cell is unreachable (players can hug walls), aims for the closest one.
function nextStepTowards(from, target) {
  const start = toCell(from);
  const goal = toCell(target);
  if (start.cx === goal.cx && start.cy === goal.cy) return target;

  const key = (c) => c.cy * GRID_W + c.cx;
  const cameFrom = new Map([[key(start), null]]);
  const queue = [start];
  let closest = start, closestDist = Infinity;

  while (queue.length > 0) {
    const cur = queue.shift();
    const d = Math.hypot(cur.cx - goal.cx, cur.cy - goal.cy);
    if (d < closestDist) { closest = cur; closestDist = d; }
    if (d === 0) break;

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = { cx: cur.cx + dx, cy: cur.cy + dy };
      if (next.cx < 0 || next.cy < 0 || next.cx >= GRID_W || next.cy >= GRID_H) continue;
      if (!walkable[next.cy][next.cx] || cameFrom.has(key(next))) continue;
      cameFrom.set(key(next), cur);
      queue.push(next);
    }
  }

  if (key(closest) === key(start)) return target;
  let step = closest;
  while (cameFrom.get(key(step)) && key(cameFrom.get(key(step))) !== key(start)) {
    step = cameFrom.get(key(step));
  }
  return { x: step.cx * CELL + CELL / 2, y: step.cy * CELL + CELL / 2 };
}

// Step towards a point axis by axis so it slides along walls.
// Bumping into a closed door makes it stop and open it.
function moveMonsterTowards(target, speed) {
  const m = state.monster;
  if (m.pause > 0) {
    m.pause--;
    return;
  }
  const step = nextStepTowards(m, target);
  const dx = step.x - m.x, dy = step.y - m.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return;
  const move = Math.min(speed, dist);

  const oldX = m.x, oldY = m.y;
  m.x += (dx / dist) * move;
  if (boxHitsWalls(m.x, m.y, MONSTER_SIZE)) {
    monsterOpensDoor();
    m.x = oldX;
  }
  m.y += (dy / dist) * move;
  if (boxHitsWalls(m.x, m.y, MONSTER_SIZE)) {
    monsterOpensDoor();
    m.y = oldY;
  }
}

function monsterOpensDoor() {
  const m = state.monster;
  const door = closedDoorAt(m.x, m.y, MONSTER_SIZE);
  if (door === -1) return;
  // Slow and deliberate while prowling, straight through while chasing
  const chasing = m.status === "CHASING";
  openDoor(door, chasing ? "slam" : "monster");
  m.pause = chasing ? 6 : 24;
}

// --- Doors -------------------------------------------------------------
function doorCenter(d) {
  return { x: d.x + d.w / 2, y: d.y + d.h / 2 };
}

// `kind` is creak, slam or monster. Players' door noises are made where
// they stand so a door doesn't muffle its own sound. The monster's are
// only drawn: it doesn't wake itself up.
function openDoor(i, kind, by = null) {
  const d = state.doors[i];
  d.open = true;
  const c = doorCenter(d);
  state.events.push({ type: "door", kind, x: c.x, y: c.y });
  if (!by) {
    const r = kind === "slam" ? DOOR_SLAM_RADIUS : MONSTER_DOOR_RADIUS;
    state.noises.push({ x: c.x, y: c.y, r, age: 0 });
  } else {
    makeNoise(by.x, by.y, kind === "slam" ? DOOR_SLAM_RADIUS : DOOR_CREAK_RADIUS);
  }
}

function closeDoor(i, by) {
  const d = state.doors[i];
  d.open = false;
  const c = doorCenter(d);
  state.events.push({ type: "door", kind: "close", x: c.x, y: c.y });
  makeNoise(by.x, by.y, DOOR_CLOSE_RADIUS);
}

// A door can't shut on someone standing in the doorway
function doorBlocked(d) {
  const m = state.monster;
  if (boxOverlaps(m.x, m.y, MONSTER_SIZE, d)) return true;
  return Object.values(state.players).some((p) =>
    !p.caught && !p.escaped && boxOverlaps(p.x, p.y, PLAYER_SIZE, d)
  );
}

function nearestDoor(p) {
  let best = -1, bestDist = DOOR_RANGE;
  state.doors.forEach((d, i) => {
    const c = doorCenter(d);
    const dist = Math.hypot(p.x - c.x, p.y - c.y);
    if (dist < bestDist) { best = i; bestDist = dist; }
  });
  return best;
}

// --- Game flow ---------------------------------------------------------
function spawnPlayer(p) {
  p.x = 180 + Math.random() * 120;
  p.y = 470 + Math.random() * 60;
  p.carrying = -1;
  p.hidden = -1;
  p.hideSeen = false;
  p.caught = false;
  p.escaped = false;
  p.stepTimer = 0;
}

function startNight(night) {
  const bed = pick(MONSTER_BEDS);
  const spots = shuffle(LOOT_SPOTS.filter((s) => Math.hypot(s.x - bed.x, s.y - bed.y) > 60));
  const items = shuffle(LOOT_POOL).slice(0, LOOT_PER_NIGHT);

  state.night = night;
  state.quota = quotaFor(night);
  state.score = 0;
  state.gameOver = false;
  state.result = null;
  state.noises = [];
  state.events = [];
  state.monster = {
    x: bed.x, y: bed.y, home: bed,
    status: "SLEEPING", alert: 0,
    target: null, timer: 0, stuck: 0, pause: 0, chaseId: null, lastSeen: null,
  };
  for (const d of state.doors) d.open = Math.random() >= DOOR_CLOSED_CHANCE;
  state.loot = items.map((item, i) => ({ ...item, ...spots[i], carriedBy: null, secured: false }));
  for (const id in state.players) spawnPlayer(state.players[id]);
}

function endRun(result) {
  state.gameOver = true;
  state.result = result;
  if (result === "CLEARED") state.bank += state.score;
}

startNight(1);

function dropItem(p) {
  if (p.carrying === -1) return;
  const item = state.loot[p.carrying];
  item.carriedBy = null;
  item.x = p.x;
  item.y = p.y + 18;
  p.carrying = -1;
}

function catchPlayer(p) {
  dropItem(p);
  p.caught = true;
  p.hidden = -1;
  p.hideSeen = false;
  state.events.push({ type: "caught", x: p.x, y: p.y });

  const m = state.monster;
  m.status = "SEARCHING";
  m.timer = SEARCH_TICKS;
  m.chaseId = null;

  const alive = Object.values(state.players).filter((q) => !q.caught);
  if (alive.length === 0) endRun("DEAD");
}

// Every sound goes through here so the monster can react to it
function makeNoise(x, y, radius) {
  state.noises.push({ x, y, r: radius, age: 0 });

  const m = state.monster;
  const effective = radius * Math.pow(WALL_DAMPING, wallsBetween({ x, y }, m));
  const dist = Math.hypot(m.x - x, m.y - y);
  if (dist >= effective) return;

  if (m.status === "SLEEPING" || m.status === "STIRRING") {
    m.alert += (effective - dist) * HEARING_GAIN * hearingFor(state.night);
    m.target = { x, y };
  } else if (m.status !== "CHASING") {
    m.status = "INVESTIGATING";
    m.target = { x, y };
  }
}

function startChase(id) {
  const m = state.monster;
  if (m.status !== "CHASING") state.events.push({ type: "chase" });
  m.status = "CHASING";
  m.chaseId = id;
  const p = state.players[id];
  m.lastSeen = { x: p.x, y: p.y };
}

// Id of a player whose flashlight beam is on the monster, if any.
// Shining it in its face wakes it up; shining it at it awake gives you away.
function shiningPlayer() {
  const m = state.monster;
  for (const id in state.players) {
    const p = state.players[id];
    if (p.caught || p.escaped || p.hidden !== -1) continue;
    const dist = Math.hypot(m.x - p.x, m.y - p.y);
    if (dist > FLASHLIGHT.range + MONSTER_SIZE / 2) continue;

    // Its body is wide, so an edge of the beam is enough
    let diff = Math.atan2(m.y - p.y, m.x - p.x) - p.aim;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const bodyAngle = Math.atan2(MONSTER_SIZE / 2, dist);
    if (Math.abs(diff) > FLASHLIGHT.halfAngle + bodyAngle) continue;

    if (wallsBetween(p, m) === 0) return id;
  }
  return null;
}

function visiblePlayer(range) {
  const m = state.monster;
  for (const id in state.players) {
    const p = state.players[id];
    if (p.caught || p.escaped || p.hidden !== -1) continue;
    if (canSee(m, p, range)) return id;
  }
  return null;
}

function updateMonster() {
  const m = state.monster;
  const asleep = m.status === "SLEEPING" || m.status === "STIRRING";
  const shining = shiningPlayer();

  if (asleep) {
    if (shining) {
      const p = state.players[shining];
      m.alert += LIGHT_ALERT * hearingFor(state.night);
      m.target = { x: p.x, y: p.y };
    }
    for (const p of Object.values(state.players)) {
      if (p.caught || p.escaped || Math.hypot(p.x - m.x, p.y - m.y) >= BUMP_RANGE) continue;
      m.alert += 3;
      m.target = { x: p.x, y: p.y };
    }
    m.alert = Math.max(0, m.alert - ALERT_DECAY);

    if (m.alert >= WAKE_AT) {
      m.status = "INVESTIGATING";
      state.events.push({ type: "wake" });
    } else if (Math.random() < sleepwalkChanceFor(state.night)) {
      // Later nights it sometimes gets up for no reason at all
      m.status = "INVESTIGATING";
      m.target = pick(LOOT_SPOTS);
      state.events.push({ type: "wake" });
    } else {
      m.status = m.alert >= STIR_AT ? "STIRRING" : "SLEEPING";
    }
    return;
  }

  if (m.status !== "CHASING") {
    const seen = visiblePlayer(VISION) || shining;
    if (seen) startChase(seen);
  }

  const before = { x: m.x, y: m.y };
  switch (m.status) {
    case "INVESTIGATING":
      moveMonsterTowards(m.target, INVESTIGATE_SPEED);
      if (Math.hypot(m.target.x - m.x, m.target.y - m.y) < 24) {
        m.status = "SEARCHING";
        m.timer = SEARCH_TICKS;
      }
      break;

    case "SEARCHING":
      if (--m.timer <= 0) m.status = "RETURNING";
      break;

    case "RETURNING":
      moveMonsterTowards(m.home, RETURN_SPEED);
      if (Math.hypot(m.home.x - m.x, m.home.y - m.y) < 4) {
        m.status = "SLEEPING";
        m.alert = 30; // groggy, easier to wake again
      }
      break;

    case "CHASING": {
      const prey = state.players[m.chaseId];
      if (!prey || prey.caught || prey.escaped) {
        m.status = "SEARCHING";
        m.timer = SEARCH_TICKS;
        break;
      }
      const sees = shining === m.chaseId ||
        ((prey.hidden === -1 || prey.hideSeen) && canSee(m, prey, CHASE_VISION));
      if (sees) m.lastSeen = { x: prey.x, y: prey.y };

      moveMonsterTowards(m.lastSeen, chaseSpeedFor(state.night));
      if (!sees && Math.hypot(m.lastSeen.x - m.x, m.lastSeen.y - m.y) < 12) {
        // Lost them. Maybe someone else is in view.
        const other = visiblePlayer(VISION);
        if (other) startChase(other);
        else { m.status = "SEARCHING"; m.timer = SEARCH_TICKS; }
      }
      break;
    }
  }

  // Targets near walls can be out of reach for its big body. If it hasn't
  // moved for a while, give up on whatever it was doing.
  const moved = Math.hypot(m.x - before.x, m.y - before.y) > 0.1;
  m.stuck = moved || m.status === "SEARCHING" ? 0 : m.stuck + 1;
  if (m.stuck > STUCK_TICKS) {
    m.stuck = 0;
    if (m.status === "RETURNING") {
      m.x = m.home.x;
      m.y = m.home.y;
    } else {
      m.status = "SEARCHING";
      m.timer = SEARCH_TICKS;
    }
  }

  for (const p of Object.values(state.players)) {
    if (p.caught || p.escaped) continue;
    if (p.hidden !== -1 && !p.hideSeen) continue;
    if (Math.hypot(p.x - m.x, p.y - m.y) < CATCH_RANGE) catchPlayer(p);
  }
}

function updatePlayer(p) {
  const k = p.keys;
  const moving = k.up || k.down || k.left || k.right;
  if (p.hidden !== -1 || p.escaped) return;

  // Caught players drift around as ghosts: silent, unseen, still useful
  // as scouts for whoever is left
  if (p.caught) {
    if (k.left) p.x -= GHOST_SPEED;
    if (k.right) p.x += GHOST_SPEED;
    if (k.up) p.y -= GHOST_SPEED;
    if (k.down) p.y += GHOST_SPEED;
    p.x = Math.max(10, Math.min(W - 10, p.x));
    p.y = Math.max(10, Math.min(H - 10, p.y));
    return;
  }

  const item = p.carrying !== -1 ? state.loot[p.carrying] : null;
  const speed = (k.run ? RUN_SPEED : WALK_SPEED) * (item ? item.slow : 1);

  // Running into a closed door bursts it open. Walking into one doesn't.
  const bump = () => {
    if (!k.run) return;
    const door = closedDoorAt(p.x, p.y, PLAYER_SIZE);
    if (door !== -1) openDoor(door, "slam", { x: p.x, y: p.y });
  };

  const oldX = p.x, oldY = p.y;
  if (k.left) p.x -= speed;
  if (k.right) p.x += speed;
  if (boxHitsWalls(p.x, p.y, PLAYER_SIZE)) { bump(); p.x = oldX; }
  if (k.up) p.y -= speed;
  if (k.down) p.y += speed;
  if (boxHitsWalls(p.x, p.y, PLAYER_SIZE)) { bump(); p.y = oldY; }

  if (moving) {
    p.stepTimer++;
    if (p.stepTimer >= (k.run ? RUN_STEP_EVERY : WALK_STEP_EVERY)) {
      p.stepTimer = 0;
      makeNoise(p.x, p.y, (k.run ? RUN_STEP_RADIUS : WALK_STEP_RADIUS) + (item ? item.loud : 0));
    }
  }

  if (item) {
    item.x = p.x;
    item.y = p.y - 22;
  }
}

function tick() {
  for (const n of state.noises) n.age++;
  state.noises = state.noises.filter((n) => n.age < NOISE_RING_TICKS);
  if (state.gameOver) return;

  for (const id in state.players) updatePlayer(state.players[id]);
  updateMonster();
}

// --- Networking --------------------------------------------------------
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  const used = Object.values(state.players).map((p) => p.color);
  state.players[socket.id] = {
    color: PLAYER_COLORS.find((c) => !used.includes(c)) ?? PLAYER_COLORS[0],
    keys: { up: false, down: false, left: false, right: false, run: false },
    aim: 0, // flashlight direction in radians, steered by the mouse
  };
  spawnPlayer(state.players[socket.id]);

  socket.on("input", (keys) => {
    const p = state.players[socket.id];
    if (!p) return;
    p.keys = keys;
    if (Number.isFinite(keys.aim)) p.aim = keys.aim;
  });

  // One button does everything, in priority order:
  // leave hiding spot, open/close door, drop/secure item, pick up item, hide
  socket.on("interact", () => {
    const p = state.players[socket.id];
    if (!p || p.caught || p.escaped || state.gameOver) return;

    if (p.hidden !== -1) {
      p.hidden = -1;
      p.hideSeen = false;
      return;
    }

    const door = nearestDoor(p);
    if (door !== -1) {
      const d = state.doors[door];
      if (!d.open) openDoor(door, "creak", { x: p.x, y: p.y });
      else if (!doorBlocked(d)) closeDoor(door, p);
      return;
    }

    if (p.carrying !== -1) {
      const item = state.loot[p.carrying];
      if (insideZone(p.x, p.y, EXIT)) {
        item.carriedBy = null;
        item.secured = true;
        p.carrying = -1;
        state.score += item.value;
        // Dropping loot isn't silent
        makeNoise(p.x, p.y, 60);
      } else {
        dropItem(p);
        makeNoise(p.x, p.y, 40 + item.loud);
      }
      return;
    }

    let best = -1, bestDist = PICKUP_RANGE;
    state.loot.forEach((item, i) => {
      if (item.carriedBy !== null || item.secured) return;
      const dist = Math.hypot(p.x - item.x, p.y - item.y);
      if (dist < bestDist) { best = i; bestDist = dist; }
    });
    if (best !== -1) {
      state.loot[best].carriedBy = socket.id;
      p.carrying = best;
      return;
    }

    const hide = HIDES.findIndex((h) => Math.hypot(p.x - h.x, p.y - h.y) < HIDE_RANGE);
    const taken = Object.values(state.players).some((q) => q.hidden === hide);
    if (hide !== -1 && !taken) {
      p.hidden = hide;
      p.x = HIDES[hide].x;
      p.y = HIDES[hide].y;
      // Diving into a closet right in front of it won't fool it
      const m = state.monster;
      p.hideSeen = m.status === "CHASING" && m.chaseId === socket.id &&
        canSee(m, p, HIDE_SEEN_RANGE);
    }
  });

  // Everyone standing in the exit escapes. Anyone else is left behind.
  socket.on("leave", () => {
    const p = state.players[socket.id];
    if (!p || p.caught || state.gameOver || !insideZone(p.x, p.y, EXIT)) return;

    for (const q of Object.values(state.players)) {
      if (q.caught) continue;
      if (insideZone(q.x, q.y, EXIT)) q.escaped = true;
      else q.caught = true;
    }
    endRun(state.score >= state.quota ? "CLEARED" : "SHORT");
  });

  // Clearing a night moves on to the next one. Anything else starts over.
  socket.on("restart", () => {
    if (!state.gameOver) return;
    if (state.result === "CLEARED") {
      startNight(state.night + 1);
    } else {
      state.bank = 0;
      startNight(1);
    }
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    const p = state.players[socket.id];
    if (p) dropItem(p);
    delete state.players[socket.id];
  });
});

const STATIC = { walls: WALLS, rooms: ROOMS, hides: HIDES, exit: EXIT, flashlight: FLASHLIGHT };

setInterval(() => {
  tick();
  const m = state.monster;
  const snapshot = {
    ...STATIC,
    players: Object.fromEntries(Object.entries(state.players).map(([id, p]) => [id, {
      x: p.x, y: p.y, aim: p.aim, color: p.color, carrying: p.carrying,
      hidden: p.hidden, caught: p.caught, escaped: p.escaped,
    }])),
    monster: { x: m.x, y: m.y, status: m.status },
    loot: state.loot,
    doors: state.doors,
    noises: state.noises,
    events: state.events,
    night: state.night,
    quota: state.quota,
    score: state.score,
    bank: state.bank,
    gameOver: state.gameOver,
    result: state.result,
  };
  io.emit("state", snapshot);
  state.events = [];
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
