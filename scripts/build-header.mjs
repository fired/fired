// Renders profile/header-dark.svg and profile/header-light.svg:
// a dithered aurora night drive whose stats and speed come from your contributions.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { encodePng } from "./png.mjs";
import { textPath, textWidth } from "./pixel-font.mjs";

const CONFIG = {
  login: process.env.PROFILE_LOGIN || process.env.GITHUB_REPOSITORY_OWNER || "fired",
  name: "fired",
  tagline: "building things after dark",
};

const OUT_DIR = "profile";
// Inter (SIL OFL, see fonts/OFL.txt), subset to printable ASCII and embedded,
// because SVGs shown through <img> cannot load external fonts.
const font = (w) => readFileSync(`fonts/inter-${w}.woff2`).toString("base64");
const FONT_CSS = [400, 600].map((w) =>
  `@font-face { font-family: "Inter Embed"; font-weight: ${w}; src: url(data:font/woff2;base64,${font(w)}) format("woff2"); }`).join("\n  ");
const CACHE = "profile/github-cache.json";
// Markup and config languages that would crowd out the real ones.
const SKIP_LANGS = new Set(["HTML", "CSS", "SCSS", "EJS", "Dockerfile", "Makefile", "Batchfile", "Shell", "PowerShell"]);

// Scene grid: every pixel is drawn as a 4x4 block.
const P = 4;
const GW = 210;
const GH = 64;
const W = GW * P; // 840
const SCENE_H = GH * P; // 256
const H = SCENE_H + 64;
const FRAMES = 12;
const FRAME_SEC = 0.2;
const HORIZON = 48; // first road row

// ---------------------------------------------------------------- data

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

async function fetchStats(login) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    totalContributions weeks{contributionDays{date contributionCount}}}}
    repositories(first:100, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC){nodes{isPrivate
      languages(first:10, orderBy:{field:SIZE, direction:DESC}){edges{size node{name}}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token()}`, "Content-Type": "application/json", "User-Agent": "profile-header" },
    body: JSON.stringify({ query, variables: { login } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays).sort((a, b) => a.date.localeCompare(b.date));
  const counts = days.map((d) => d.contributionCount);

  let i = counts.length - 1;
  if (counts[i] === 0) i--; // today not started yet does not break the streak
  let streak = 0;
  while (i >= 0 && counts[i] > 0) { streak++; i--; }

  // Bytes of code per language across public, non-fork repos you own.
  // Private repos are excluded in the query and again here, so nothing about
  // them ever reaches the header even when run locally with a broader token.
  const bytes = new Map();
  for (const repo of json.data.user.repositories.nodes) {
    if (repo.isPrivate) continue;
    for (const e of repo.languages.edges) {
      if (SKIP_LANGS.has(e.node.name)) continue;
      bytes.set(e.node.name, (bytes.get(e.node.name) || 0) + e.size);
    }
  }
  const sum = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const languages = [...bytes].sort((a, b) => b[1] - a[1])
    .map(([name, size]) => ({ name, pct: Math.round((size / sum) * 1000) / 10 }))
    .filter((l) => l.pct >= 1)
    .slice(0, 5);

  return {
    total: cal.totalContributions,
    languages,
    week: counts.slice(-7).reduce((a, b) => a + b, 0),
    streak,
    best: Math.max(0, ...counts),
    fetchedAt: new Date().toISOString(),
  };
}

async function loadStats() {
  try {
    const stats = await fetchStats(CONFIG.login);
    writeFileSync(CACHE, JSON.stringify(stats, null, 2) + "\n");
    return stats;
  } catch (err) {
    console.warn(`Could not fetch contributions (${err.message}); using cache.`);
    if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8"));
    return { total: 0, week: 0, streak: 0, best: 0, languages: [] };
  }
}

// ---------------------------------------------------------------- noise

function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

// Value noise; the second axis wraps at `period` so the animation loops seamlessly.
function noise(x, y, seed, period = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const wrap = (v) => (period ? ((v % period) + period) % period : v);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const a = hash(x0, wrap(y0), seed), b = hash(x0 + 1, wrap(y0), seed);
  const c = hash(x0, wrap(y0 + 1), seed), d = hash(x0 + 1, wrap(y0 + 1), seed);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

function fbm(x, y, seed, period = 0) {
  let total = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < 3; o++) {
    total += noise(x * 2 ** o, y * 2 ** o, seed + o * 17, period * 2 ** o) * amp;
    norm += amp;
    amp *= 0.5;
  }
  return total / norm;
}

// ---------------------------------------------------------------- palettes

const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

const THEMES = {
  dark: {
    skyTop: hex("#04050d"), skyLow: hex("#141c3a"),
    auroraLow: hex("#3dffa0"), auroraMid: hex("#22d3c5"), auroraTop: hex("#8f5cff"),
    auroraStrength: 1,
    far: hex("#0c1226"), near: hex("#060913"), road: hex("#0b0d16"), edge: hex("#2b3358"),
    text: "#e6edf3", muted: "#8b949e", accent: "#3dffa0",
  },
  light: {
    skyTop: hex("#172048"), skyLow: hex("#6a4f8f"),
    auroraLow: hex("#58f5b0"), auroraMid: hex("#3fd0d8"), auroraTop: hex("#b48cff"),
    auroraStrength: 0.75,
    far: hex("#2c2756"), near: hex("#1b183a"), road: hex("#211d36"), edge: hex("#5c5590"),
    text: "#1f2328", muted: "#59636e", accent: "#1a7f5a",
  },
};

// ---------------------------------------------------------------- scene raster

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const STEP = 22;

const STARS = Array.from({ length: 70 }, (_, i) => ({
  x: Math.floor(hash(i, 1, 7) * GW),
  y: Math.floor(hash(i, 2, 7) * 34),
  b: 0.35 + hash(i, 3, 7) * 0.65,
  phase: hash(i, 4, 7) * Math.PI * 2,
  twinkle: hash(i, 5, 7) > 0.6,
}));

const farRidge = Array.from({ length: GW }, (_, x) =>
  Math.round(37 + (fbm(x * 0.03, 3.3, 91) - 0.5) * 22 + (noise(x * 0.12, 1.7, 13) - 0.5) * 3));

const nearRidge = (() => {
  const h = Array.from({ length: GW }, (_, x) => Math.round(43 + (fbm(x * 0.06, 8.1, 55) - 0.5) * 5));
  // Pines along the near ridge.
  for (let cx = 2; cx < GW; cx += 3 + Math.floor(hash(cx, 9, 3) * 5)) {
    const th = 2 + Math.floor(hash(cx, 10, 3) * 4);
    for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= GW) continue;
      const top = h[cx] - th + Math.ceil(Math.abs(dx) * 2);
      h[x] = Math.min(h[x], top);
    }
  }
  return h;
})();

function aurora(x, y, t, theme) {
  let r = 0, g = 0, b = 0;
  const ribbons = [
    { base: 27, amp: 9, h: 15, seed: 11, s: 1 },
    { base: 19, amp: 7, h: 11, seed: 23, s: 0.6 },
  ];
  for (const rb of ribbons) {
    const edge = rb.base + (fbm(x * 0.016, t, rb.seed, 4) - 0.5) * 2 * rb.amp;
    const rays = 0.35 + 0.65 * noise(x * 0.33, t * 1.5, rb.seed + 5, 6) ** 1.5;
    const height = rb.h * (0.7 + 0.6 * noise(x * 0.05, t, rb.seed + 9, 4));
    const d = edge - y; // rows above the curtain's lower edge
    const intensity = d < 0 ? Math.exp(-(d * d) / 2) : Math.exp(-d / height);
    const k = intensity * rays * rb.s * theme.auroraStrength;
    const m = Math.max(0, Math.min(1, d / height));
    const col = m < 0.4
      ? theme.auroraLow.map((v, i) => lerp(v, theme.auroraMid[i], m / 0.4))
      : theme.auroraMid.map((v, i) => lerp(v, theme.auroraTop[i], (m - 0.4) / 0.6));
    r += col[0] * k; g += col[1] * k; b += col[2] * k;
  }
  return [r, g, b];
}

function renderFrame(frame, theme) {
  const t = (frame / FRAMES) * 4;
  const px = new Uint8Array(GW * GH * 4);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      let c;
      if (y >= HORIZON) {
        c = y === HORIZON ? theme.edge : theme.road;
      } else if (y >= nearRidge[x]) {
        c = theme.near;
      } else if (y >= farRidge[x]) {
        // Ridge tops catch a little aurora light.
        const glow = Math.max(0, 1 - (y - farRidge[x]) / 3) * 0.18;
        c = theme.far.map((v, i) => v + theme.auroraLow[i] * glow);
      } else {
        const m = y / HORIZON;
        c = theme.skyTop.map((v, i) => lerp(v, theme.skyLow[i], m * m));
        const a = aurora(x, y, t, theme);
        c = c.map((v, i) => v + a[i]);
      }
      const o = (y * GW + x) * 4;
      const th = BAYER[y & 3][x & 3] / 16;
      for (let i = 0; i < 3; i++) {
        px[o + i] = Math.max(0, Math.min(255, Math.floor(c[i] / STEP + th) * STEP));
      }
      px[o + 3] = 255;
    }
  }
  for (const s of STARS) {
    if (s.y >= farRidge[s.x]) continue;
    const tw = s.twinkle ? 0.5 + 0.5 * Math.sin((frame / FRAMES) * Math.PI * 2 + s.phase) : 1;
    const o = (s.y * GW + s.x) * 4;
    const v = 255 * s.b * tw;
    for (let i = 0; i < 3; i++) px[o + i] = Math.max(px[o + i], v);
  }
  return encodePng(GW, GH, px).toString("base64");
}

// ---------------------------------------------------------------- car

// A pixel hot hatch in the style of a Golf R: Lapiz Blue, thick C-pillar,
// raked windshield, LED headlight strip, five-spoke wheels and quad exhausts.
// Each row lists [from, to, colour] runs; the car faces right.
const CAR_W = 44;
const CAR_H = 15;
const CAR_ROWS = [
  [[6, 24, "b"]],
  [[5, 8, "b"], [9, 14, "w"], [15, 15, "b"], [16, 23, "w"], [24, 25, "b"]],
  [[4, 7, "b"], [8, 14, "w"], [15, 15, "b"], [16, 25, "w"], [26, 27, "b"], [11, 11, "s"], [19, 19, "s"]],
  [[3, 7, "b"], [8, 14, "w"], [15, 15, "b"], [16, 27, "w"], [28, 29, "b"], [20, 20, "s"]],
  [[2, 33, "b"], [2, 3, "t"]],
  [[2, 40, "b"], [2, 3, "t"]],
  [[1, 42, "b"], [38, 42, "l"]],
  [[1, 43, "b"], [42, 43, "d"]],
  [[1, 43, "e"]],
  [[1, 43, "d"]],
  [[1, 2, "x"], [4, 5, "x"], [6, 42, "d"]],
];
const WHEEL = [
  "..kkkk..",
  ".krrrrk.",
  "krhrrhrk",
  "krrhhrrk",
  "krrhhrrk",
  "krhrrhrk",
  ".krrrrk.",
  "..kkkk..",
];
const WHEELS = [[6, 7], [30, 7]];
const CAR_COLORS = {
  b: "#2563c9", e: "#1d4f9e", d: "#123a78", w: "#121f2c", s: "#7cc4ee", x: "#b8bec9",
  l: "#f4f8ff", t: "#ff3b3b", a: "#05070c", k: "#0b0c10", r: "#c3c9d3", h: "#5c6370",
};

function carRects() {
  const grid = Array.from({ length: CAR_H }, () => Array(CAR_W).fill("."));
  CAR_ROWS.forEach((runs, y) => runs.forEach(([x0, x1, ch]) => { for (let x = x0; x <= x1; x++) grid[y][x] = ch; }));
  // Dark wheel wells hug each tyre, then the wheels drop in.
  for (const [wx, wy] of WHEELS) {
    for (let y = 6; y < CAR_H; y++) {
      for (let x = 0; x < CAR_W; x++) {
        if (grid[y][x] !== "." && Math.hypot(x + 0.5 - (wx + 4), y + 0.5 - (wy + 4)) < 4.5) grid[y][x] = "a";
      }
    }
    WHEEL.forEach((row, dy) => row.split("").forEach((ch, dx) => { if (ch !== ".") grid[wy + dy][wx + dx] = ch; }));
  }
  const rects = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let run = 1;
      while (x + run < row.length && row[x + run] === ch) run++;
      if (ch !== ".") rects.push({ x, y, w: run, color: CAR_COLORS[ch], wheel: "krh".includes(ch) });
      x += run;
    }
  });
  return rects;
}

// ---------------------------------------------------------------- svg

const fmt = (n) => n.toLocaleString("en-US");

function buildSvg(themeName, stats, frames) {
  const theme = THEMES[themeName];
  // Last week's activity sets the road speed: an idle week cruises, a busy one flies.
  const speed = 0.25 + Math.min(1, Math.log10(1 + stats.week) / 2);
  const dashDur = (0.5 / speed).toFixed(2);

  const carX = 280, carY = 246 - CAR_H * P;
  const rects = carRects();
  const rect = (r) => `<rect x="${r.x * P}" y="${r.y * P}" width="${r.w * P}" height="${P}" fill="${r.color}"/>`;
  const body = rects.filter((r) => !r.wheel).map(rect).join("");
  const wheels = rects.filter((r) => r.wheel).map(rect).join("");

  const images = frames.map((data, i) => {
    const values = frames.map((_, j) => (j === i ? 1 : 0)).concat(i === 0 ? 1 : 0).join(";");
    return `<image width="${W}" height="${SCENE_H}" href="data:image/png;base64,${data}" opacity="${i === 0 ? 1 : 0}">` +
      `<animate attributeName="opacity" values="${values}" dur="${FRAMES * FRAME_SEC}s" calcMode="discrete" repeatCount="indefinite"/></image>`;
  }).join("");

  const dashes = Array.from({ length: 16 }, (_, i) => `<rect x="${i * 64}" y="222" width="28" height="4" fill="${theme.muted}" opacity=".55"/>`).join("");
  const posts = Array.from({ length: 8 }, (_, i) => `<rect x="${i * 128 + 40}" y="196" width="4" height="8" fill="${theme.muted}" opacity=".5"/><rect x="${i * 128 + 40}" y="196" width="4" height="4" fill="#ff8a3d" opacity=".8"/>`).join("");

  // Pixel highway signs for your top languages, scrolling past at road speed.
  // Each sign is defined once and reused; copies before and after the strip
  // keep a sign on screen across the loop seam, however many languages there are.
  const SIGN_GAP = 320;
  const DOT = 2;
  const langs = stats.languages || [];
  const stripLen = Math.max(1, langs.length) * SIGN_GAP;
  const snap = (v) => Math.ceil(v / P) * P;
  const signDefs = langs.map((l, i) => {
    const name = l.name.toUpperCase();
    const pct = `${Math.round(l.pct)}%`;
    const w = snap(Math.max(textWidth(name, DOT), textWidth(pct, DOT)) + 6 * P);
    const h = 13 * P; // border, padding, two 7-dot lines and a gap
    const left = -w / 2, top = 128;
    const frame = [
      // Chamfered green field: a cross of two rects leaves the corners cut.
      `<rect x="${left + P}" y="${top}" width="${w - 2 * P}" height="${h}" fill="#17603f"/>`,
      `<rect x="${left}" y="${top + P}" width="${w}" height="${h - 2 * P}" fill="#17603f"/>`,
      // Inset white border, also chamfered.
      `<path d="M${left + 2 * P} ${top + P}h${w - 4 * P}v${DOT}h${-(w - 4 * P)}z` +
        `M${left + 2 * P} ${top + h - P - DOT}h${w - 4 * P}v${DOT}h${-(w - 4 * P)}z` +
        `M${left + P} ${top + 2 * P}h${DOT}v${h - 4 * P}h${-DOT}z` +
        `M${left + w - P - DOT} ${top + 2 * P}h${DOT}v${h - 4 * P}h${-DOT}z" fill="#e8f3ec"/>`,
      // Posts.
      `<rect x="${left + 3 * P}" y="${top + h}" width="${P}" height="${196 - top - h}" fill="#5b6275"/>`,
      `<rect x="${left + w - 4 * P}" y="${top + h}" width="${P}" height="${196 - top - h}" fill="#5b6275"/>`,
    ].join("");
    const nameX = -Math.round(textWidth(name, DOT) / 2 / DOT) * DOT;
    const pctX = -Math.round(textWidth(pct, DOT) / 2 / DOT) * DOT;
    const text = `<path d="${textPath(name, nameX, top + 5 * DOT, DOT)}" fill="#ffffff"/>` +
      `<path d="${textPath(pct, pctX, top + 14 * DOT, DOT)}" fill="#bfe6cf"/>`;
    return `<g id="sign${i}">${frame}${text}</g>`;
  }).join("");
  const copies = [];
  for (let c = -1; c * stripLen < W + stripLen; c++) copies.push(c);
  const signs = langs.length
    ? copies.flatMap((c) => langs.map((_, i) => `<use href="#sign${i}" x="${560 + i * SIGN_GAP + c * stripLen}"/>`)).join("")
    : "";
  const signDur = ((stripLen * dashDur) / 64).toFixed(2);

  const hud = [
    ["ODOMETER", `${fmt(stats.total)}`, "this year"],
    ["STREAK", `${fmt(stats.streak)}`, stats.streak === 1 ? "day" : "days"],
  ].map(([label, value, unit], i) => {
    const x = 16 + i * 240;
    return `<text x="${x}" y="284" class="label">${label}</text>` +
      `<text x="${x}" y="308" class="value">${value}<tspan class="unit" dx="6">${unit}</tspan></text>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
<title>${CONFIG.name}: ${CONFIG.tagline}</title>
<style>
  ${FONT_CSS}
  image { image-rendering: pixelated; image-rendering: crisp-edges; }
  text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .name, .tag { font-family: "Inter Embed", system-ui, sans-serif; filter: url(#soft); }
  .name { font-size: 30px; font-weight: 600; letter-spacing: -.6px; fill: #ffffff; }
  .tag { font-size: 13px; font-weight: 400; letter-spacing: .1px; fill: #ffffff; fill-opacity: .78; }
  .label { font-size: 10px; letter-spacing: 2px; fill: ${theme.muted}; }
  .value { font-size: 20px; font-weight: 700; fill: ${theme.text}; }
  .unit { font-size: 11px; font-weight: 400; fill: ${theme.muted}; }
  .road { animation: road ${dashDur}s linear infinite; }
  .signs { animation: signs ${signDur}s linear infinite; }
  .posts { animation: posts ${(dashDur * 2).toFixed(2)}s linear infinite; }
  .body { animation: bounce .5s steps(1) infinite; }
  @keyframes road { to { transform: translateX(-64px); } }
  @keyframes signs { to { transform: translateX(-${stripLen}px); } }
  @keyframes posts { to { transform: translateX(-128px); } }
  @keyframes bounce { 50% { transform: translateY(-${P / 2}px); } }
  @media (prefers-reduced-motion: reduce) { .road, .posts, .signs, .body { animation: none; } }
</style>
<defs>
  ${signDefs}
  <filter id="soft" x="-20%" y="-50%" width="140%" height="200%"><feDropShadow dx="0" dy="1" stdDeviation="5" flood-color="#02030a" flood-opacity=".7"/></filter>
  <clipPath id="scene"><rect width="${W}" height="${SCENE_H}" rx="12"/></clipPath>
  <linearGradient id="beam" x1="0" x2="1">
    <stop offset="0" stop-color="#fff2b0" stop-opacity=".42"/>
    <stop offset="1" stop-color="#fff2b0" stop-opacity="0"/>
  </linearGradient>
  <radialGradient id="pool"><stop offset="0" stop-color="#fff2b0" stop-opacity=".22"/><stop offset="1" stop-color="#fff2b0" stop-opacity="0"/></radialGradient>
  <radialGradient id="tail"><stop offset="0" stop-color="#ff3b3b" stop-opacity=".55"/><stop offset="1" stop-color="#ff3b3b" stop-opacity="0"/></radialGradient>
</defs>
<g clip-path="url(#scene)">
  ${images}
  <g class="signs">${signs}</g>
  <g class="posts">${posts}</g>
  <g class="road">${dashes}</g>
  <ellipse cx="${carX + CAR_W * P + 150}" cy="232" rx="170" ry="18" fill="url(#pool)"/>
  <polygon points="${carX + CAR_W * P - 2},${carY + 5 * P} ${carX + CAR_W * P + 330},${carY - 6} ${carX + CAR_W * P + 330},${carY + CAR_H * P + 10} ${carX + CAR_W * P - 2},${carY + 7 * P}" fill="url(#beam)"/>
  <circle cx="${carX + 2 * P}" cy="${carY + 5 * P}" r="16" fill="url(#tail)"/>
  <g transform="translate(${carX} ${carY})">
    <g class="body">${body}</g>
    ${wheels}
  </g>
  <text x="28" y="50" class="name">${CONFIG.name}</text>
  <text x="29" y="72" class="tag">${CONFIG.tagline}</text>
</g>
${hud}
</svg>
`;
}

// ---------------------------------------------------------------- main

mkdirSync(OUT_DIR, { recursive: true });
const stats = await loadStats();
console.log("stats", stats);
for (const name of Object.keys(THEMES)) {
  const frames = Array.from({ length: FRAMES }, (_, i) => renderFrame(i, THEMES[name]));
  const svg = buildSvg(name, stats, frames);
  writeFileSync(`${OUT_DIR}/header-${name}.svg`, svg);
  console.log(`${OUT_DIR}/header-${name}.svg ${(svg.length / 1024).toFixed(0)} KB`);
}
