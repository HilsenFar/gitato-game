// Browser smoke test for the fixed sound engine (headless Chromium).
// A: page boots clean. B: GITATO RADIO reacts to sliders + skip never repeats.
// C/D: ASCEND & ORIGINS fetch the CORRECT track file per genre — and NO file
//      (procedural) for genres without one. Exits non-zero on failure.
import { chromium } from "playwright";
import http from "http";
import { readFile } from "fs/promises";
import { join, extname } from "path";

const ROOT = new URL("../..", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".m4a": "audio/mp4", ".png": "image/png", ".webp": "image/webp", ".webmanifest": "application/manifest+json", ".json": "application/json", ".apk": "application/octet-stream" };
const server = http.createServer(async (req, res) => {
  try {
    let p = req.url.split("?")[0];
    if (p === "/") p = "/index.html";
    const data = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("nope");
  }
});
await new Promise((r) => server.listen(8917, r));

const failures = [];
const ok = (cond, msg) => { console.log((cond ? "PASS " : "FAIL ") + msg); if (!cond) failures.push(msg); };

const browser = await chromium.launch({
  headless: true,
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage", "--no-sandbox"]
});

// ---------- helper ----------
async function newPage(withRandomHook) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const tracks = [];
  page.on("request", (r) => { if (r.url().includes(".m4a")) tracks.push(r.url().split("/").pop()); });
  if (withRandomHook) {
    await page.addInitScript(() => {
      const orig = Math.random.bind(Math);
      window.__rv = null;
      Math.random = () => (window.__rv == null ? orig() : window.__rv);
    });
  }
  await page.goto("http://localhost:8917/", { waitUntil: "networkidle" });
  return { ctx, page, errors, tracks };
}

// ---------- A: boot ----------
{
  const { ctx, page, errors } = await newPage(false);
  await page.waitForTimeout(1500);
  const title = await page.locator("#screen-title").isVisible();
  ok(title, "title screen visible after load");
  ok(errors.length === 0, "no console/page errors on boot" + (errors.length ? " — " + errors.slice(0, 3).join(" | ") : ""));
  await ctx.close();
}

// ---------- B: radio (deterministic seeded PRNG → reproducible run) ----------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(() => {
    let seed = 0xC0FFEE;
    Math.random = () => {
      seed |= 0; seed = seed + 1831565813 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  });
  await page.goto("http://localhost:8917/", { waitUntil: "networkidle" });
  await page.click('[data-action="jukebox"]');
  await page.waitForTimeout(2500);
  const g1 = (await page.textContent("#jb-genre")).trim();
  ok(g1 && g1 !== "—", `radio starts and shows a genre ("${g1}")`);

  // push PSYCHEDELIC slider to max, soften the rest → expect psy-branch genre
  await page.evaluate(() => {
    const set = (vibe, val) => {
      const inp = document.querySelector(`#jb-sliders input[data-vibe="${vibe}"]`);
      inp.value = String(val);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    };
    set("hardness", 30); set("speed", 50); set("darkness", 40); set("bounce", 60); set("psy", 100);
  });
  await page.waitForTimeout(1800); // debounce 350ms + crossfade + label update
  const g2 = (await page.textContent("#jb-genre")).trim().replace(/\s+/g, "");
  const psySet = ["psytrance", "psychedelic", "forestpsy"];
  ok(psySet.includes(g2.toLowerCase()), `psy slider retunes radio live (now "${g2}")`);

  // skips: collect genres, verify no immediate repeat + psy-branch majority
  const seen = [];
  let prev = g2;
  for (let i = 0; i < 8; i++) {
    await page.click('[data-jb="skip"]');
    await page.waitForTimeout(700);
    const g = (await page.textContent("#jb-genre")).trim().replace(/\s+/g, "");
    seen.push({ from: prev, to: g });
    prev = g;
  }
  ok(seen.every((s) => s.to !== s.from), "skip never repeats the same genre back-to-back");
  const psyCount = seen.filter((s) => psySet.includes(s.to.toLowerCase())).length;
  ok(psyCount >= 5, `skips stay on the dialled-in psy vibe (${psyCount}/8 in psy branch: ${seen.map((s) => s.to).join(" → ")})`);
  ok(errors.length === 0, "no errors during radio session" + (errors.length ? " — " + errors.slice(0, 3).join(" | ") : ""));
  await ctx.close();
}

// ---------- C: ASCEND fetches the right file per genre ----------
// Object.keys(GENRES) order — psychedelic=18, terror=6, hardstyle=0 of 20.
async function ascendTest(rv, expectFile, label) {
  const { ctx, page, errors, tracks } = await newPage(true);
  await page.evaluate((v) => { window.__rv = v; }, rv);
  await page.click('[data-action="ascend"]');
  try {
    await page.waitForSelector("#hud:not(.hidden)", { timeout: 25000 });
  } catch {
    failures.push(label + ": run never started");
    console.log("FAIL " + label + ": run never started (errors: " + errors.slice(0, 2).join(" | ") + ")");
    await ctx.close();
    return;
  }
  const genreShown = (await page.textContent("#forge-genre")).trim();
  if (expectFile) {
    ok(tracks.length === 1 && tracks[0] === expectFile, `${label}: fetches ${expectFile} (got: ${tracks.join(",") || "none"}) [forge: ${genreShown}]`);
  } else {
    ok(tracks.length === 0, `${label}: NO track file fetched → procedural engine (got: ${tracks.join(",") || "none"}) [forge: ${genreShown}]`);
  }
  ok(errors.length === 0, `${label}: no errors` + (errors.length ? " — " + errors.slice(0, 2).join(" | ") : ""));
  await ctx.close();
}
await ascendTest(0.925, "psychedelic_145.m4a", "ASCEND psychedelic");
await ascendTest(0.275, "industrialhardcore_185.m4a", "ASCEND industrialhardcore");
await ascendTest(0.325, null, "ASCEND terror");
await ascendTest(0.02, "hardstyle_150.m4a", "ASCEND hardstyle");

// ---------- D: ORIGINS — frenchcore no longer hijacks hardcore's file ----------
async function originsTest(rv, expectFile, label) {
  const { ctx, page, errors, tracks } = await newPage(true);
  await page.evaluate((v) => { window.__rv = v; }, rv);
  await page.click('[data-action="origins"]');
  try {
    await page.waitForSelector("#hud:not(.hidden)", { timeout: 25000 });
  } catch {
    failures.push(label + ": run never started");
    console.log("FAIL " + label + ": run never started (errors: " + errors.slice(0, 2).join(" | ") + ")");
    await ctx.close();
    return;
  }
  if (expectFile) ok(tracks.length === 1 && tracks[0] === expectFile, `${label}: fetches ${expectFile} (got: ${tracks.join(",") || "none"})`);
  else ok(tracks.length === 0, `${label}: procedural, no file (got: ${tracks.join(",") || "none"})`);
  ok(errors.length === 0, `${label}: no errors` + (errors.length ? " — " + errors.slice(0, 2).join(" | ") : ""));
  await ctx.close();
}
await originsTest(0.6, null, "ORIGINS frenchcore");
await originsTest(0.1, "hardcore_180.m4a", "ORIGINS hardcore");

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} FAILURES` : "\nALL BROWSER CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
