// GITATO COMMAND — map generation + grid pathfinding
'use strict';

RTS.map = (() => {
  const C = RTS.C;

  // block codes
  const FREE = 0, ROCK = 1, BLD = 2, CRYS = 3;

  // Symmetric (180°-rotation) map from a shared seed.
  // Returns { W, H, rock:Uint8Array, starts:[{tx,ty}], crystals:[{tx,ty}] }
  function generate(seed) {
    const W = C.MAP_W, H = C.MAP_H;
    const rnd = RTS.util.rng(seed);
    const rock = new Uint8Array(W * H);

    const set = (x, y) => {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return;
      rock[y * W + x] = 1;
      rock[(H - 1 - y) * W + (W - 1 - x)] = 1; // mirror
    };

    // rock blobs scattered over one half, mirrored to the other
    const blobs = 14;
    for (let i = 0; i < blobs; i++) {
      const bx = 4 + Math.floor(rnd() * (W - 8));
      const by = 4 + Math.floor(rnd() * (H / 2));
      const size = 2 + Math.floor(rnd() * 5);
      let x = bx, y = by;
      for (let j = 0; j < size * 3; j++) {
        set(x, y); set(x + 1, y); set(x, y + 1);
        x += Math.floor(rnd() * 3) - 1;
        y += Math.floor(rnd() * 3) - 1;
      }
    }

    const starts = [{ tx: 7, ty: 7 }, { tx: W - 8, ty: H - 8 }];

    // clear generous area around each start
    for (const s of starts) {
      for (let y = s.ty - 6; y <= s.ty + 6; y++)
        for (let x = s.tx - 6; x <= s.tx + 6; x++)
          if (x >= 0 && y >= 0 && x < W && y < H) rock[y * W + x] = 0;
    }

    // crystal fields: one near each start (mirrored) + two mid-map (mirrored)
    const crystals = [];
    const addPatch = (cx, cy, n) => {
      let placed = 0, guard = 0;
      while (placed < n && guard++ < 80) {
        const x = cx + Math.floor(rnd() * 5) - 2;
        const y = cy + Math.floor(rnd() * 5) - 2;
        if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
        if (rock[y * W + x]) continue;
        if (crystals.some((c) => c.tx === x && c.ty === y)) continue;
        crystals.push({ tx: x, ty: y });
        crystals.push({ tx: W - 1 - x, ty: H - 1 - y });
        placed++;
      }
    };
    addPatch(starts[0].tx + 5, starts[0].ty - 1, 7); // both bases get the mirror
    addPatch(Math.floor(W * 0.32), Math.floor(H * 0.62), 6);
    addPatch(Math.floor(W * 0.5) - 2, Math.floor(H * 0.5) - 2, 5);

    // no crystal on a start footprint
    const clearStart = (s) => {
      for (let i = crystals.length - 1; i >= 0; i--) {
        const c = crystals[i];
        if (Math.abs(c.tx - s.tx) <= 2 && Math.abs(c.ty - s.ty) <= 2) crystals.splice(i, 1);
      }
    };
    starts.forEach(clearStart);

    return { W, H, rock, starts, crystals };
  }

  // ---- A* on the block grid (8-dir, no corner cutting) ----
  function findPath(block, W, H, sx, sy, tx, ty) {
    sx = RTS.util.clamp(sx, 0, W - 1); sy = RTS.util.clamp(sy, 0, H - 1);
    tx = RTS.util.clamp(tx, 0, W - 1); ty = RTS.util.clamp(ty, 0, H - 1);
    if (block[ty * W + tx]) {
      const alt = nearestFree(block, W, H, tx, ty, 10);
      if (!alt) return null;
      tx = alt.x; ty = alt.y;
    }
    if (block[sy * W + sx]) {
      const alt = nearestFree(block, W, H, sx, sy, 6);
      if (alt) { sx = alt.x; sy = alt.y; }
    }
    if (sx === tx && sy === ty) return [{ x: tx, y: ty }];

    const open = new MinHeap();
    const g = new Float32Array(W * H).fill(Infinity);
    const from = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    const si = sy * W + sx, ti = ty * W + tx;
    g[si] = 0;
    open.push(si, heur(sx, sy, tx, ty));
    let found = false, expanded = 0;

    while (open.size > 0 && expanded < 6000) {
      const cur = open.pop();
      if (cur === ti) { found = true; break; }
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      const cx = cur % W, cy = (cur / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (block[ni] || closed[ni]) continue;
        // no diagonal squeeze between two blocked orthogonals
        if (dx && dy && (block[cy * W + nx] || block[ny * W + cx])) continue;
        const cost = g[cur] + (dx && dy ? 1.4142 : 1);
        if (cost < g[ni]) {
          g[ni] = cost; from[ni] = cur;
          open.push(ni, cost + heur(nx, ny, tx, ty));
        }
      }
    }
    if (!found) return null;

    let path = [];
    let i = ti;
    while (i !== -1) { path.push({ x: i % W, y: (i / W) | 0 }); i = from[i]; }
    path.reverse();
    return smooth(block, W, H, path);
  }

  function heur(x, y, tx, ty) {
    const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
    return Math.max(dx, dy) + 0.4142 * Math.min(dx, dy);
  }

  function nearestFree(block, W, H, tx, ty, maxR) {
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        if (!block[y * W + x]) return { x, y };
      }
    }
    return null;
  }

  // drop intermediate waypoints that have straight-line visibility
  function smooth(block, W, H, path) {
    if (path.length <= 2) return path;
    const out = [path[0]];
    let a = 0;
    while (a < path.length - 1) {
      let b = path.length - 1;
      while (b > a + 1 && !los(block, W, path[a].x, path[a].y, path[b].x, path[b].y)) b--;
      out.push(path[b]);
      a = b;
    }
    return out;
  }

  // supercover line-of-sight over the grid
  function los(block, W, x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    let x = x0, y = y0;
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (let n = dx + dy; n > 0; n--) {
      const e2 = err * 2;
      if (e2 > -dy && e2 < dx) { // diagonal step: check both orthogonal neighbors
        if (block[y * W + (x + sx)] || block[(y + sy) * W + x]) return false;
        x += sx; y += sy; err += dx - dy;
      } else if (e2 > -dy) { x += sx; err -= dy; }
      else { y += sy; err += dx; }
      if (block[y * W + x]) return false;
    }
    return true;
  }

  // small binary min-heap keyed by priority
  class MinHeap {
    constructor() { this.k = []; this.p = []; this.size = 0; }
    push(key, pri) {
      let i = this.size++;
      this.k[i] = key; this.p[i] = pri;
      while (i > 0) {
        const par = (i - 1) >> 1;
        if (this.p[par] <= this.p[i]) break;
        this.swap(i, par); i = par;
      }
    }
    pop() {
      const top = this.k[0];
      this.size--;
      if (this.size > 0) {
        this.k[0] = this.k[this.size]; this.p[0] = this.p[this.size];
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < this.size && this.p[l] < this.p[m]) m = l;
          if (r < this.size && this.p[r] < this.p[m]) m = r;
          if (m === i) break;
          this.swap(i, m); i = m;
        }
      }
      return top;
    }
    swap(a, b) {
      [this.k[a], this.k[b]] = [this.k[b], this.k[a]];
      [this.p[a], this.p[b]] = [this.p[b], this.p[a]];
    }
  }

  return { generate, findPath, nearestFree, FREE, ROCK, BLD, CRYS };
})();
