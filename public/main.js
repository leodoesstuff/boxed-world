const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d", { alpha: false });

const TOOL_BTNS = [...document.querySelectorAll("[data-tool]")];
const brush = document.getElementById("brush");
const brushDisplays = [...document.querySelectorAll(".brushVal")];
const speed = document.getElementById("speed");
const speedDisplays = [...document.querySelectorAll(".speedVal")];
const pauseBtn = document.getElementById("pause");
const resetBtn = document.getElementById("reset");

function updateBrushDisplay(value) {
  brushDisplays.forEach((el) => (el.textContent = value));
}
function updateSpeedDisplay(value) {
  speedDisplays.forEach((el) => (el.textContent = value));
}

updateBrushDisplay(brush.value);
updateSpeedDisplay(speed.value);

brush.addEventListener("input", () => updateBrushDisplay(brush.value));
speed.addEventListener("input", () => updateSpeedDisplay(speed.value));

let tool = "land";
TOOL_BTNS.forEach((b) => {
  b.addEventListener("click", () => {
    TOOL_BTNS.forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    tool = b.dataset.tool;
  });
});

const TILE = {
  EMPTY: 0,
  LAND: 1,
  WATER: 2,
  FOREST: 3,
  FIRE: 4,
  ASH: 5
};

const COLORS = {
  [TILE.EMPTY]: [10, 10, 12],
  [TILE.LAND]: [120, 170, 90],
  [TILE.WATER]: [60, 110, 210],
  [TILE.FOREST]: [40, 130, 60],
  [TILE.FIRE]: [230, 110, 40],
  [TILE.ASH]: [70, 70, 75]
};

let W = 240;
let H = 150;
let grid = new Uint8Array(W * H);
let next = new Uint8Array(W * H);

function idx(x, y) { return y * W + x; }
function inb(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }

function resize() {
  const marginX = 80;
  const marginY = 120;
  const ww = Math.max(320, window.innerWidth - marginX);
  const hh = Math.max(320, window.innerHeight - marginY);

  // Keep pixels chunky and stretch to fill as much of the viewport as possible.
  const scale = Math.max(3, Math.floor(Math.min(ww / W, hh / H)));
  const scaledW = W * scale;
  const scaledH = H * scale;

  canvas.width = scaledW;
  canvas.height = scaledH;
  canvas.style.width = `${scaledW}px`;
  canvas.style.height = `${scaledH}px`;
  ctx.imageSmoothingEnabled = false;
}
window.addEventListener("resize", resize);

function resetWorld() {
  grid.fill(TILE.EMPTY);

  // seed some land blobs
  for (let i = 0; i < 18; i++) {
    const cx = (Math.random() * W) | 0;
    const cy = (Math.random() * H) | 0;
    paintCircle(cx, cy, 10 + ((Math.random() * 10) | 0), TILE.LAND);
  }
  // seed water
  for (let i = 0; i < 6; i++) {
    const cx = (Math.random() * W) | 0;
    const cy = (Math.random() * H) | 0;
    paintCircle(cx, cy, 10 + ((Math.random() * 14) | 0), TILE.WATER);
  }
  // sprinkle forest
  for (let i = 0; i < W * H; i++) {
    if (grid[i] === TILE.LAND && Math.random() < 0.08) grid[i] = TILE.FOREST;
  }
}
resetBtn.addEventListener("click", resetWorld);

function paintCircle(cx, cy, r, t) {
  const rr = r * r;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= rr && inb(x, y)) {
        grid[idx(x, y)] = t;
      }
    }
  }
}

let paused = false;
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "Resume" : "Pause";
});

let mouseDown = false;
let mouseX = 0, mouseY = 0;

function canvasToCell(e) {
  const rect = canvas.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((e.clientY - rect.top) / rect.height) * canvas.height;

  // infer scale from canvas.width
  const scale = canvas.width / W;
  return { cx: Math.floor(x / scale), cy: Math.floor(y / scale) };
}

canvas.addEventListener("mousedown", (e) => { mouseDown = true; paintAt(e); });
window.addEventListener("mouseup", () => (mouseDown = false));
canvas.addEventListener("mousemove", (e) => { if (mouseDown) paintAt(e); });

function paintAt(e) {
  const { cx, cy } = canvasToCell(e);
  const r = Number(brush.value);
  let t = TILE.LAND;
  if (tool === "water") t = TILE.WATER;
  if (tool === "forest") t = TILE.FOREST;
  if (tool === "fire") t = TILE.FIRE;
  if (tool === "erase") t = TILE.EMPTY;
  paintCircle(cx, cy, r, t);
}

function neighborsCount(x, y, tile) {
  let c = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const nx = x + ox, ny = y + oy;
      if (inb(nx, ny) && grid[idx(nx, ny)] === tile) c++;
    }
  }
  return c;
}

function step() {
  next.set(grid);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = idx(x, y);
      const t = grid[i];

      // simple ecology rules
      if (t === TILE.EMPTY) {
        // land can grow into empty near land
        const landN = neighborsCount(x, y, TILE.LAND);
        if (landN >= 5 && Math.random() < 0.08) next[i] = TILE.LAND;
      }

      if (t === TILE.LAND) {
        // forest grows on land near forest + water
        const forestN = neighborsCount(x, y, TILE.FOREST);
        const waterN = neighborsCount(x, y, TILE.WATER);
        if (forestN >= 2 && waterN >= 1 && Math.random() < 0.10) next[i] = TILE.FOREST;
      }

      if (t === TILE.FOREST) {
        // forest can burn if adjacent to fire
        const fireN = neighborsCount(x, y, TILE.FIRE);
        if (fireN > 0 && Math.random() < 0.35) next[i] = TILE.FIRE;
        // forest slowly dies without water nearby
        const waterN = neighborsCount(x, y, TILE.WATER);
        if (waterN === 0 && Math.random() < 0.004) next[i] = TILE.LAND;
      }

      if (t === TILE.FIRE) {
        // fire burns out
        if (Math.random() < 0.28) next[i] = TILE.ASH;
      }

      if (t === TILE.ASH) {
        // ash becomes land again
        if (Math.random() < 0.02) next[i] = TILE.LAND;
      }

      if (t === TILE.WATER) {
        // water gently spreads into empty/ash (tiny)
        if (Math.random() < 0.002) {
          const dir = (Math.random() * 4) | 0;
          const nx = x + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
          const ny = y + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
          if (inb(nx, ny)) {
            const ni = idx(nx, ny);
            if (grid[ni] === TILE.EMPTY || grid[ni] === TILE.ASH) next[ni] = TILE.WATER;
          }
        }
      }
    }
  }

  const tmp = grid;
  grid = next;
  next = tmp;
}

function render() {
  // draw to imageData at 1:1 cell pixels, then scale via canvas size
  const scale = canvas.width / W;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const img = ctx.createImageData(W, H);
  const d = img.data;
  let p = 0;
  for (let i = 0; i < grid.length; i++) {
    const [r, g, b] = COLORS[grid[i]];
    d[p++] = r; d[p++] = g; d[p++] = b; d[p++] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.restore();
}

let last = performance.now();
function loop(now) {
  const s = Number(speed.value);
  const stepsPerFrame = s; // 1..10
  if (!paused) {
    for (let k = 0; k < stepsPerFrame; k++) step();
  }
  render();
  requestAnimationFrame(loop);
}

resize();
requestAnimationFrame(loop);
