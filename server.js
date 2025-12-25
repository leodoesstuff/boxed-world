import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;

// ---------- Tuning ----------
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;

const PLAYER_HP = 90;
const BOT_HP = 40;

// Movement
const BASE_SPEED = 5.2;
const SPRINT_MULT = 1.45;

const BOT_DAMAGE_MULT = 0.45;
const BOT_FIRE_MULT = 1.45;
const BOT_ACCURACY_MULT = 1.25;

const WEAPONS = {
  pistol: { damage: 10, fireDelay: 0.24, speed: 24, spread: 0.010 },
  smg:    { damage: 6,  fireDelay: 0.10, speed: 26, spread: 0.030 },
  rifle:  { damage: 9,  fireDelay: 0.13, speed: 30, spread: 0.016 },
  sniper: { damage: 30, fireDelay: 0.85, speed: 44, spread: 0.003 }
};

const WORLD = {
  minX: -30, maxX: 30,
  minZ: -30, maxZ: 30
};

// ---------- Map ----------
const MAP = {
  walls: [
    { x: 0, z: -31, w: 70, d: 2 },
    { x: 0, z:  31, w: 70, d: 2 },
    { x: -31, z: 0, w: 2, d: 70 },
    { x:  31, z: 0, w: 2, d: 70 },

    { x: 0, z: 0, w: 2, d: 34 },
    { x: -10, z: -10, w: 22, d: 2 },
    { x:  10, z:  10, w: 22, d: 2 },
    { x: -14, z:  12, w: 2, d: 24 },
    { x:  14, z: -12, w: 2, d: 24 },

    { x: -18, z: -18, w: 8, d: 8 },
    { x:  18, z:  18, w: 8, d: 8 },
    { x: 0, z: 18, w: 10, d: 6 },
    { x: 0, z: -18, w: 10, d: 6 }
  ],
  spawns: [
    { x: -24, z: -24 },
    { x:  24, z:  24 },
    { x: -24, z:  24 },
    { x:  24, z: -24 }
  ]
};

function randId() {
  return crypto.randomBytes(8).toString("hex");
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function circleIntersectsAABB(px, pz, r, box) {
  const minX = box.x - box.w / 2;
  const maxX = box.x + box.w / 2;
  const minZ = box.z - box.d / 2;
  const maxZ = box.z + box.d / 2;

  const cx = clamp(px, minX, maxX);
  const cz = clamp(pz, minZ, maxZ);

  const dx = px - cx;
  const dz = pz - cz;
  return (dx * dx + dz * dz) < (r * r);
}

// Push out of walls (iterative)
function resolveCollisions(ent) {
  for (let iter = 0; iter < 7; iter++) {
    let pushed = false;
    for (const w of MAP.walls) {
      if (circleIntersectsAABB(ent.x, ent.z, ent.r, w)) {
        const dx = ent.x - w.x;
        const dz = ent.z - w.z;
        const len = Math.hypot(dx, dz) || 1;
        ent.x += (dx / len) * 0.14;
        ent.z += (dz / len) * 0.14;
        pushed = true;
      }
    }
    if (!pushed) break;
  }

  // tiny nudge escape for rare edge overlaps
  for (const w of MAP.walls) {
    if (circleIntersectsAABB(ent.x, ent.z, ent.r, w)) {
      ent.x += (Math.random() - 0.5) * 0.05;
      ent.z += (Math.random() - 0.5) * 0.05;
      break;
    }
  }

  ent.x = clamp(ent.x, WORLD.minX, WORLD.maxX);
  ent.z = clamp(ent.z, WORLD.minZ, WORLD.maxZ);
}

// ✅ KEY FIX: move X then Z, resolving after each axis to slide along walls
function moveAndCollide(ent, dx, dz) {
  ent.x += dx;
  resolveCollisions(ent);

  ent.z += dz;
  resolveCollisions(ent);
}

function spawnPoint(i) {
  const s = MAP.spawns[i % MAP.spawns.length];
  return { x: s.x, z: s.z };
}

function makePlayer(id) {
  const sp = spawnPoint(Math.floor(Math.random() * 9999));
  return {
    id,
    name: "Player",
    x: sp.x,
    z: sp.z,
    yaw: 0,
    hp: PLAYER_HP,
    score: 0,
    r: 0.55,
    weapon: "rifle",
    sprint: 0,
    input: { w:0,a:0,s:0,d:0,shoot:0,yaw:0,weapon:"rifle",reset:0,sprint:0 },
    cooldown: 0
  };
}

function makeBot(id) {
  const sp = spawnPoint(Math.floor(Math.random() * 9999));
  return {
    id,
    name: "Bot",
    x: sp.x,
    z: sp.z,
    yaw: 0,
    hp: BOT_HP,
    r: 0.55,
    cooldown: 0,
    targetId: null,
    wanderT: 0,
    wx: sp.x,
    wz: sp.z
  };
}

function respawn(ent) {
  const sp = spawnPoint(Math.floor(Math.random() * 9999));
  ent.x = sp.x;
  ent.z = sp.z;
  ent.hp = ent.id?.startsWith("b_") ? BOT_HP : PLAYER_HP;
}

const players = new Map();
const bots = new Map();
const bullets = [];

function ensureBots(n = 6) {
  while (bots.size < n) {
    const id = "b_" + randId();
    bots.set(id, makeBot(id));
  }
}
ensureBots(6);

function fireBullet(owner, x, z, yaw, weaponName, isBot = false) {
  const w = WEAPONS[weaponName] ?? WEAPONS.rifle;

  const spreadMult = isBot ? BOT_ACCURACY_MULT : 1;
  const spread = w.spread * spreadMult;
  const jitter = (Math.random() - 0.5) * 2 * spread;
  const yaw2 = yaw + jitter;

  const vx = -Math.sin(yaw2) * w.speed;
  const vz = -Math.cos(yaw2) * w.speed;

  const dmg = isBot ? Math.max(1, Math.round(w.damage * BOT_DAMAGE_MULT)) : w.damage;

  bullets.push({
    id: "k_" + randId(),
    owner,
    x,
    z,
    vx,
    vz,
    life: 1.1,
    damage: dmg
  });
}

function bulletHits(b, ent) {
  const dx = b.x - ent.x;
  const dz = b.z - ent.z;
  const rr = (ent.r + 0.12);
  return (dx * dx + dz * dz) < (rr * rr);
}

function bulletInWall(b) {
  for (const w of MAP.walls) {
    const minX = w.x - w.w / 2, maxX = w.x + w.w / 2;
    const minZ = w.z - w.d / 2, maxZ = w.z + w.d / 2;
    if (b.x >= minX && b.x <= maxX && b.z >= minZ && b.z <= maxZ) return true;
  }
  return false;
}

// ---------- Bot AI ----------
function pickClosestTarget(bot) {
  let best = null;
  let bestD = Infinity;
  for (const p of players.values()) {
    const dx = p.x - bot.x;
    const dz = p.z - bot.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD) { bestD = d2; best = p; }
  }
  return best;
}

function botThink(bot) {
  const t = pickClosestTarget(bot);
  bot.targetId = t?.id ?? null;

  if (!t) {
    bot.wanderT -= DT;
    if (bot.wanderT <= 0) {
      bot.wanderT = 1.6 + Math.random() * 2.4;
      bot.wx = clamp((Math.random() - 0.5) * 50, WORLD.minX, WORLD.maxX);
      bot.wz = clamp((Math.random() - 0.5) * 50, WORLD.minZ, WORLD.maxZ);
    }
    const dx = bot.wx - bot.x;
    const dz = bot.wz - bot.z;
    const aimYaw = Math.atan2(-dx, -dz);
    return { moveX: dx, moveZ: dz, shoot: false, aimYaw };
  }

  const dx = t.x - bot.x;
  const dz = t.z - bot.z;
  const dist = Math.hypot(dx, dz) || 1;

  const aimYaw = Math.atan2(-dx, -dz);
  const wantShoot = dist < 16;

  let moveX = dx, moveZ = dz;
  if (dist < 6) { moveX = -dx; moveZ = -dz; }

  return { moveX, moveZ, shoot: wantShoot, aimYaw };
}

// ---------- Web server ----------
const app = express();
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
}

wss.on("connection", (ws) => {
  const id = randId();
  const pl = makePlayer(id);
  players.set(id, pl);

  ws.send(JSON.stringify({ t: "welcome", id, map: MAP }));

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    const p = players.get(id);
    if (!p) return;

    if (msg.t === "input") {
      p.input = {
        w: msg.w ? 1 : 0,
        a: msg.a ? 1 : 0,
        s: msg.s ? 1 : 0,
        d: msg.d ? 1 : 0,
        shoot: msg.shoot ? 1 : 0,
        yaw: Number(msg.yaw) || 0,
        weapon: typeof msg.weapon === "string" ? msg.weapon : p.weapon,
        reset: msg.reset ? 1 : 0,
        sprint: msg.sprint ? 1 : 0
      };
    }
  });

  ws.on("close", () => {
    players.delete(id);
  });
});

// ---------- Game loop ----------
setInterval(() => {
  ensureBots(6);

  // players update
  for (const p of players.values()) {
    if (p.hp <= 0) respawn(p);

    p.yaw = p.input.yaw;

    if (p.input.reset) {
      respawn(p);
      p.input.reset = 0;
    }

    if (WEAPONS[p.input.weapon]) p.weapon = p.input.weapon;

    // sprint
    const wantsSprint = p.input.sprint && (p.input.w || p.input.a || p.input.d);
    p.sprint = wantsSprint ? 1 : 0;

    const speed = BASE_SPEED * (p.sprint ? SPRINT_MULT : 1.0);

    // WASD movement
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const rx = -fz;
    const rz = fx;

    let mx = 0, mz = 0;
    if (p.input.w) { mx += fx; mz += fz; }
    if (p.input.s) { mx -= fx; mz -= fz; }
    if (p.input.d) { mx += rx; mz += rz; }
    if (p.input.a) { mx -= rx; mz -= rz; }

    const len = Math.hypot(mx, mz);
    if (len > 0.001) {
      mx /= len; mz /= len;

      // ✅ FIXED: axis-separated slide movement
      moveAndCollide(p, mx * speed * DT, mz * speed * DT);
    }

    // shooting
    p.cooldown = Math.max(0, p.cooldown - DT);
    const w = WEAPONS[p.weapon] ?? WEAPONS.rifle;

    if (p.input.shoot && p.cooldown <= 0) {
      p.cooldown = w.fireDelay;
      fireBullet(p.id, p.x, p.z, p.yaw, p.weapon, false);
    }
  }

  // bots update
  for (const b of bots.values()) {
    if (b.hp <= 0) respawn(b);

    const ai = botThink(b);
    b.yaw = ai.aimYaw;

    const speed = 4.1;
    let mx = ai.moveX, mz = ai.moveZ;
    const len = Math.hypot(mx, mz);
    if (len > 0.001) {
      mx /= len; mz /= len;

      // ✅ slide fix for bots too
      moveAndCollide(b, mx * speed * DT, mz * speed * DT);
    }

    // shoot
    b.cooldown = Math.max(0, b.cooldown - DT);
    const bw = WEAPONS.smg;
    if (ai.shoot && b.cooldown <= 0) {
      b.cooldown = bw.fireDelay * BOT_FIRE_MULT;
      fireBullet(b.id, b.x, b.z, b.yaw, "smg", true);
    }
  }

  // bullets update + hits
  for (let i = bullets.length - 1; i >= 0; i--) {
    const k = bullets[i];
    k.life -= DT;
    k.x += k.vx * DT;
    k.z += k.vz * DT;

    if (k.life <= 0 || bulletInWall(k)) {
      bullets.splice(i, 1);
      continue;
    }

    for (const p of players.values()) {
      if (p.id === k.owner) continue;
      if (bulletHits(k, p)) {
        p.hp -= (k.damage ?? 6);
        if (p.hp <= 0) {
          const killer = players.get(k.owner);
          if (killer) killer.score += 1;
        }
        bullets.splice(i, 1);
        break;
      }
    }

    for (const b of bots.values()) {
      if (b.id === k.owner) continue;
      if (bulletHits(k, b)) {
        b.hp -= (k.damage ?? 6);
        bullets.splice(i, 1);
        break;
      }
    }
  }

  // broadcast snapshot
  broadcast({
    t: "state",
    players: Array.from(players.values()).map(p => ({
      id: p.id,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      hp: p.hp,
      score: p.score,
      weapon: p.weapon,
      sprint: p.sprint
    })),
    bots: Array.from(bots.values()).map(b => ({
      id: b.id,
      x: b.x,
      z: b.z,
      yaw: b.yaw,
      hp: b.hp
    })),
    bullets: bullets.map(k => ({ id: k.id, owner: k.owner, x: k.x, z: k.z }))
  });
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
