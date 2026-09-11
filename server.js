const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Tuning values. Walk noise must exceed decay or walking is free.
const WALK_SPEED = 2;
const RUN_SPEED = 5;
const WALK_NOISE = 0.35;
const RUN_NOISE = 0.9;
const NOISE_DECAY = 0.25;
const PICKUP_RANGE = 40;
const PLAYER_SIZE = 32;
const TICK_RATE = 30;
const MONSTER_INVESTIGATE_SPEED = 1;
const MONSTER_CHASE_SPEED = 4;   // slower than running, faster than walking
const MONSTER_SIZE = 48;
const CATCH_RANGE = 30;
const MONSTER_HOME = { x: 600, y: 120 };

const EXIT = { x: 40, y: 520, w: 120, h: 60 };

// Door zones sit in the wall gaps. Entering a zone counts as opening the
// door: quiet when walking, a loud slam when running.
const DOORS = [
  { x: 380, y: 180, w: 40, h: 80, name: "Bedroom" },
  { x: 380, y: 440, w: 40, h: 80, name: "Living room" },
  { x: 250, y: 280, w: 80, h: 40, name: "Kitchen" },
  { x: 670, y: 280, w: 80, h: 40, name: "Bedroom" },
];
const DOOR_WALK_NOISE = 3;
const DOOR_RUN_NOISE = 20;

// Walls are axis-aligned rectangles (top-left origin).
// Layout: hall bottom-left, kitchen top-left, living room bottom-right,
// bedroom top-right. Gaps in the walls act as doorways.
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

// Loot templates. `noise` is extra noise per tick while carrying and moving.
// Cheap and quiet vs. valuable and loud is the core decision of the game.
const LOOT_TEMPLATES = [
  { name: "Ring", value: 100, noise: 0.05, x: 150, y: 150 },        // kitchen
  { name: "Laptop", value: 250, noise: 0.2, x: 600, y: 450 },        // living room
  { name: "Painting", value: 500, noise: 0.6, x: 720, y: 420 },      // living room
  { name: "Diamond necklace", value: 400, noise: 0.1, x: 700, y: 200 }, // bedroom
  { name: "Old TV", value: 300, noise: 1.0, x: 280, y: 100 },        // kitchen
];

// The server owns all game state. Clients only send input and render.
const state = {
  players: {},
  monster: { x: MONSTER_HOME.x, y: MONSTER_HOME.y, status: "SLEEPING", target: null },
  loot: [],
  score: 0,
  noise: 0,
  gameOver: false,
  result: null,
};

function hitsWall(x, y, wall) {
  const half = PLAYER_SIZE / 2;
  return x + half > wall.x && x - half < wall.x + wall.w &&
         y + half > wall.y && y - half < wall.y + wall.h;
}

function collides(x, y) {
  return WALLS.some((w) => hitsWall(x, y, w));
}

function insideZone(x, y, zone) {
  return x > zone.x && x < zone.x + zone.w && y > zone.y && y < zone.y + zone.h;
}

function doorAt(x, y) {
  return DOORS.findIndex((d) => insideZone(x, y, d));
}

function spawnPlayer(p) {
  p.x = 100 + Math.random() * 100;
  p.y = 400 + Math.random() * 60;
  p.carrying = -1;
  p.inDoor = -1;
}

function resetGame() {
  state.noise = 0;
  state.score = 0;
  state.gameOver = false;
  state.result = null;
  state.monster = { x: MONSTER_HOME.x, y: MONSTER_HOME.y, status: "SLEEPING", target: null };
  state.loot = LOOT_TEMPLATES.map((t) => ({ ...t, carriedBy: null, secured: false }));
  for (const id in state.players) spawnPlayer(state.players[id]);
}

resetGame();

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  // First player to join becomes the lookout, second the thief.
  // Extra players get "thief" so the game still works with spectators.
  const hasLookout = Object.values(state.players).some((p) => p.role === "lookout");
  state.players[socket.id] = {
    x: 0, y: 0,
    role: hasLookout ? "thief" : "lookout",
    keys: { up: false, down: false, left: false, right: false, run: false },
    carrying: -1, // index into state.loot, -1 when hands are empty
    inDoor: -1,   // index of the door zone the player is currently in
  };
  spawnPlayer(state.players[socket.id]);

  socket.on("input", (keys) => {
    if (state.players[socket.id]) state.players[socket.id].keys = keys;
  });

  // Drop if carrying, otherwise pick up the nearest free item in range.
  // Dropping inside the exit zone secures the item and adds its value.
  socket.on("interact", () => {
    const p = state.players[socket.id];
    if (!p || state.gameOver) return;

    if (p.carrying !== -1) {
      const item = state.loot[p.carrying];
      item.carriedBy = null;
      p.carrying = -1;
      if (insideZone(p.x, p.y, EXIT)) {
        item.secured = true;
        state.score += item.value;
      } else {
        item.x = p.x;
        item.y = p.y + 30;
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
    }
  });

  // Leaving is only allowed from the exit zone and only with something to show for it
  socket.on("leave", () => {
    const p = state.players[socket.id];
    if (!p || state.gameOver) return;
    if (insideZone(p.x, p.y, EXIT) && state.score > 0) {
      state.gameOver = true;
      state.result = "WIN";
    }
  });

  socket.on("restart", resetGame);

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    const p = state.players[socket.id];
    if (p && p.carrying !== -1) {
      const item = state.loot[p.carrying];
      item.carriedBy = null;
      item.x = p.x;
      item.y = p.y;
    }
    delete state.players[socket.id];
  });
});

// Same wall check as players, just a bigger body
function monsterCollides(x, y) {
  const half = MONSTER_SIZE / 2;
  return WALLS.some((w) =>
    x + half > w.x && x - half < w.x + w.w && y + half > w.y && y - half < w.y + w.h
  );
}

// Step towards a point, axis by axis so it slides along walls.
// Callers pass the next pathfinding cell rather than the final target.
function moveMonsterTowards(target, speed) {
  const m = state.monster;
  const dx = target.x - m.x, dy = target.y - m.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;

  const oldX = m.x, oldY = m.y;
  m.x += (dx / dist) * speed;
  if (monsterCollides(m.x, m.y)) m.x = oldX;
  m.y += (dy / dist) * speed;
  if (monsterCollides(m.x, m.y)) m.y = oldY;
}

function nearestPlayer() {
  let best = null, bestDist = Infinity;
  for (const id in state.players) {
    const p = state.players[id];
    const dist = Math.hypot(p.x - state.monster.x, p.y - state.monster.y);
    if (dist < bestDist) { best = p; bestDist = dist; }
  }
  return best;
}

// Grid-based pathfinding (BFS). The house is small enough that
// recomputing the path every tick is cheap.
const CELL = 20;
const GRID_W = 800 / CELL;
const GRID_H = 600 / CELL;

// Precompute which cells the monster's body fits in
const walkable = [];
for (let cy = 0; cy < GRID_H; cy++) {
  walkable[cy] = [];
  for (let cx = 0; cx < GRID_W; cx++) {
    walkable[cy][cx] = !monsterCollides(cx * CELL + CELL / 2, cy * CELL + CELL / 2);
  }
}

function toCell(pos) {
  return {
    cx: Math.max(0, Math.min(GRID_W - 1, Math.floor(pos.x / CELL))),
    cy: Math.max(0, Math.min(GRID_H - 1, Math.floor(pos.y / CELL))),
  };
}

// Returns the world position of the next cell to move to, or the target
// itself if it's already in reach. If the target cell is unreachable
// (players are smaller and can hug walls), aim for the closest reachable one.
function nextStepTowards(target) {
  const start = toCell(state.monster);
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

  // Walk the path backwards from the goal to find the first step
  let step = closest;
  while (cameFrom.get(key(step)) && key(cameFrom.get(key(step))) !== key(start)) {
    step = cameFrom.get(key(step));
  }
  return { x: step.cx * CELL + CELL / 2, y: step.cy * CELL + CELL / 2 };
}

function updateMonster() {
  const m = state.monster;

  if (m.status === "CHASING") {
    const prey = nearestPlayer();
    if (!prey) return;
    moveMonsterTowards(nextStepTowards(prey), MONSTER_CHASE_SPEED);
    if (Math.hypot(prey.x - m.x, prey.y - m.y) < CATCH_RANGE) {
      state.gameOver = true;
      state.result = "LOSE";
    }
    return;
  }

  // Once awake it never goes back to sleep
  if (state.noise >= 100) {
    m.status = "CHASING";
  } else if (state.noise >= 75) {
    m.status = "INVESTIGATING";
    if (m.target) moveMonsterTowards(nextStepTowards(m.target), MONSTER_INVESTIGATE_SPEED);
  } else if (state.noise >= 50) {
    m.status = "DISTURBED";
  } else {
    m.status = "SLEEPING";
  }
}

function tick() {
  if (state.gameOver) return;

  let noiseThisTick = 0;
  let loudest = { amount: 0, pos: null };

  for (const id in state.players) {
    const p = state.players[id];
    const k = p.keys;
    const moving = k.up || k.down || k.left || k.right;
    const item = p.carrying !== -1 ? state.loot[p.carrying] : null;
    const speed = k.run ? RUN_SPEED : WALK_SPEED;

    // Resolve each axis separately so players slide along walls
    const oldX = p.x, oldY = p.y;
    if (k.left) p.x -= speed;
    if (k.right) p.x += speed;
    if (collides(p.x, p.y)) p.x = oldX;

    if (k.up) p.y -= speed;
    if (k.down) p.y += speed;
    if (collides(p.x, p.y)) p.y = oldY;

    // Noise burst when a player enters a door zone they weren't in before
    const door = doorAt(p.x, p.y);

    let playerNoise = 0;
    if (door !== -1 && door !== p.inDoor) {
      playerNoise += k.run ? DOOR_RUN_NOISE : DOOR_WALK_NOISE;
    }
    p.inDoor = door;

    if (moving) {
      playerNoise += k.run ? RUN_NOISE : WALK_NOISE;
      if (item) playerNoise += item.noise;
    }
    noiseThisTick += playerNoise;
    if (playerNoise > loudest.amount) loudest = { amount: playerNoise, pos: { x: p.x, y: p.y } };

    if (item) {
      item.x = p.x;
      item.y = p.y - 24;
    }
  }

  state.noise = Math.max(0, Math.min(100, state.noise + noiseThisTick - NOISE_DECAY));
  if (loudest.pos) state.monster.target = loudest.pos;

  updateMonster();
}

// Each role gets a different view of the world. This is the core of the
// game: neither player has the full picture, so they have to talk.
function viewFor(role) {
  const view = { ...state, exit: EXIT, walls: WALLS, doors: DOORS, role };

  if (role === "thief") {
    view.monster = null;
    view.noise = null;
  } else {
    view.loot = state.loot.map((item) => ({ ...item, name: "???", value: null }));
  }
  return view;
}

setInterval(() => {
  tick();
  for (const id in state.players) {
    io.to(id).emit("state", viewFor(state.players[id].role));
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});