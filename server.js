const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const WALK_SPEED = 2;
const RUN_SPEED = 5;
const WALK_NOISE = 0.35;
const RUN_NOISE = 0.9;
const NOISE_DECAY = 0.25;
const CARRY_NOISE = 0.2;    // extra ljud per tick när man bär loot
const PICKUP_RANGE = 40;    // hur nära man måste vara för att plocka upp

const EXIT = { x: 100, y: 550, w: 120, h: 60 };

const state = {
  players: {},
  monster: { x: 700, y: 100, status: "SLEEPING" },
  loot: { x: 650, y: 300, carriedBy: null, name: "Diamanthalsband" },
  noise: 0,
  gameOver: false,
  result: null,
};

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
  state.loot.x = 650;
  state.loot.y = 300;
  for (const id in state.players) spawnPlayer(state.players[id]);
}

io.on("connection", (socket) => {
  console.log("En spelare anslöt:", socket.id);

  state.players[socket.id] = {
    x: 0, y: 0,
    keys: { up: false, down: false, left: false, right: false, run: false },
  };
  spawnPlayer(state.players[socket.id]);

  socket.on("input", (keys) => {
    if (state.players[socket.id]) state.players[socket.id].keys = keys;
  });

  // Spelaren trycker E: plocka upp eller släpp
  socket.on("interact", () => {
    const p = state.players[socket.id];
    if (!p || state.gameOver) return;
    const loot = state.loot;

    if (loot.carriedBy === socket.id) {
      loot.carriedBy = null;           // släpp där man står
      loot.x = p.x; loot.y = p.y + 30;
    } else if (loot.carriedBy === null) {
      const dist = Math.hypot(p.x - loot.x, p.y - loot.y);
      if (dist < PICKUP_RANGE) loot.carriedBy = socket.id;
    }
  });

  socket.on("restart", resetGame);

  socket.on("disconnect", () => {
    console.log("En spelare lämnade:", socket.id);
    if (state.loot.carriedBy === socket.id) state.loot.carriedBy = null;
    delete state.players[socket.id];
  });
});

setInterval(() => {
  if (!state.gameOver) {
    let noiseThisTick = 0;

    for (const id in state.players) {
      const p = state.players[id];
      const k = p.keys;
      const moving = k.up || k.down || k.left || k.right;
      const carrying = state.loot.carriedBy === id;
      const speed = k.run ? RUN_SPEED : WALK_SPEED;

      if (k.up) p.y -= speed;
      if (k.down) p.y += speed;
      if (k.left) p.x -= speed;
      if (k.right) p.x += speed;
      p.x = Math.max(16, Math.min(784, p.x));
      p.y = Math.max(16, Math.min(584, p.y));

      if (moving) {
        noiseThisTick += k.run ? RUN_NOISE : WALK_NOISE;
        if (carrying) noiseThisTick += CARRY_NOISE;
      }

      // Lootet följer den som bär det
      if (carrying) { state.loot.x = p.x; state.loot.y = p.y - 24; }

      // Vinst: stå i utgången med lootet
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

  io.emit("state", { ...state, exit: EXIT });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Servern kör på http://localhost:" + PORT);
});