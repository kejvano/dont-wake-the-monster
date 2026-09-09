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
const CARRY_NOISE = 0.2;
const PICKUP_RANGE = 40;
const PLAYER_SIZE = 32;
const TICK_RATE = 30;

const EXIT = { x: 100, y: 550, w: 120, h: 60 };

// Walls are axis-aligned rectangles (top-left origin).
// Layout: hall bottom-left, kitchen top-left, living room bottom-right,
// bedroom top-right. Gaps in the walls act as doorways.
const WALLS = [
  // Outer walls
  { x: 0, y: 0, w: 800, h: 10 },
  { x: 0, y: 590, w: 800, h: 10 },
  { x: 0, y: 0, w: 10, h: 600 },
  { x: 790, y: 0, w: 10, h: 600 },

  // Vertical center wall, gaps at 180-260 (bedroom) and 440-520 (living room)
  { x: 390, y: 10, w: 20, h: 170 },
  { x: 390, y: 260, w: 20, h: 180 },
  { x: 390, y: 520, w: 20, h: 70 },

  // Horizontal wall, left half (kitchen/hall), gap at 250-330
  { x: 10, y: 290, w: 240, h: 20 },
  { x: 330, y: 290, w: 60, h: 20 },

  // Horizontal wall, right half (bedroom/living room), gap at 670-750
  { x: 410, y: 290, w: 260, h: 20 },
  { x: 750, y: 290, w: 40, h: 20 },
];

// The server owns all game state. Clients only send input and render.
const state = {
  players: {},
  monster: { x: 600, y: 120, status: "SLEEPING" },
  loot: { x: 700, y: 200, carriedBy: null, name: "Diamond necklace" },
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

function spawnPlayer(p) {
  p.x = 100 + Math.random() * 100;
  p.y = 450 + Math.random() * 60;
}

function resetGame() {
  state.noise = 0;
  state.gameOver = false;
  state.result = null;
  state.monster.status = "SLEEPING";
  state.loot.carriedBy = null;
  state.loot.x = 700;
  state.loot.y = 200;
  for (const id in state.players) spawnPlayer(state.players[id]);
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  state.players[socket.id] = {
    x: 0, y: 0,
    keys: { up: false, down: false, left: false, right: false, run: false },
  };
  spawnPlayer(state.players[socket.id]);

  socket.on("input", (keys) => {
    if (state.players[socket.id]) state.players[socket.id].keys = keys;
  });

  // Toggle: drop if carrying, otherwise pick up if close enough
  socket.on("interact", () => {
    const p = state.players[socket.id];
    if (!p || state.gameOver) return;
    const loot = state.loot;

    if (loot.carriedBy === socket.id) {
      loot.carriedBy = null;
      loot.x = p.x;
      loot.y = p.y + 30;
    } else if (loot.carriedBy === null) {
      const dist = Math.hypot(p.x - loot.x, p.y - loot.y);
      if (dist < PICKUP_RANGE) loot.carriedBy = socket.id;
    }
  });

  socket.on("restart", resetGame);

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    if (state.loot.carriedBy === socket.id) state.loot.carriedBy = null;
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
    const carrying = state.loot.carriedBy === id;
    const speed = k.run ? RUN_SPEED : WALK_SPEED;

    // Resolve each axis separately so players slide along walls
    const oldX = p.x, oldY = p.y;
    if (k.left) p.x -= speed;
    if (k.right) p.x += speed;
    if (collides(p.x, p.y)) p.x = oldX;

    if (k.up) p.y -= speed;
    if (k.down) p.y += speed;
    if (collides(p.x, p.y)) p.y = oldY;

    if (moving) {
      noiseThisTick += k.run ? RUN_NOISE : WALK_NOISE;
      if (carrying) noiseThisTick += CARRY_NOISE;
    }

    if (carrying) {
      state.loot.x = p.x;
      state.loot.y = p.y - 24;
    }

    const inExit =
      p.x > EXIT.x - EXIT.w / 2 && p.x < EXIT.x + EXIT.w / 2 &&
      p.y > EXIT.y - EXIT.h / 2 && p.y < EXIT.y + EXIT.h / 2;
    if (carrying && inExit) {
      state.gameOver = true;
      state.result = "WIN";
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
  io.emit("state", { ...state, exit: EXIT, walls: WALLS });
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});