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
  monster: { x: 600, y: 120, status: "SLEEPING" },
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
  state.monster.status = "SLEEPING";
  state.loot = LOOT_TEMPLATES.map((t) => ({ ...t, carriedBy: null, secured: false }));
  for (const id in state.players) spawnPlayer(state.players[id]);
}

resetGame();

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  state.players[socket.id] = {
    x: 0, y: 0,
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

function tick() {
  if (state.gameOver) return;

  let noiseThisTick = 0;

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
    if (door !== -1 && door !== p.inDoor) {
      noiseThisTick += k.run ? DOOR_RUN_NOISE : DOOR_WALK_NOISE;
    }
    p.inDoor = door;

    if (moving) {
      noiseThisTick += k.run ? RUN_NOISE : WALK_NOISE;
      if (item) noiseThisTick += item.noise;
    }

    if (item) {
      item.x = p.x;
      item.y = p.y - 24;
    }
  }

  state.noise = Math.max(0, Math.min(100, state.noise + noiseThisTick - NOISE_DECAY));

  if (state.noise >= 100) {
    state.monster.status = "AWAKE";
    state.gameOver = true;
    state.result = "LOSE";
  } else if (state.noise >= 50) {
    state.monster.status = "DISTURBED";
  } else {
    state.monster.status = "SLEEPING";
  }
}

setInterval(() => {
  tick();
  io.emit("state", { ...state, exit: EXIT, walls: WALLS, doors: DOORS });
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});