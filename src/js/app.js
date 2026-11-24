/**
 * @file CthulHue user interface: 3D view, tools, palette, sheets, undo, import and export.
 *
 * Runs as an ES module inside index.html. Depends on globals from the other scripts:
 * `LabCore` (core.js, imported as `C`), `LabMix` (mixer.js), `LabSample` (sample.js),
 * `BAMBU_MEASURED` / `SWATCH_TILES` / `FILAMENT_CATALOG` (data/), `DEFAULT_TEMPLATE` /
 * `SNORCA_TEMPLATE` (slicer project templates) and `JSZip`.
 *
 * Key ideas:
 * - All state lives in `S`. `S.template` is the current project (path → file); its
 *   project_settings.config is the single source of truth for filaments and mixes, and `S.palette`
 *   is re-parsed from it (see commitSettings / setTemplate).
 * - Paint is one 1-based palette slot per triangle (`S.mesh.paint`). Bambu needs every real spool
 *   before every mix, so inserting or removing a filament renumbers paint via remapSlots().
 * - Rendering is on demand: set `needRender = true` after changing anything visible.
 * - Nothing leaves the device. The only network use is fetching the app's own sample and swatch
 *   files; settings persist in localStorage under "labcraft.*".
 * - `S.printer` ('bambu' | 'tc') switches mix colours, the mix gallery and the export format.
 *
 * Unused since v1 but still present: the Outline and Parts tools (no toolbar buttons) and the
 * marching-ants selection materials. Their code paths are unreachable from the UI.
 *
 * Sections (search for "// ----"): state · palette · mix editor · filaments · scene · symmetry ·
 * mesh · view cube · selection display · shading · image projection · undo · picking · outlines ·
 * pointer handling · tools UI · parts · select · loading files · sample · print checks · export.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const C = window.LabCore;
const $ = id => document.getElementById(id);
const MAX_TRIS = 3000000; // refinement stops here so phones and iPads keep enough memory

// ---------------- state ----------------
const S = {
  template: null, palette: [], palSource: 'Default',
  mesh: null, // {verts, tris, paint, wall, adj, normals, cent, area, nT}
  segs: [],   // outline segments, flat [ax,ay,az,bx,by,bz,...]; walls point into this (append-only)
  lines: [],  // outline polylines for display: Float32Array of xyz (already lifted off the surface)
  edges: load('labcraft.edges', false), imgColors: load('labcraft.imgColors', 'mix'), imgMixes: load('labcraft.imgMixes', 8), imgDetail: load('labcraft.imgDetail', 0.5), imgOpacity: load('labcraft.imgOpacity', 55), brushMode: load('labcraft.brushMode', 'hard'), flow: load('labcraft.flow', 25), shSteps: load('labcraft.shSteps', 6), fillMode: load('labcraft.fillMode', 'solid'), smoothGrad: load('labcraft.smoothGrad', false), printer: load('labcraft.printer', 'bambu'), sym: 'off', symCtr: null, symSetting: false, symTaps: [], selMode: 'new', free: load('labcraft.free', false), creases: load('labcraft.creases', false), cavity: load('labcraft.cavity', false),
  slot: 1, tool: 'brush', size: 3, angle: 30, detail: 0.35, stream: load('labcraft.stream', 60), pressure: true, finger: false,
  parts: null, partsMethod: 'lines', showParts: true, sel: null, step: 1, smooth: 2,
  undo: [], redo: [], name: 'Painted model', checking: false,
};
let downloads = null;
if (window.claude && typeof window.claude.use === 'function') {
  window.claude.use('downloads').then(d => { downloads = d; }).catch(() => {});
}
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
let names = load('labcraft.names', {});
// Colors Bambu Studio has shown for mix recipes, learned from projects you open.
let learned = load('labcraft.mixcolors', {});
function recipeKey(comps, weights, pal) { return C.mixKey(comps.map(c => (pal[c - 1] || {}).color || '#808080'), weights); }
function learnMixColors(pal) {
  let changed = false;
  for (const p of pal) {
    if (!p.mixed || p.components.length < 2 || p.components.length !== p.ratios.length) continue;
    if (p.components.some(c => !pal[c - 1] || pal[c - 1].mixed)) continue;
    const k = recipeKey(p.components, p.ratios, pal);
    if (learned[k] !== p.color) { learned[k] = p.color; changed = true; }
  }
  if (changed) store('labcraft.mixcolors', learned);
}

// ---------------- toast / status ----------------
let toastT;
function toast(msg, ms) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 3200);
}
function status() {
  if (!S.mesh) { $('status').textContent = 'No model loaded'; return; }
  const p = S.palette[S.slot - 1];
  $('status').textContent = S.mesh.nT.toLocaleString() + ' triangles · painting with ' + S.slot + ' · ' + (p ? label(p) : '');
}

// ---------------- palette ----------------
function nameKey(p) { return p.color + (p.mixed ? '|' + p.components.join('+') + '|' + p.ratios.map(r => r.toFixed(2)).join('+') : ''); }
function label(p) { return names[nameKey(p)] || p.name; }
function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function loadDefaultTemplate() {
  const t = {};
  for (const [p, v] of Object.entries(window.DEFAULT_TEMPLATE)) t[p] = typeof v === 'string' ? v : b64ToBytes(v.b64);
  const saved = load('labcraft.template', null);
  if (saved && saved.files && saved.files['Metadata/project_settings.config']) {
    for (const [p, v] of Object.entries(saved.files)) t[p] = v;
    S.palSource = saved.label || 'Saved';
  }
  return t;
}
function templateOf(files) { const t = {}; for (const p in files) if (!/^3D\/Objects\//.test(p)) t[p] = files[p]; return t; }
function setTemplate(t, labelText, remember) {
  S.template = t;
  S.palette = C.parsePalette(JSON.parse(t['Metadata/project_settings.config']));
  learnMixColors(S.palette);
  if (labelText) S.palSource = labelText;
  if (remember) {
    const keep = {};
    for (const p of ['Metadata/project_settings.config', 'Metadata/model_settings.config', '3D/3dmodel.model']) if (typeof t[p] === 'string') keep[p] = t[p];
    store('labcraft.template', { label: S.palSource, files: keep });
  }
  if (S.slot > S.palette.length) S.slot = 1;
  buildPaletteColors();
  if (S.mesh) {
    let clamped = 0;
    for (let i = 0; i < S.mesh.nT; i++) if (S.mesh.paint[i] > S.palette.length || S.mesh.paint[i] === 0) { S.mesh.paint[i] = 1; clamped++; }
    if (clamped) toast(clamped.toLocaleString() + ' triangles used slots this palette does not have and were set to slot 1');
    recolorAll();
  }
  renderPalette(); status();
}
let palLinear = [];
function buildPaletteColors() {
  palLinear = [[200, 200, 200]];
  const c = new THREE.Color();
  for (const p of S.palette) { c.setStyle(p.color); palLinear.push([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]); }
}
function swatchBg(p) {
  if (!p.gradient || !p.components || p.components.length !== 2) return p.color;
  const A = (S.palette[p.components[0] - 1] || p).color, B = (S.palette[p.components[1] - 1] || p).color;
  const st = gradStart(p);
  return 'linear-gradient(to top,' + (st >= 0.5 ? A + ',' + B : B + ',' + A) + ')';
}
function gradStart(p) { const v = parseFloat(String(p.gradRange || '0.9,0.1').split(',')[0]); return isFinite(v) ? v : 0.9; }
// Shading mixes made from the same filaments (e.g. Cyan 75/50/25% + Black) are grouped under one
// collapsible row so the list stays short. Groups start collapsed; open ones are remembered.
let palOpen = new Set(load('labcraft.palOpen', []));
function paletteGroups() {
  const by = new Map();
  for (const p of S.palette) {
    if (!p.mixed || p.gradient || !p.components || p.components.length < 2) continue;
    const key = p.components.slice().sort((a, b) => a - b).join('+');
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(p);
  }
  const groupOf = new Map();
  for (const [key, list] of by) if (list.length >= 2) for (const p of list) groupOf.set(p.slot, key);
  return { by, groupOf };
}
function swatchButton(p, areas, sub) {
  const b = document.createElement('button');
  b.className = 'sw' + (p.slot === S.slot ? ' on' : '') + (sub ? ' sub' : '');
  let mini = '';
  if (p.mixed) mini = '<span class="mini">' + p.components.map(s => '<span style="background:' + (S.palette[s - 1] ? S.palette[s - 1].color : '#999') + '"></span>').join('') + '</span>';
  const pct = areas ? Math.round(100 * (areas[p.slot] || 0) / areas.total) : 0;
  b.innerHTML = '<span class="dot" style="background:' + swatchBg(p) + '">' + mini + '</span><span class="t"><div class="n"></div><div class="m">' +
    (p.mixed ? p.name.replace(/^Mix /, '') : p.color) + (pct > 0 ? ' · ' + pct + '%' : '') + '</div></span><span class="slot">' + p.slot + '</span>';
  let subName = '';
  if (sub) { const r = recipeOf(p.slot) || {}; subName = sub.split('+').map(c => Math.round(100 * (r[c] || 0))).join('/'); }
  b.querySelector('.n').textContent = sub ? subName : label(p);
  if (sub) b.querySelector('.m').textContent = p.color + (pct > 0 ? ' · ' + pct + '%' : '');
  if (p.mixed && !sub) b.querySelector('.n').insertAdjacentHTML('beforeend', '<span class="tag">' + (p.gradient ? 'GRADIENT' : 'MIX') + '</span>');
  b.onclick = () => { S.slot = p.slot; renderPalette(); status(); if (S.sel) openSel(); };
  const ed = document.createElement('span'); ed.className = 'edit'; ed.textContent = 'Edit'; ed.setAttribute('role', 'button');
  ed.onclick = ev => { ev.stopPropagation(); p.mixed ? openMixEditor(p) : openPhysEditor(p); };
  b.appendChild(ed);
  return b;
}
function renderPalette() {
  const box = $('swatches'); box.innerHTML = '';
  $('palSrc').textContent = '· ' + S.palSource;
  const areas = slotAreas();
  const { by, groupOf } = paletteGroups(), done = new Set();
  S.palette.forEach(p => {
    const key = groupOf.get(p.slot);
    if (!key) { box.appendChild(swatchButton(p, areas, false)); return; }
    if (done.has(key)) return;
    done.add(key);
    const list = by.get(key).slice().sort((a, b) => a.slot - b.slot);
    const open = palOpen.has(key), has = list.some(q => q.slot === S.slot);
    const h = document.createElement('button');
    h.className = 'sw grp' + (has && !open ? ' on' : '') + (open ? ' open' : '');
    const names = key.split('+').map(c => S.palette[c - 1] ? label(S.palette[c - 1]) : '#' + c);
    const pct = areas ? list.reduce((a, q) => a + (areas[q.slot] || 0), 0) / areas.total * 100 : 0;
    const stops = list.map(q => q.color).join(',');
    h.innerHTML = '<span class="dot strip" style="background:linear-gradient(90deg,' + stops + ')"></span><span class="t"><div class="n"></div><div class="m"></div></span>' +
      '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
    h.querySelector('.n').textContent = names.join(' + ');
    h.querySelector('.m').textContent = list.length + ' shades' + (pct >= 0.5 ? ' · ' + Math.round(pct) + '%' : '') + (has && !open ? ' · in use: ' + S.slot : '');
    h.title = (open ? 'Hide' : 'Show') + ' these shades';
    h.onclick = () => { if (open) palOpen.delete(key); else palOpen.add(key); store('labcraft.palOpen', [...palOpen]); renderPalette(); };
    box.appendChild(h);
    if (open) {
      const wrap = document.createElement('div'); wrap.className = 'grpList';
      for (const q of list) wrap.appendChild(swatchButton(q, areas, key));
      const unused = S.mesh ? list.filter(q => !(areas && areas[q.slot] > 0)) : [];
      if (unused.length && unused.length < list.length + 1) {
        const rm = document.createElement('button'); rm.className = 'link rmUnused';
        const label0 = 'Remove ' + unused.length + ' unused shade' + (unused.length > 1 ? 's' : '');
        rm.textContent = label0;
        rm.onclick = () => {
          if (!rm.dataset.armed) { rm.dataset.armed = '1'; rm.textContent = 'Tap again to remove ' + unused.length; setTimeout(() => { if (rm.isConnected) { delete rm.dataset.armed; rm.textContent = label0; } }, 3500); return; }
          removeShades(unused.map(q => q.slot), list.map(q => q.slot));
        };
        wrap.appendChild(rm);
      }
      box.appendChild(wrap);
    }
  });
}
// Delete shade mixes that aren't on the model. Undo steps that used one switch to the closest
// remaining shade in the same group, so undoing still looks right.
function removeShades(gone, group) {
  if (S.mesh && gone.some(sl => S.mesh.paint.includes(sl))) { toast('One of those shades is on the model now. Nothing was removed.'); renderPalette(); return; }
  const keep = group.filter(sl => !gone.includes(sl));
  const dist = (a, b) => { const ra = recipeOf(a) || {}, rb = recipeOf(b) || {}; let d = 0; for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) d += Math.abs((ra[k] || 0) - (rb[k] || 0)); return d; };
  let st = JSON.parse(S.template['Metadata/project_settings.config']);
  for (const d of gone.slice().sort((a, b) => b - a)) {
    let best = 1, bd = 1e9;
    for (const k of keep) { const x = dist(d, k); if (x < bd) { bd = x; best = k; } }
    if (!keep.length) { // no shade left: use the group's main filament
      const r = recipeOf(d) || {}; let w = -1; for (const c in r) if (r[c] > w) { w = r[c]; best = +c; }
    }
    const to = best > d ? best - 1 : best;
    const fn = v => v === d ? to : v > d ? v - 1 : v;
    remapSlots(fn);
    const sv = S.mesh && S.mesh.shade;
    if (sv) for (let t = 0; t < sv.slot.length; t++) { if (sv.slot[t]) sv.slot[t] = fn(sv.slot[t]); if (sv.base[t]) sv.base[t] = fn(sv.base[t]); if (sv.to[t]) sv.to[t] = fn(sv.to[t]); }
    if (S.slot === d) S.slot = to; else if (S.slot > d) S.slot--;
    for (let i = 0; i < keep.length; i++) if (keep[i] > d) keep[i]--;
    st = C.deleteSlot(st, d);
  }
  ramps.clear(); rampOf.clear(); // slot numbers moved; ramps are found again from recipes
  commitSettings(st);
  toast('Removed ' + gone.length + ' unused shade' + (gone.length > 1 ? 's' : '') + '.');
}
function slotAreas() {
  if (!S.mesh) return null;
  const a = { total: 0 };
  const { paint, area, nT } = S.mesh;
  for (let i = 0; i < nT; i++) { a[paint[i]] = (a[paint[i]] || 0) + area[i]; a.total += area[i]; }
  return a;
}
$('bRename').onclick = () => {
  const box = $('nameList'); box.innerHTML = '';
  S.palette.forEach(p => {
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = p.color;
    const i = document.createElement('input'); i.value = label(p); i.dataset.key = nameKey(p); i.placeholder = p.name;
    box.append(d, i);
  });
  $('renameSheet').classList.add('open');
};
$('nCancel').onclick = () => $('renameSheet').classList.remove('open');
$('nSave').onclick = () => {
  const auto = {}; S.palette.forEach(p => auto[nameKey(p)] = p.name);
  $('nameList').querySelectorAll('input').forEach(i => {
    const v = i.value.trim();
    if (!v || v === auto[i.dataset.key]) delete names[i.dataset.key]; else names[i.dataset.key] = v;
  });
  store('labcraft.names', names);
  $('renameSheet').classList.remove('open'); renderPalette(); status();
};

// ---------------- mix editor ----------------
let mixEdit = null; // {slot|null, comps:[slots], w:{slot:percent}}
function physicalPalette() { return S.palette.filter(p => !p.mixed); }
function openMixEditor(p) {
  if (p) {
    const w = {}; p.components.forEach((c, i) => w[c] = Math.round((p.ratios[i] || 0.5) * 100));
    mixEdit = { slot: p.slot, comps: p.components.slice(), w };
  } else {
    const phys = physicalPalette();
    if (phys.length < 2) { toast('A mix needs at least two real filaments in the palette.'); return; }
    mixEdit = { slot: null, comps: [], w: {} };
  }
  $('mixTitle').textContent = p ? 'Change mix (slot ' + p.slot + ')' : 'New mix';
  $('mSave').textContent = p ? 'Save' : 'Add mix';
  $('mDelete').style.display = p ? '' : 'none';
  $('galNote').textContent = '';
  renderMix();
  renderGallery();
  $('mixSheet').classList.add('open');
}
function mixPercents() {
  const tot = mixEdit.comps.reduce((a, c) => a + mixEdit.w[c], 0) || 1;
  const pc = mixEdit.comps.map(c => Math.round(100 * mixEdit.w[c] / tot));
  if (pc.length) pc[0] += 100 - pc.reduce((a, b) => a + b, 0);
  return pc;
}
const isTC = () => S.printer === 'tc';
function mixColor() {
  const pc = mixPercents();
  const hexes = mixEdit.comps.map(c => S.palette[c - 1].color);
  if (isTC()) return { color: LabMix.formula(hexes, pc), source: 'fs' };
  const k = recipeKey(mixEdit.comps, pc, S.palette);
  if (learned[k]) return { color: learned[k], source: 'seen' };
  const m = LabMix.measured(hexes, pc);
  if (m) return { color: m, source: 'measured' };
  return { color: LabMix.blend(hexes, pc), source: 'formula' };
}
function syncGalleryHighlight() {
  const pc = mixPercents();
  const cur = mixEdit.comps.length >= 2 ? mixEdit.comps.map((c, i) => c + ':' + pc[i]).sort().join('|') : '';
  $('galGrid').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', !!cur && b.dataset.key === cur);
  });
}
let galN = 0, galTarget = null; // gallery filter: number of filaments (0 = all), colour to match
/**
 * Bambu's measured mixes whose filaments are all in this palette. Filaments match by exact hex,
 * since Bambu's table is keyed by its own filament colours.
 * @returns {Array<{slots: number[], pc: number[], color: string, lab: number[], hue: number, chroma: number}>}
 *   Sorted neutrals first (dark to light), then around the colour wheel.
 */
function measuredForPalette() {
  const table = window.BAMBU_MEASURED || {};
  const slotOf = {};
  for (const p of S.palette) if (!p.mixed && !(p.color in slotOf)) slotOf[p.color] = p.slot;
  const out = [];
  for (const [k, anchors] of Object.entries(table)) {
    const hexes = k.match(/#[0-9A-F]{6}/g);
    if (!hexes.every(h => h in slotOf)) continue;
    const seen = new Set();
    for (const a of anchors) {
      const pc = a.slice(0, hexes.length);
      const id = pc.join('/'); if (seen.has(id)) continue; seen.add(id);
      const lab = [a[hexes.length], a[hexes.length + 1], a[hexes.length + 2]];
      out.push({ slots: hexes.map(h => slotOf[h]), pc, color: a[hexes.length + 3], lab,
        hue: (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360, chroma: Math.hypot(lab[1], lab[2]) });
    }
  }
  // neutrals first (dark to light), then around the color wheel
  out.sort((a, b) => (a.chroma < 12) !== (b.chroma < 12) ? (a.chroma < 12 ? -1 : 1)
    : a.chroma < 12 ? a.lab[0] - b.lab[0] : Math.round(a.hue / 15) - Math.round(b.hue / 15) || a.lab[0] - b.lab[0]);
  return out;
}
/**
 * Swatch tile number (1–290) of a gallery mix, matching the number printed on the back of the tile.
 * Only measured Bambu PLA Palette CMYKW mixes have tiles, so predicted galleries return 0.
 * @param {{slots: number[], pc: number[]}} m Gallery entry.
 * @returns {number} Tile number, or 0.
 */
function tileOf(m) {
  const T = window.SWATCH_TILES; if (!T || galPredicted) return 0;
  return T[m.slots.map((c, i) => S.palette[c - 1].color.toUpperCase() + ':' + m.pc[i]).sort().join('|')] || 0;
}
/**
 * Predicted mixes of the palette's own filaments (any brand): every pair in 10% steps and every
 * three in fixed 60/20/20 and 40/40/20 splits. Colours from LabMix.formula, as Full Spectrum shows them.
 * @returns {Array} Same shape and order as {@link measuredForPalette}.
 */
function predictedForPalette() {
  const phys = physicalPalette().filter(p => !p.gradient), out = [];
  const push = (ps, pc) => {
    const color = LabMix.formula(ps.map(p => p.color), pc), lab = C.hexToLab(color);
    out.push({ slots: ps.map(p => p.slot), pc, color, lab, hue: (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360, chroma: Math.hypot(lab[1], lab[2]) });
  };
  for (let i = 0; i < phys.length; i++) for (let j = i + 1; j < phys.length; j++)
    for (let a = 10; a <= 90; a += 10) push([phys[i], phys[j]], [a, 100 - a]);
  const tri = [[60, 20, 20], [20, 60, 20], [20, 20, 60], [40, 40, 20], [40, 20, 40], [20, 40, 40]];
  for (let i = 0; i < phys.length; i++) for (let j = i + 1; j < phys.length; j++) for (let k = j + 1; k < phys.length; k++)
    for (const t of tri) push([phys[i], phys[j], phys[k]], t);
  out.sort((a, b) => (a.chroma < 12) !== (b.chroma < 12) ? (a.chroma < 12 ? -1 : 1)
    : a.chroma < 12 ? a.lab[0] - b.lab[0] : Math.round(a.hue / 15) - Math.round(b.hue / 15) || a.lab[0] - b.lab[0]);
  return out;
}
let galPredicted = false;
/**
 * Mixes offered in the New mix gallery and to the Image tool's "Add mixes": Bambu's measured mixes
 * for Bambu printers when it has any for this palette, otherwise predictions (toolchangers, or
 * filaments Bambu never measured). Sets `galPredicted`.
 * @returns {Array}
 */
function galleryMixes() {
  if (!isTC()) { const m = measuredForPalette(); if (m.length) { galPredicted = false; return m; } }
  galPredicted = true; return predictedForPalette();
}
function renderGallery() {
  const all = galleryMixes();
  $('galHeadTxt').textContent = galPredicted ? 'Start from a predicted mix' : 'Start from a measured mix';
  $('galPrint').style.display = galPredicted ? 'none' : '';
  $('galTile').style.display = galPredicted ? 'none' : '';
  $('gal').style.display = all.length ? '' : 'none';
  if (!all.length) return;
  let list = all.filter(m => !galN || m.slots.length === galN);
  if (galTarget) {
    const t = C.hexToLab(galTarget);
    list = list.map(m => Object.assign({ d: Math.hypot(m.lab[0] - t[0], m.lab[1] - t[1], m.lab[2] - t[2]) }, m)).sort((a, b) => a.d - b.d);
  }
  const grid = $('galGrid'); grid.innerHTML = '';
  const curKey = mixEdit && mixEdit.comps.length >= 2 ? mixEdit.comps.map((c, i) => c + ':' + mixPercents()[i]).sort().join('|') : '';
  for (const m of list) {
    const b = document.createElement('button');
    const key = m.slots.map((c, i) => c + ':' + m.pc[i]).sort().join('|');
    b.dataset.key = key;
    if (key === curKey) b.className = 'on';
    b.style.background = m.color;
    const names = m.slots.map((c, i) => label(S.palette[c - 1]) + ' ' + m.pc[i] + '%').join(' + ');
    b.title = names; b.setAttribute('aria-label', names);
    const tile = tileOf(m);
    b.innerHTML = (tile ? '<b>' + tile + '</b>' : '') + '<i>' + m.slots.map(c => '<span style="background:' + S.palette[c - 1].color + '"></span>').join('') + '</i>';
    if (tile) b.dataset.tile = tile;
    b.onclick = () => {
      mixEdit.comps = m.slots.slice(); mixEdit.w = {};
      m.slots.forEach((c, i) => mixEdit.w[c] = m.pc[i]);
      renderMix();
      $('galNote').textContent = (tile ? 'Tile ' + tile + ' · ' : '') + names + (m.d != null ? ' · difference from your color: ' + m.d.toFixed(0) : '');
    };
    grid.appendChild(b);
  }
  if (galTarget && list.length) grid.scrollTop = 0;
  if (!$('galNote').textContent) $('galNote').textContent = list.length + (galPredicted ? ' mixes of your filaments, colors as ' + (isTC() ? 'Full Spectrum previews them' : 'Bambu Studio estimates them') : ' mixes Bambu has measured with your filaments') + (galTarget ? ', closest to your color first.' : '. Tap one to start from it.');
}
document.querySelectorAll('#galSeg button').forEach(b => b.onclick = () => {
  galN = +b.dataset.n; document.querySelectorAll('#galSeg button').forEach(x => x.classList.toggle('on', x === b));
  $('galNote').textContent = ''; renderGallery();
});
$('galTarget').oninput = e => { galTarget = e.target.value.toUpperCase(); $('galMatchTxt').textContent = 'Matching ' + galTarget; $('galClear').style.display = ''; $('galNote').textContent = ''; renderGallery(); };
$('galTile').addEventListener('input', () => {
  const n = parseInt($('galTile').value, 10); if (!n) return;
  const b = $('galGrid').querySelector('button[data-tile="' + n + '"]');
  if (!b) { $('galNote').textContent = 'Tile ' + n + ' isn’t in this gallery' + (galN ? ' (try All)' : '') + '. Tiles need Bambu PLA Palette CMYKW in your palette.'; return; }
  b.click(); b.scrollIntoView({ block: 'nearest' });
});
/**
 * Switch printer type: 'bambu' (AMS, Bambu Studio export, measured mixes) or 'tc'
 * (toolchanger, Snapmaker Orca export, predicted mixes). Saved in localStorage.
 * @param {string} v 'bambu' or 'tc'.
 */
function setPrinter(v) {
  S.printer = v === 'tc' ? 'tc' : 'bambu'; store('labcraft.printer', S.printer);
  document.querySelectorAll('#printerSeg button').forEach(b => b.classList.toggle('on', b.dataset.p === S.printer));
  const sel = $('printerSel'); if (sel) sel.value = S.printer;
  printerHint();
  if ($('mixSheet').classList.contains('open')) { $('galNote').textContent = ''; renderGallery(); updateMixReadout(); }
  try { refreshRows(); } catch (_) {}
}
function printerHint() {
  const n = physicalPalette().length, h = $('printerHint'); if (!h) return;
  h.textContent = isTC() && n > 4 ? 'Most toolchangers (Snapmaker U1, Flashforge Creator 5) hold 4 filaments; this palette has ' + n + '.' : '';
}
document.querySelectorAll('#printerSeg button').forEach(b => b.onclick = () => setPrinter(b.dataset.p));
$('printerSel').onchange = e => setPrinter(e.target.value);
$('galPrint').onclick = () => $('swatchSheet').classList.add('open');
$('swatchClose').onclick = () => $('swatchSheet').classList.remove('open');
$('swatchSheet').addEventListener('click', e => { if (e.target.id === 'swatchSheet') $('swatchSheet').classList.remove('open'); });
$('swatchGet').onclick = async () => {
  const btn = $('swatchGet'); btn.disabled = true; const was = btn.textContent; btn.textContent = 'Getting files…';
  try {
    let r = null; for (const u of ['/_blob/fc0e6c54b04e1c9bef016373001a4fb5', 'swatches/CthulHue-swatch-prints.zip']) { try { r = await fetch(u); if (r.ok) break; } catch (_) {} r = null; }
    if (!r) throw new Error('missing');
    const blob = await r.blob(), name = 'CthulHue swatch prints.zip';
    if (downloads) {
      try { await downloads.save({ filename: name, data: blob }); toast('Saved. Unzip it and open the 3MF files in Bambu Studio.', 6000); $('swatchSheet').classList.remove('open'); }
      catch (err) { toast(err && err.code === 'declined' ? 'Download cancelled' : 'Could not save here (' + (err && err.code || 'error') + ').', 6000); }
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
  } catch (e) { toast('Couldn’t load the swatch files here.', 6000); }
  btn.disabled = false; btn.textContent = was;
};
$('galClear').onclick = () => { galTarget = null; $('galMatchTxt').textContent = 'Match a color'; $('galClear').style.display = 'none'; $('galNote').textContent = ''; renderGallery(); };
function renderMix() {
  const chips = $('mixChips'); chips.innerHTML = '';
  for (const p of physicalPalette()) {
    const on = mixEdit.comps.includes(p.slot);
    const b = document.createElement('button');
    b.className = 'chip' + (on ? ' on' : '');
    b.disabled = !on && mixEdit.comps.length >= 3;
    b.innerHTML = '<span class="dot" style="background:' + p.color + '"></span><span></span>';
    b.lastChild.textContent = label(p);
    b.onclick = () => {
      if (on) mixEdit.comps = mixEdit.comps.filter(c => c !== p.slot);
      else { mixEdit.comps.push(p.slot); }
      const even = Math.round(100 / Math.max(1, mixEdit.comps.length));
      mixEdit.comps.forEach(c => mixEdit.w[c] = even);
      renderMix();
    };
    chips.appendChild(b);
  }
  const rows = $('mixRows'); rows.innerHTML = '';
  const pc = mixPercents();
  mixEdit.comps.forEach((c, i) => {
    const p = S.palette[c - 1];
    const r = document.createElement('div'); r.className = 'mixrow';
    r.innerHTML = '<span class="dot" style="background:' + p.color + '"></span><input type="range" min="10" max="90" step="5"><b>' + pc[i] + '%</b>';
    const inp = r.querySelector('input'); inp.value = mixEdit.w[c];
    inp.setAttribute('aria-label', label(p) + ' amount');
    inp.oninput = () => {
      mixEdit.w[c] = +inp.value;
      if (mixEdit.comps.length === 2) { const o = mixEdit.comps[1 - i]; mixEdit.w[o] = 100 - +inp.value; }
      updateMixReadout();
    };
    rows.appendChild(r);
  });
  updateMixReadout();
}
function updateMixReadout() {
  const ok = mixEdit.comps.length >= 2;
  syncGalleryHighlight();
  const pc = mixPercents();
  $('mixRows').querySelectorAll('.mixrow').forEach((r, i) => {
    r.querySelector('b').textContent = pc[i] + '%';
    if (mixEdit.comps.length === 2) r.querySelector('input').value = mixEdit.w[mixEdit.comps[i]];
  });
  $('mSave').disabled = !ok;
  if (!ok) { $('mixBig').style.background = 'repeating-linear-gradient(45deg,#e4e0d8 0 8px,#f3f0ea 8px 16px)'; $('mixCap').innerHTML = '<b>Pick ' + (2 - mixEdit.comps.length) + ' more</b>Choose 2 or 3 filaments above.'; return; }
  const m = mixColor();
  $('mixBig').style.background = m.color;
  $('mixCap').innerHTML = '<b>' + C.colorName(m.color) + ' · ' + m.color + '</b>' +
    (m.source === 'seen' ? 'The color Bambu Studio showed for this exact recipe in one of your projects.'
      : m.source === 'fs' ? 'The preview color Full Spectrum and Snapmaker Orca show for this recipe. How it prints depends on your filaments: translucent ones blend best, and thin layers (0.08–0.12 mm) help. Print a test for anything important.'
      : m.source === 'measured' ? 'Bambu Studio\'s prediction, from its measurements of real prints of these filaments.'
      : 'Estimate. Bambu has no measurements for these filaments, so the printed color may differ; print a test swatch for anything important.');
}
function commitSettings(st) {
  const t = Object.assign({}, S.template);
  t['Metadata/project_settings.config'] = JSON.stringify(st);
  setTemplate(t, S.palSource.replace(/ \(edited\)$/, '') + ' (edited)', true);
}
$('mCancel').onclick = () => $('mixSheet').classList.remove('open');
$('mixSheet').addEventListener('click', e => { if (e.target.id === 'mixSheet') $('mixSheet').classList.remove('open'); });
$('bNewMix').onclick = () => openMixEditor(null);
setTimeout(() => setPrinter(S.printer), 0);
$('mSave').onclick = () => {
  const settings = JSON.parse(S.template['Metadata/project_settings.config']);
  const pc = mixPercents();
  const { color } = mixColor();
  if (mixEdit.slot) {
    commitSettings(C.editMix(settings, mixEdit.slot, mixEdit.comps, pc, color));
    toast('Mix updated. Everything painted with slot ' + mixEdit.slot + ' uses the new recipe.');
  } else {
    const st = C.addMix(settings, mixEdit.comps, pc, color);
    commitSettings(st);
    S.slot = S.palette.length; renderPalette(); status();
    toast('Added mix as slot ' + S.slot + ' and selected it.');
  }
  $('mixSheet').classList.remove('open');
};
/**
 * Renumber painted slots everywhere (model and every undo/redo step) after filaments are inserted,
 * removed or reordered, so undo still restores the right colours.
 * @param {function(number): number} fn Old 1-based slot → new slot (0 stays unpainted).
 */
function remapSlots(fn) {
  const fix = a => { for (let i = 0; i < a.length; i++) a[i] = fn(a[i]); };
  if (S.mesh) fix(S.mesh.paint);
  for (const st of S.undo.concat(S.redo)) {
    if (st.kind === 'paint') { fix(st.from); fix(st.to); continue; }
    if (S.mesh && st.paint === S.mesh.paint) continue;
    fix(st.paint);
  }
  if (S.sel) S.sel.color = fn(S.sel.color);
}
$('mDelete').onclick = () => {
  const slot = mixEdit.slot;
  if (S.mesh && S.mesh.paint.includes(slot)) {
    toast('This mix is painted on the model. Recolor those areas first, then delete it.', 5000); return;
  }
  remapSlots(v => v === slot ? 1 : v > slot ? v - 1 : v);
  if (S.slot === slot) S.slot = 1; else if (S.slot > slot) S.slot--;
  commitSettings(C.deleteSlot(JSON.parse(S.template['Metadata/project_settings.config']), slot));
  $('mixSheet').classList.remove('open');
  toast('Mix deleted.');
};

// ---------------- regular filaments ----------------
let filLine = 'all', filPick = null, filBrand = load('labcraft.filBrand', 'Bambu Lab'); // {name, line, color}
function catalogEntries() {
  const out = [];
  for (const l of (window.FILAMENT_CATALOG || [])) for (const [n, c] of l.colors) out.push({ name: n, line: l.line, brand: l.brand, color: c });
  return out;
}
function openAddFilament() {
  filPick = null; $('fSearch').value = '';
  renderFilLines(); updateFilPick();
  $('filSheet').classList.add('open');
}
const lineLabel = l => l.replace('Panchroma ', '');
function renderFilLines() {
  document.querySelectorAll('#fBrand button').forEach(b => b.classList.toggle('on', b.dataset.b === filBrand));
  const lines = $('fLines'); lines.innerHTML = '';
  const cat = (window.FILAMENT_CATALOG || []).filter(l => l.brand === filBrand);
  if (filLine !== 'all' && !cat.some(l => l.line === filLine)) filLine = 'all';
  const mk = (id, text) => { const b = document.createElement('button'); b.textContent = text; b.className = filLine === id ? 'on' : ''; b.onclick = () => { filLine = id; [...lines.children].forEach(x => x.classList.toggle('on', x === b)); renderFilGrid(); }; lines.appendChild(b); };
  mk('all', filBrand === 'Polymaker' ? 'All Panchroma' : 'All Bambu');
  for (const l of cat) mk(l.line, lineLabel(l.line));
  renderFilGrid();
}
document.querySelectorAll('#fBrand button').forEach(b => b.onclick = () => { filBrand = b.dataset.b; store('labcraft.filBrand', filBrand); filLine = 'all'; renderFilLines(); });
function renderFilGrid() {
  const q = $('fSearch').value.trim().toLowerCase();
  const grid = $('fGrid'); grid.innerHTML = '';
  const have = new Set(physicalPalette().map(p => p.color));
  for (const e of catalogEntries()) {
    if (e.brand !== filBrand && !q) continue;
    if (!q && filLine !== 'all' && e.line !== filLine) continue;
    if (q && !(e.line + ' ' + e.name + ' ' + C.colorName(e.color)).toLowerCase().includes(q)) continue;
    const b = document.createElement('button');
    if (filPick && filPick.color === e.color && filPick.name === e.name) b.className = 'on';
    b.innerHTML = '<span class="dot" style="background:' + e.color + '"></span><span></span>';
    b.lastChild.textContent = e.name; b.lastChild.insertAdjacentHTML('beforeend', '<small>' + (e.brand !== filBrand ? e.brand + ' ' : '') + lineLabel(e.line) + (have.has(e.color) ? ' · in palette' : '') + '</small>');
    b.onclick = () => { filPick = { name: (e.brand === 'Bambu Lab' ? 'Bambu ' : '') + e.line + ' ' + e.name, color: e.color }; renderFilGrid(); updateFilPick(); };
    grid.appendChild(b);
  }
  if (!grid.children.length) grid.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px">No colors match. Use a custom color below.</div>';
}
function updateFilPick() {
  const p = filPick;
  $('fAdd').disabled = !p;
  if (!p) { $('fBig').style.background = 'repeating-linear-gradient(45deg,#e4e0d8 0 8px,#f3f0ea 8px 16px)'; $('fCap').innerHTML = '<b>Pick a color</b>Tap a color above, or set a custom one.'; return; }
  $('fBig').style.background = p.color;
  const phys = physicalPalette();
  let near = null, nd = 1e9; const L = C.hexToLab(p.color);
  for (const q of phys) { const M = C.hexToLab(q.color); const d = Math.hypot(L[0] - M[0], L[1] - M[1], L[2] - M[2]); if (d < nd) { nd = d; near = q; } }
  const cap = $('fCap'); cap.innerHTML = '<b></b>';
  cap.firstChild.textContent = p.name + ' · ' + p.color;
  cap.insertAdjacentText('beforeend', near && nd < 8 ? 'Very close to your ' + label(near) + ' (slot ' + near.slot + '). ' : '');
  cap.insertAdjacentText('beforeend', 'It copies the print settings of filament 1; pick the right filament preset for it in Bambu Studio.');
  if (phys.length >= 32) { $('fAdd').disabled = true; cap.insertAdjacentText('beforeend', ' Bambu Studio allows at most 32 filaments.'); }
}
$('fSearch').oninput = renderFilGrid;
$('fColor').oninput = () => { filPick = { name: $('fName').value.trim() || ('Custom ' + C.colorName($('fColor').value)), color: $('fColor').value.toUpperCase() }; renderFilGrid(); updateFilPick(); };
$('fName').oninput = () => { if (filPick && !catalogEntries().some(e => filPick.name.endsWith(e.line + ' ' + e.name))) { filPick.name = $('fName').value.trim() || ('Custom ' + C.colorName(filPick.color)); updateFilPick(); } };
$('bAddFil').onclick = openAddFilament;
$('fCancel').onclick = () => $('filSheet').classList.remove('open');
$('filSheet').addEventListener('click', e => { if (e.target.id === 'filSheet') $('filSheet').classList.remove('open'); });
$('fAdd').onclick = () => {
  if (!filPick) return;
  const settings = JSON.parse(S.template['Metadata/project_settings.config']);
  const firstPhys = physicalPalette()[0];
  const r = C.addPhysical(settings, filPick.color, firstPhys ? firstPhys.slot : 1);
  const ins = r.slot;
  remapSlots(v => v >= ins ? v + 1 : v);
  if (S.slot >= ins) S.slot++;
  names[filPick.color] = filPick.name; store('labcraft.names', names);
  commitSettings(r.settings);
  S.slot = ins; renderPalette(); status(); recolorAll();
  $('filSheet').classList.remove('open');
  toast('Added ' + filPick.name + ' as filament ' + ins + (S.palette.some(p => p.mixed) ? '. Your mixes moved down one slot.' : '.'), 4500);
};
let physEdit = null;
function openPhysEditor(p) {
  physEdit = p;
  $('physTitle').textContent = 'Filament ' + p.slot;
  $('physName').value = label(p);
  const usedPaint = S.mesh && S.mesh.paint.includes(p.slot);
  const usedMix = S.palette.filter(q => q.mixed && q.components.includes(p.slot));
  $('physNote').textContent = p.color + (usedMix.length ? ' · used in ' + usedMix.length + ' mix' + (usedMix.length > 1 ? 'es' : '') : '') + (usedPaint ? ' · painted on the model' : '');
  $('physRemove').disabled = !!(usedPaint || usedMix.length || physicalPalette().length <= 1);
  $('physRemove').title = $('physRemove').disabled ? 'Only filaments not painted on the model and not used in a mix can be removed' : '';
  $('physSheet').classList.add('open');
}
$('physCancel').onclick = () => $('physSheet').classList.remove('open');
$('physSheet').addEventListener('click', e => { if (e.target.id === 'physSheet') $('physSheet').classList.remove('open'); });
$('physSave').onclick = () => {
  const v = $('physName').value.trim(), k = nameKey(physEdit);
  if (!v || v === physEdit.name) delete names[k]; else names[k] = v;
  store('labcraft.names', names); $('physSheet').classList.remove('open'); renderPalette(); status();
};
$('physRemove').onclick = () => {
  const slot = physEdit.slot;
  remapSlots(v => v === slot ? 1 : v > slot ? v - 1 : v);
  if (S.slot === slot) S.slot = 1; else if (S.slot > slot) S.slot--;
  commitSettings(C.deleteSlot(JSON.parse(S.template['Metadata/project_settings.config']), slot));
  $('physSheet').classList.remove('open'); recolorAll();
  toast('Filament removed.');
};

// ---------------- three.js scene ----------------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(document.documentElement.dataset.theme === 'dark' ? '#2a2b2f' : '#e8e5df');
function setTheme(dark) {
  if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
  scene.background.set(dark ? '#2a2b2f' : '#e8e5df');
  const b = document.getElementById('bThemeBtn'); if (b) { b.setAttribute('aria-checked', dark ? 'true' : 'false'); b.title = dark ? 'Switch to day mode' : 'Switch to night mode'; }
  store('labcraft.theme', dark ? 'dark' : 'light');
  try { needRender = true; } catch (e) {}
  try { if (plate) { plate.material.color.set(dark ? 0x45464c : 0xffffff); plate.material.vertexColors = !dark; plate.material.needsUpdate = true; } } catch (e) {}
}
document.getElementById('bThemeBtn').onclick = () => setTheme(document.documentElement.dataset.theme !== 'dark');
setTheme(document.documentElement.dataset.theme === 'dark');
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
camera.up.set(0, 0, 1);
camera.position.set(120, -160, 110);
const orbit = new OrbitControls(camera, renderer.domElement);
let controls = orbit;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.addEventListener('change', () => { needRender = true; });
controls.enableDamping = true; controls.dampingFactor = 0.14;   // a little glide when you let go
controls.zoomToCursor = true;                                     // pinch zooms toward your fingers
controls.rotateSpeed = 0.8; controls.zoomSpeed = 1.1;
const track = new TrackballControls(camera, renderer.domElement);
track.enabled = false; track.rotateSpeed = 2.4; track.zoomSpeed = 1.2; track.panSpeed = 0.9;
track.staticMoving = false; track.dynamicDampingFactor = 0.16;
track.addEventListener('change', () => { needRender = true; });
function setFree(on) {
  const to = on ? track : orbit;
  if (to === controls) return;
  to.target.copy(controls.target);
  controls.enabled = false;
  if (!on) camera.up.set(0, 0, 1);   // turntable keeps the model upright
  to.enabled = true; controls = to;
  if (on) track.handleResize();
  controls.update(); needRender = true;
}
scene.add(new THREE.HemisphereLight(0xffffff, 0xc4bfb5, 2.4));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(0.6, -1, 1.4);
camera.add(key); scene.add(camera);
const plate = new THREE.GridHelper(260, 26, 0xb9b4aa, 0xd3cfc7); plate.rotation.x = Math.PI / 2; scene.add(plate);
setTheme(document.documentElement.dataset.theme === 'dark');

const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48), new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: .75, depthTest: false, side: THREE.DoubleSide }));
ring.renderOrder = 10; ring.visible = false; scene.add(ring);

const lineMat = new LineMaterial({ color: 0x15171a, linewidth: 2.6, worldUnits: false });
const liveMat = new LineMaterial({ color: 0x1f6f6b, linewidth: 3.2, worldUnits: false });
const lineGroup = new THREE.Group(); scene.add(lineGroup);
let liveLine = null;

let model = null, colorAttr = null, shadeAttr = null, shadeFor = null;
const cavUniform = { value: 0 };
// ---- view aids: hollow shading and crease lines (drawn on top; paint colours stay exact) ----
const creaseMat = new LineMaterial({ color: 0x2a2c30, linewidth: 1.1, worldUnits: false, transparent: true, opacity: 0.55 });
let creaseLines = null;
function updateViewAids() {
  const m = S.mesh; if (!m) return;
  cavUniform.value = S.cavity ? 1 : 0;
  if (S.cavity && shadeFor !== m.tris) {
    const sh = C.cavityShade(m.adj, m.normals, m.cent, m.nT, 3), a = shadeAttr.array;
    for (let t = 0; t < m.nT; t++) a[t * 3] = a[t * 3 + 1] = a[t * 3 + 2] = Math.round(Math.min(1, sh[t] / 1.25) * 255);
    shadeAttr.needsUpdate = true; shadeFor = m.tris;
  }
  const want = S.creases;
  if (creaseLines && (!want || creaseLines.userData.tris !== m.tris)) { scene.remove(creaseLines); creaseLines.geometry.dispose(); creaseLines = null; }
  if (want && !creaseLines) {
    let ang = 30, ed = C.creaseEdges(m.tris, m.adj, m.normals, ang);
    while (ed.length / 3 > 300000 && ang < 70) { ang += 10; ed = C.creaseEdges(m.tris, m.adj, m.normals, ang); }
    const pos = new Float32Array(ed.length / 3 * 6), L = Math.max(0.01, S.diag / 4000);
    for (let i = 0; i < ed.length; i += 3) {
      const t = ed[i], e = ed[i + 1], n = ed[i + 2];
      const a = m.tris[t * 3 + e] * 3, b = m.tris[t * 3 + (e + 1) % 3] * 3;
      const nx = (m.normals[t * 3] + m.normals[n * 3]) * L, ny = (m.normals[t * 3 + 1] + m.normals[n * 3 + 1]) * L, nz = (m.normals[t * 3 + 2] + m.normals[n * 3 + 2]) * L;
      const o = i / 3 * 6;
      pos[o] = m.verts[a] + nx; pos[o + 1] = m.verts[a + 1] + ny; pos[o + 2] = m.verts[a + 2] + nz;
      pos[o + 3] = m.verts[b] + nx; pos[o + 4] = m.verts[b + 1] + ny; pos[o + 5] = m.verts[b + 2] + nz;
    }
    const g = new LineSegmentsGeometry(); g.setPositions(pos);
    creaseMat.resolution.set(view.clientWidth, view.clientHeight);
    creaseLines = new LineSegments2(g, creaseMat); creaseLines.renderOrder = 3; creaseLines.userData.tris = m.tris;
    scene.add(creaseLines);
  }
  updateSymPlane();
  needRender = true;
}
// ---- symmetry ----
let symPlane = null;
// Place the mirror: one tap puts it through that point; a second tap on the matching spot
// (the other eye, the other hand) puts it exactly halfway between the two.
function setMirrorFromTap(p) {
  const ax = S.sym === 'y' ? 'y' : 'x', tol = S.diag * 0.01;
  const taps = S.symTaps;
  if (taps.length === 1 && Math.abs(p[ax] - taps[0][ax]) > tol) {
    const mid = (p[ax] + taps[0][ax]) / 2;
    S.symCtr = S.home.ctr.clone(); S.symCtr[ax] = mid; S.symTaps = [];
    toast('Mirror set halfway between your two taps. Tap Done when it looks right.', 4000);
  } else {
    S.symCtr = S.home.ctr.clone(); S.symCtr[ax] = p[ax]; S.symTaps = [p.clone()];
    toast('Mirror goes through that spot. For a more exact plane, also tap the matching spot on the other side.', 4500);
  }
  updateSymPlane();
}
function setSymSetting(on) {
  S.symSetting = on; S.symTaps = [];
  if (on && S.sym === 'off') pickSym('x');
  $('bSymSet').classList.toggle('on', on); $('bSymSet').textContent = on ? 'Done' : 'Place mirror';
  $('bSymCenter').style.display = S.sym !== 'off' ? '' : 'none';
  updateSymPlane();
  if (on) toast('Tap the model where the mirror should go, or tap two matching spots (like both eyes) to put it halfway between them.', 6000);
}
function updateSymPlane() {
  const show = S.sym !== 'off' && S.home && ['brush', 'outline', 'select'].includes(S.tool);
  if (!show) { if (symPlane) symPlane.visible = false; return; }
  if (!symPlane) {
    symPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x2f6bff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    symPlane.renderOrder = 6; scene.add(symPlane);
  }
  const { ctr, r } = S.home;
  const c = symCenter();
  symPlane.visible = true; symPlane.position.set(S.sym === 'x' ? c.x : ctr.x, S.sym === 'y' ? c.y : ctr.y, ctr.z); symPlane.scale.setScalar(r * 1.3);
  symPlane.material.opacity = S.symSetting ? 0.18 : 0.08;
  symPlane.rotation.set(0, 0, 0);
  if (S.sym === 'x') symPlane.rotation.y = Math.PI / 2; else symPlane.rotation.x = Math.PI / 2;
  needRender = true;
}
const _v = new THREE.Vector3();
// Nearest point on the model's surface (with its triangle).
function surfaceHit(x, y, z) {
  const r = model.geometry.boundsTree.closestPointToPoint(_v.set(x, y, z), {});
  if (!r) return null;
  const t = r.faceIndex, m = S.mesh;
  return { t, x: r.point.x, y: r.point.y, z: r.point.z, nx: m.normals[t * 3], ny: m.normals[t * 3 + 1], nz: m.normals[t * 3 + 2], d: r.distance };
}
function symCenter() { return S.symCtr || S.home.ctr; }
function mirrorPoint(x, y, z) {
  const c = symCenter();
  return S.sym === 'x' ? [2 * c.x - x, y, z] : [x, 2 * c.y - y, z];
}
// Mirror a stroke onto the other side; null if the model isn't symmetric enough there.
function mirrorPoly(poly) {
  const out = []; let miss = 0;
  for (const p of poly) {
    const q = mirrorPoint(p[0], p[1], p[2]), h = surfaceHit(q[0], q[1], q[2]);
    if (!h || h.d > S.diag * 0.03) { miss++; continue; }
    out.push([h.x, h.y, h.z]);
  }
  return miss > poly.length * 0.25 || out.length < 2 ? null : out;
}
let needRender = true;
function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  lineMat.resolution.set(w, h); liveMat.resolution.set(w, h); try { partLineMat.resolution.set(w, h); creaseMat.resolution.set(w, h); selLineMat.resolution.set(w, h); antBase.resolution.set(w, h); antDash.resolution.set(w, h); } catch (_) { /* defined further down */ }
  try { track.handleResize(); } catch (_) {}
  needRender = true;
}
window.addEventListener('resize', resize); resize();
// The filament panel scrolls, which would clip a button hanging over its corner, so the
// collapse button is pinned in place over the panel's corner instead.
function placePaletteBtn() {
  const pal = document.getElementById('palette'), btn = document.getElementById('paletteMin');
  if (!pal || !btn) return;
  const r = pal.getBoundingClientRect(), narrow = window.matchMedia('(max-width: 900px)').matches;
  btn.style.left = (narrow ? r.right - 20 : r.left - 11) + 'px';
  btn.style.top = (narrow ? r.top + r.height / 2 - 16 : r.top - 11) + 'px';
}
window.addEventListener('resize', placePaletteBtn);
try { new ResizeObserver(placePaletteBtn).observe(document.getElementById('palette')); } catch (_) {}
setTimeout(placePaletteBtn, 0);
let dMin = Infinity, dMax = -1;
(function loop() {
  requestAnimationFrame(loop);
  if (colorAttr && dMax >= dMin) {
    colorAttr.clearUpdateRanges();
    colorAttr.addUpdateRange(dMin * 9, (dMax - dMin + 1) * 9);
    colorAttr.needsUpdate = true;
    dMin = Infinity; dMax = -1; needRender = true;
  }
  if (controls.update()) needRender = true;
  try { animateAnts(performance.now()); } catch (_) {}
  try { if (cube) { cube.step(performance.now()); cube.draw(); } } catch (_) {}
  if (needRender) { needRender = false; renderer.render(scene, camera); }
})();

function renderLines() {
  for (const c of lineGroup.children.slice()) { c.geometry.dispose(); lineGroup.remove(c); }
  for (const pts of S.lines) {
    if (pts.length < 6) continue;
    const g = new LineGeometry(); g.setPositions(pts);
    const l = new Line2(g, lineMat); l.computeLineDistances(); lineGroup.add(l);
  }
  $('bClearLines').disabled = !S.lines.length; $('bClearLines').style.display = S.lines.length ? '' : 'none';
  needRender = true;
}
function setLiveLine(pts) {
  if (liveLine) { liveLine.geometry.dispose(); scene.remove(liveLine); liveLine = null; }
  if (pts && pts.length >= 6) {
    const g = new LineGeometry(); g.setPositions(pts);
    liveLine = new Line2(g, liveMat); liveLine.renderOrder = 5; scene.add(liveLine);
  }
  needRender = true;
}

// ---------------- mesh ----------------
// Rebuild render + topology for (possibly new) geometry. Keeps camera and undo.
function rebuild(verts, tris, paint, wall, part) {
  const nT = tris.length / 3;
  const adj = C.adjacency(tris, verts.length / 3);
  const fd = C.faceData(verts, tris);
  S.mesh = { verts, tris, paint, wall, part: part || null, adj, normals: fd.normals, cent: fd.cent, area: fd.area, nT, mark: new Uint32Array(nT), stamp: 1 };
  partBuckets = null;
  if (S.sel && S.sel.mask.length !== nT) S.sel = null;
  if (model) { scene.remove(model); model.geometry.disposeBoundsTree(); model.geometry.dispose(); }
  const pos = new Float32Array(nT * 9);
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
    const v = tris[t * 3 + k] * 3;
    pos[t * 9 + k * 3] = verts[v]; pos[t * 9 + k * 3 + 1] = verts[v + 1]; pos[t * 9 + k * 3 + 2] = verts[v + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  colorAttr = new THREE.BufferAttribute(new Uint8Array(nT * 9), 3, true);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('color', colorAttr);
  shadeAttr = new THREE.BufferAttribute(new Uint8Array(nT * 3).fill(204), 1, true); // 204/255*1.25 = 1.0
  g.setAttribute('shade', shadeAttr); shadeFor = null;
  g.computeVertexNormals();
  g.computeBoundsTree({ indirect: true });
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .75, metalness: 0, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uCav = cavUniform;
    sh.vertexShader = 'attribute float shade;\nvarying float vShade;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = shade;');
    sh.fragmentShader = 'uniform float uCav;\nvarying float vShade;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(1.0, vShade * 1.25, uCav);');
  };
  model = new THREE.Mesh(g, mat);
  scene.add(model);
  preview = null;
  recolorAll(); status(); needRender = true;
  try { updatePartLines(); } catch (_) {}
  try { updateViewAids(); } catch (_) {}
}
// Frame the whole model (also the Fit view button).
function fitView() {
  if (!S.home) return;
  const { ctr, r } = S.home;
  camera.up.set(0, 0, 1);
  if (controls === track) { // stop any leftover spin before re-framing
    track.staticMoving = true; track.update(); track.staticMoving = false;
    track._lastAngle = 0; try { track._moveDirection.set(0, 0, 0); track._zoomStart.copy(track._zoomEnd); track._panStart.copy(track._panEnd); } catch (_) {}
  }
  controls.target.copy(ctr);
  const dir = new THREE.Vector3(1.1, -1.6, 1.0).normalize();
  const fit = (r * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.min(1, camera.aspect);
  camera.position.copy(ctr).addScaledVector(dir, fit * 1.25);
  camera.near = r / 400; camera.far = r * 100; camera.updateProjectionMatrix();
  controls.update(); camera.up.set(0, 0, 1); camera.lookAt(ctr); needRender = true;
}

// ---- View cube: tap a face to look straight at it, a corner for an angled view, drag to turn.
const cube = (() => {
  const cv = document.getElementById('viewCube'); if (!cv) return null;
  const ctx = cv.getContext('2d');
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // Bambu's front is -Y, Z is up.
  const faces = [
    { name: 'FRONT', n: V(0, -1, 0), u: V(1, 0, 0), v: V(0, 0, 1) },
    { name: 'BACK', n: V(0, 1, 0), u: V(-1, 0, 0), v: V(0, 0, 1) },
    { name: 'RIGHT', n: V(1, 0, 0), u: V(0, 1, 0), v: V(0, 0, 1) },
    { name: 'LEFT', n: V(-1, 0, 0), u: V(0, -1, 0), v: V(0, 0, 1) },
    { name: 'TOP', n: V(0, 0, 1), u: V(1, 0, 0), v: V(0, 1, 0) },
    { name: 'BOTTOM', n: V(0, 0, -1), u: V(1, 0, 0), v: V(0, -1, 0) },
  ];
  const corners = []; for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push(V(x, y, z));
  const right = V(), up = V(), fwd = V();
  let hover = null, lastKey = '', anim = null, drag = null;
  const size = () => cv.clientWidth || 112;
  function axes() {
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    fwd.set(0, 0, 1).applyQuaternion(camera.quaternion); // points from the model toward the camera
  }
  function proj(w, sc, c) { return [c + w.dot(right) * sc, c - w.dot(up) * sc]; }
  function draw(force) {
    const key = camera.quaternion.toArray().map(v => v.toFixed(4)).join() + (hover ? hover.kind + hover.i : '') + (document.documentElement.dataset.theme || '');
    if (!force && key === lastKey) return; lastKey = key;
    const W = size(), dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (cv.width !== Math.round(W * dpr)) { cv.width = cv.height = Math.round(W * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, W);
    axes();
    const cs = getComputedStyle(document.documentElement);
    const panel = cs.getPropertyValue('--panel').trim(), line = cs.getPropertyValue('--line').trim(), ink = cs.getPropertyValue('--ink').trim(), muted = cs.getPropertyValue('--muted').trim(), accent = cs.getPropertyValue('--accent').trim(), sel = cs.getPropertyValue('--sel').trim();
    const c = W / 2, sc = W * 0.26;
    const vis = faces.map((f, i) => ({ f, i, d: f.n.dot(fwd) })).filter(o => o.d > 0.001).sort((a, b) => a.d - b.d);
    for (const { f, i, d } of vis) {
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => proj(f.n.clone().addScaledVector(f.u, a).addScaledVector(f.v, b), sc, c));
      ctx.beginPath(); pts.forEach((p, k) => k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.fillStyle = hover && hover.kind === 'f' && hover.i === i ? sel : panel; ctx.fill();
      ctx.globalAlpha = 0.18 * (1 - d); ctx.fillStyle = '#000'; ctx.fill(); ctx.globalAlpha = 1; // a little shading so the cube reads as 3D
      ctx.lineWidth = 1.2; ctx.strokeStyle = hover && hover.kind === 'f' && hover.i === i ? accent : line; ctx.stroke();
      if (d > 0.22) { // label, drawn on the face itself
        const o = proj(f.n, sc, c), pu = proj(f.n.clone().add(f.u), sc, c), pv = proj(f.n.clone().add(f.v), sc, c);
        const ux = (pu[0] - o[0]) / sc, uy = (pu[1] - o[1]) / sc, vx = (pv[0] - o[0]) / sc, vy = (pv[1] - o[1]) / sc;
        ctx.save(); ctx.setTransform(dpr * ux * sc, dpr * uy * sc, -dpr * vx * sc, -dpr * vy * sc, dpr * o[0], dpr * o[1]);
        ctx.font = '700 ' + (f.name.length > 5 ? 0.3 : 0.36) + 'px -apple-system,BlinkMacSystemFont,sans-serif';
        ctx.fillStyle = d > 0.5 ? ink : muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(f.name, 0, 0.02); ctx.restore();
      }
    }
    arrows(sc, c).forEach(a => {
      const h = hover && hover.kind === 'a' && hover.i === a.to;
      ctx.save(); ctx.translate(a.p[0], a.p[1]); ctx.rotate(a.ang);
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -6.5); ctx.lineTo(-4, 6.5); ctx.closePath();
      ctx.fillStyle = h ? accent : muted; ctx.globalAlpha = h ? 1 : 0.7; ctx.fill(); ctx.restore(); ctx.globalAlpha = 1;
    });
    // corner dots for angled views
    for (let i = 0; i < 8; i++) {
      const w = corners[i]; if (w.clone().normalize().dot(fwd) < 0.15) continue;
      const p = proj(w, sc, c), h = hover && hover.kind === 'c' && hover.i === i;
      ctx.beginPath(); ctx.arc(p[0], p[1], h ? 5 : 3.2, 0, Math.PI * 2); ctx.fillStyle = h ? accent : muted; ctx.globalAlpha = h ? 1 : 0.55; ctx.fill(); ctx.globalAlpha = 1;
    }
  }
  // When looking straight at a face, arrows on its edges turn to the neighbouring faces.
  function arrows(sc, c) {
    const fr = faces.findIndex(f => f.n.dot(fwd) > 0.995); if (fr < 0) return [];
    const f = faces[fr], out = [];
    for (const dir of [f.u, f.u.clone().negate(), f.v, f.v.clone().negate()]) {
      const to = faces.findIndex(g => g.n.distanceTo(dir) < 1e-6);
      const p = proj(f.n.clone().addScaledVector(dir, 1.5), sc, c), q = proj(f.n.clone().addScaledVector(dir, 2), sc, c);
      out.push({ to, p, ang: Math.atan2(q[1] - p[1], q[0] - p[0]) });
    }
    return out;
  }
  function hit(x, y) {
    axes(); const W = size(), c = W / 2, sc = W * 0.26;
    for (const a of arrows(sc, c)) if (Math.hypot(a.p[0] - x, a.p[1] - y) < 13) return { kind: 'a', i: a.to };
    let best = null, bd = 9;
    for (let i = 0; i < 8; i++) { const w = corners[i]; if (w.clone().normalize().dot(fwd) < 0.15) continue; const p = proj(w, sc, c), d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = { kind: 'c', i }; } }
    if (best) return best;
    let top = null, td = 0;
    faces.forEach((f, i) => {
      const d = f.n.dot(fwd); if (d <= 0.001) return;
      const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => proj(f.n.clone().addScaledVector(f.u, a).addScaledVector(f.v, b), sc, c));
      let inside = false; for (let a = 0, b = 3; a < 4; b = a++) { const [xa, ya] = pts[a], [xb, yb] = pts[b]; if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) inside = !inside; }
      if (inside && d > td) { td = d; top = { kind: 'f', i }; }
    });
    return top;
  }
  // Turn the camera to look from `dir` (pointing from the model to the camera).
  function goTo(dir, upv) {
    const t = controls.target, dist = camera.position.distanceTo(t);
    const d0 = camera.position.clone().sub(t).normalize(), d1 = dir.clone().normalize();
    if (controls === orbit && Math.abs(d1.z) > 0.9999) d1.set(0, -0.0015, Math.sign(d1.z)).normalize(); // turntable can't sit exactly on the pole
    const q = new THREE.Quaternion().setFromUnitVectors(d0, d1);
    if (d0.dot(d1) < -0.9999) q.setFromAxisAngle(Math.abs(d0.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0), Math.PI);
    const u0 = camera.up.clone(), u1 = (upv || V(0, 0, 1)).clone();
    anim = { t0: performance.now(), d0, q, dist, u0, u1, damp: orbit.enableDamping };
    orbit.enableDamping = false; controls.update();
  }
  function step(now) {
    if (!anim) return;
    let k = Math.min(1, (now - anim.t0) / 380); const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const q = new THREE.Quaternion().slerp(anim.q, e);
    camera.position.copy(controls.target).addScaledVector(anim.d0.clone().applyQuaternion(q), anim.dist);
    if (controls !== orbit) camera.up.copy(anim.u0).lerp(anim.u1, e).normalize();
    camera.lookAt(controls.target); controls.update(); needRender = true;
    if (k >= 1) { orbit.enableDamping = anim.damp; anim = null; }
  }
  function snapFace(i) {
    const f = faces[i];
    const upv = f.name === 'TOP' ? V(0, 1, 0) : f.name === 'BOTTOM' ? V(0, -1, 0) : V(0, 0, 1);
    goTo(f.n, upv);
  }
  function rotateBy(dx, dy) {
    const t = controls.target, off = camera.position.clone().sub(t);
    if (controls === orbit) {
      off.applyAxisAngle(V(0, 0, 1), -dx * 0.012);
      const rgt = V(1, 0, 0).applyQuaternion(camera.quaternion);
      const o2 = off.clone().applyAxisAngle(rgt, -dy * 0.012);
      const el = Math.asin(o2.clone().normalize().z);
      if (Math.abs(el) < Math.PI / 2 - 0.01) off.copy(o2);
    } else {
      axes();
      const q = new THREE.Quaternion().setFromAxisAngle(up, -dx * 0.012).multiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.012));
      off.applyQuaternion(q); camera.up.applyQuaternion(q);
    }
    camera.position.copy(t).add(off); camera.lookAt(t); controls.update(); needRender = true;
  }
  const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  cv.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation(); cv.setPointerCapture(e.pointerId);
    const [x, y] = local(e); drag = { x, y, x0: x, y0: y, moved: false, damp: orbit.enableDamping };
    orbit.enableDamping = false; controls.update(); anim = null;
  });
  cv.addEventListener('pointermove', e => {
    const [x, y] = local(e);
    if (drag) {
      if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) > 5) drag.moved = true;
      if (drag.moved) { rotateBy(x - drag.x, y - drag.y); hover = null; }
      drag.x = x; drag.y = y;
    } else if (e.pointerType === 'mouse') { hover = hit(x, y); draw(); }
  });
  const end = e => {
    if (!drag) return;
    const d = drag; drag = null; orbit.enableDamping = d.damp;
    if (!d.moved && e.type === 'pointerup') {
      const h = hit(d.x0, d.y0);
      if (h && (h.kind === 'f' || h.kind === 'a')) snapFace(h.i);
      else if (h && h.kind === 'c') goTo(corners[h.i], V(0, 0, 1));
    }
  };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => { if (hover) { hover = null; draw(); } });
  return { draw, step, snapFace, goTo };
})();
/**
 * Load a new model: clears undo, outlines, selection and symmetry, builds topology and frames the view.
 * @param {Float32Array} verts
 * @param {Uint32Array} tris
 * @param {Uint8Array} paint 1-based slots per triangle.
 */
function setMesh(verts, tris, paint) {
  S.undo = []; S.redo = []; S.segs = []; S.lines = []; S.parts = null; S.sel = null; closeSel();
  S.symCtr = null; S.symTaps = []; try { if (S.symSetting) setSymSetting(false); } catch (_) {}
  try { if (partLines) partLines.visible = false; } catch (_) {}
  rebuild(verts, tris, paint, new Int32Array(tris.length / 3).fill(-1), null);
  renderLines(); updateUndo();
  const g = model.geometry;
  g.computeBoundingBox();
  const bb = g.boundingBox, size = new THREE.Vector3(), ctr = new THREE.Vector3();
  bb.getSize(size); bb.getCenter(ctr);
  plate.position.set(ctr.x, ctr.y, bb.min.z);
  const r = Math.max(size.x, size.y, size.z);
  S.diag = r;
  S.home = { ctr: ctr.clone(), r };
  fitView();
  S.size = Math.max(0.4, Math.min(30, +(r / 25).toFixed(1)));
  $('size').max = Math.max(30, Math.round(r / 2)); $('size').value = S.size; $('sizeVal').textContent = S.size + ' mm';
  $('empty').style.display = 'none';
  for (const id of ['bCheck', 'bExport', 'bFillAll', 'bRefine', 'bSmoothAll']) $(id).disabled = false;
  { // default grow/shrink step: about one and a half triangle widths, at least 0.3 mm
    const m = S.mesh, n = Math.min(m.nT, 2000), sizes = [];
    for (let i = 0; i < n; i++) sizes.push(Math.sqrt(m.area[Math.floor(i * m.nT / n)] * 2));
    sizes.sort((a, b) => a - b);
    S.step = +Math.max(0.3, Math.min(10, sizes[n >> 1] * 1.5)).toFixed(1);
    $('step').value = S.step; $('stepVal').textContent = S.step + ' mm';
  }
  if (S.tool === 'parts') ensureParts();
  renderPalette(); status();
}
function triColor(t, rgb) {
  const a = colorAttr.array, o = t * 9;
  a[o] = a[o + 3] = a[o + 6] = rgb[0]; a[o + 1] = a[o + 4] = a[o + 7] = rgb[1]; a[o + 2] = a[o + 5] = a[o + 8] = rgb[2];
  if (t < dMin) dMin = t; if (t > dMax) dMax = t;
}
const SEL_RGB = [70, 110, 255];
// Outside the Select tool a selection works as a mask (Brush, Fill and Image only paint inside it).
const selLineMat = new LineMaterial({ color: 0x2f6bff, linewidth: 2.2, worldUnits: false, transparent: true, opacity: 0.95, depthTest: true });
let selLines = null;
// The selection is shown as a solid blue outline (selLineMat) along its edge, in every tool, with no
// tint, so the real colors underneath stay visible. antBase/antDash below are left from the
// marching-ants version: nothing draws them now, so animateAnts() always returns early.
const antBase = new LineMaterial({ color: 0xffffff, linewidth: 3.4, worldUnits: false });
const antDash = new LineMaterial({ color: 0x111111, linewidth: 2.2, worldUnits: false, dashed: true, dashSize: 1, gapSize: 1, dashScale: 1 });
let antsBase = null, antsDash = null, antsLast = 0;
function updateSelOutline() {
  for (const l of [antsBase, antsDash]) if (l) { scene.remove(l); l.geometry.dispose(); }
  antsBase = antsDash = null; selLines = null;
  const m = S.mesh, s = S.sel;
  if (!m || !s) { needRender = true; return; }
  const L = lift() * 1.5;
  // boundary edges, directed along their triangle, chained into loops so the dashes run continuously
  const next = new Map(); // start vertex -> [{b, t}]
  for (const t of s.list) for (let e = 0; e < 3; e++) {
    const n = m.adj[t * 3 + e]; if (n >= 0 && s.mask[n]) continue;
    const a = m.tris[t * 3 + e], b = m.tris[t * 3 + (e + 1) % 3];
    if (!next.has(a)) next.set(a, []); next.get(a).push({ b, t, used: false });
  }
  const pos = [];
  const push = (a, b, t) => { const nx = m.normals[t * 3] * L, ny = m.normals[t * 3 + 1] * L, nz = m.normals[t * 3 + 2] * L;
    pos.push(m.verts[a * 3] + nx, m.verts[a * 3 + 1] + ny, m.verts[a * 3 + 2] + nz, m.verts[b * 3] + nx, m.verts[b * 3 + 1] + ny, m.verts[b * 3 + 2] + nz); };
  for (const [a0, list] of next) for (const e0 of list) {
    if (e0.used) continue;
    let a = a0, e = e0;
    while (e && !e.used) { e.used = true; push(a, e.b, e.t); a = e.b; const nl = next.get(a); e = nl ? nl.find(x => !x.used) : null; }
  }
  if (pos.length) {
    // a solid blue outline (Sarah preferred it to marching ants)
    const g1 = new LineSegmentsGeometry(); g1.setPositions(pos);
    selLineMat.resolution.set(view.clientWidth, view.clientHeight);
    antsBase = new LineSegments2(g1, selLineMat); antsBase.renderOrder = 7; scene.add(antsBase);
    selLines = antsBase;
  }
  needRender = true;
}
// keep dashes about the same size on screen at any zoom, and let them march
function animateAnts(now) {
  if (!antsDash) return;
  if (now - antsLast < 60) return;
  antsLast = now;
  const d = camera.position.distanceTo(controls.target), px = d * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / view.clientHeight; // world size of a pixel
  antDash.dashSize = antDash.gapSize = 6 * px;
  antDash.dashOffset = -((now / 1000) * 20 * px) % (12 * px);
  needRender = true;
}
const inSel = t => !S.sel || S.tool === 'select' || S.sel.mask[t];
function mixRGB(a, b, f) { return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; }
const partRGBs = [];
function partRGB(L) {
  if (!partRGBs[L]) { const c = new THREE.Color().setHSL((L * 0.618034) % 1, 0.75, 0.55); partRGBs[L] = [c.r * 255, c.g * 255, c.b * 255]; }
  return partRGBs[L];
}
function paintColor(t) {
  const m = S.mesh, sl = m.paint[t];
  let c = palLinear[sl] || palLinear[0];
  const g = gradView[sl];
  if (g) { const z = m.cent[t * 3 + 2], u = g.z1 > g.z0 ? Math.min(1, Math.max(0, (z - g.z0) / (g.z1 - g.z0))) : 0.5, r1 = g.a + (g.b - g.a) * u; c = mixRGB(g.B, g.A, r1); }
  return c; // colours always show as painted; parts are drawn as outlines instead
}
function recolorAll() { if (!S.mesh) return; updateGradView(); for (let t = 0; t < S.mesh.nT; t++) triColor(t, paintColor(t)); }

// Native Bambu gradients blend from one filament to the other over the height of the painted area.
let gradView = {};
function updateGradView() {
  gradView = {};
  const m = S.mesh; if (!m) return;
  const gs = S.palette.filter(p => p.gradient && p.components && p.components.length === 2);
  if (!gs.length) return;
  for (const p of gs) {
    const [a, b] = String(p.gradRange || '0.9,0.1').split(',').map(Number);
    gradView[p.slot] = { a: isFinite(a) ? a : 0.9, b: isFinite(b) ? b : 0.1, A: palLinear[p.components[0]] || palLinear[0], B: palLinear[p.components[1]] || palLinear[0], z0: 1e9, z1: -1e9 };
  }
  for (let t = 0; t < m.nT; t++) { const g = gradView[m.paint[t]]; if (g) { const z = m.cent[t * 3 + 2]; if (z < g.z0) g.z0 = z; if (z > g.z1) g.z1 = z; } }
}

// ---------------- shading: soft brush and gradients ----------------
// A printed triangle is one filament or one mix, so shading uses a ramp of mixes between the
// area's color and the shade color (for 4 steps: 25, 50, 75%), with the steps dithered so they blend.
const ramps = new Map();   // 'base>shade>steps' -> [slot of step 0 .. steps]
const rampOf = new Map();  // mix slot -> { b, s, n, k }
function recipeOf(slot) {  // { physical slot: share }
  const p = S.palette[slot - 1]; if (!p) return null;
  if (!p.mixed) return { [slot]: 1 };
  if (p.gradient || !p.components || !p.components.length) return null;
  const r = {}, w = p.components.map((c, i) => isFinite(p.ratios[i]) ? p.ratios[i] : 1), sum = w.reduce((a, b) => a + b, 0) || 1;
  p.components.forEach((c, i) => { r[c] = (r[c] || 0) + w[i] / sum; });
  return r;
}
function pctOf(ws) {
  const sum = ws.reduce((a, b) => a + b, 0) || 1, pc = ws.map(w => Math.round(100 * w / sum));
  pc[pc.indexOf(Math.max(...pc))] += 100 - pc.reduce((a, b) => a + b, 0);
  return pc;
}
function findSlotFor(rec) {
  const keys = Object.keys(rec).filter(k => rec[k] > 0.004);
  if (keys.length === 1) return +keys[0];
  for (const p of S.palette) {
    if (!p.mixed || p.gradient) continue;
    const r = recipeOf(p.slot); if (!r || Object.keys(r).length !== keys.length) continue;
    if (keys.every(k => r[k] != null && Math.abs(r[k] - rec[k]) < 0.011)) return p.slot;
  }
  return 0;
}
function recipeColor(comps, pc) {
  const hexes = comps.map(c => S.palette[c - 1].color), k = recipeKey(comps, pc, S.palette);
  if (isTC()) return LabMix.formula(hexes, pc);
  return learned[k] || LabMix.measured(hexes, pc) || LabMix.blend(hexes, pc);
}
function mixCount() { return S.palette.filter(p => p.mixed).length; }
/**
 * Add mixes to the project in one settings commit (one palette rebuild).
 * Bambu Studio allows at most 64 mixes; over that the user is told and nothing is added.
 * @param {Array<{comps: number[], pc: number[], color?: string, gradient?: string}>} recs
 *   comps: 1-based physical slots; pc: percentages; gradient: Bambu native gradient range, e.g. '0.95,0.05'.
 * @returns {?number[]} The new 1-based slots in order, or null when over the limit.
 */
function addMixes(recs) {
  if (!recs.length) return [];
  if (mixCount() + recs.length > 64) { toast('Bambu Studio allows 64 mixes and this would go over. Remove unused mixes, or use fewer shade steps.', 6000); return null; }
  let st = JSON.parse(S.template['Metadata/project_settings.config']);
  const first = S.palette.length + 1;
  for (const r of recs) {
    st = C.addMix(st, r.comps, r.pc, r.color || recipeColor(r.comps, r.pc));
    if (r.gradient) {
      const i = st.filament_colour.length - 1, set = (k, v) => { if (!Array.isArray(st[k])) st[k] = new Array(i + 1).fill(k === 'filament_mixed_gradient' || k === 'filament_mixed_gradient_per_part' ? '0' : ''); while (st[k].length <= i) st[k].push(''); st[k][i] = v; };
      set('filament_mixed_gradient', '1'); set('filament_mixed_gradient_range', r.gradient); set('filament_mixed_gradient_curve', ''); set('filament_mixed_gradient_per_part', '0');
    }
  }
  commitSettings(st);
  return recs.map((_, i) => first + i);
}
/**
 * Slots for each shading step from base `b` to shade `s`, creating any missing mixes.
 * Step k's recipe is the base recipe × (1 − k/n) + the shade recipe × k/n, so shading a mix with a
 * mix still works. Existing mixes with the same recipe (within 1%) are reused. Cached in `ramps`.
 * @param {number} b Base slot.
 * @param {number} s Shade slot.
 * @param {number} n Number of steps (2–6).
 * @returns {?number[]} n + 1 slots from b to s, or null when a step would need more than 3
 *   filaments (Bambu's limit) or the 64-mix limit is reached.
 */
function getRamp(b, s, n) {
  const key = b + '>' + s + '>' + n;
  const have = ramps.get(key);
  if (have && have.every(x => x <= S.palette.length)) return have;
  const rb = recipeOf(b), rs = recipeOf(s);
  if (!rb || !rs) return null;
  const slots = [b], need = [];
  for (let k = 1; k < n; k++) {
    const f = k / n, rec = {};
    for (const c in rb) rec[c] = (rec[c] || 0) + rb[c] * (1 - f);
    for (const c in rs) rec[c] = (rec[c] || 0) + rs[c] * f;
    const comps = Object.keys(rec).map(Number);
    if (comps.length > 3) return null; // Bambu mixes take up to 3 filaments
    const ex = findSlotFor(rec);
    if (ex) slots.push(ex); else { slots.push(-1 - need.length); need.push({ comps, pc: pctOf(comps.map(c => rec[c])) }); }
  }
  slots.push(s);
  if (need.length) {
    const made = addMixes(need); if (!made) return null;
    for (let i = 0; i < slots.length; i++) if (slots[i] < 0) slots[i] = made[-slots[i] - 1];
  }
  ramps.set(key, slots);
  for (let k = 1; k < n; k++) rampOf.set(slots[k], { b, s, n, k });
  return slots;
}
// Where a triangle's color sits between a base and shade s: { b, s, L } with L from 0 (base) to 1 (shade).
function shadeState(m, s) {
  const info = rampOf.get(m);
  if (info && info.s === s) return { b: info.b, s, L: info.k / info.n };
  if (info && info.b === s) return { b: info.b, s: info.s, L: info.k / info.n, lighten: true };
  const r = recipeOf(m);
  if (r && Object.keys(r).length > 1 && r[s] != null && r[s] < 0.995) { // a shade mix made earlier
    const rest = {}; for (const c in r) if (+c !== s) rest[c] = r[c] / (1 - r[s]);
    const b = findSlotFor(rest); if (b) return { b, s, L: r[s] };
  }
  if (m === s) return null;
  return { b: m, s, L: 0 };
}
// Each triangle's exact shading level is remembered (until something else repaints it), so
// building up or fading back over several passes stays smooth.
function shadeMem(m) {
  if (!m.shade || m.shade.L.length !== m.nT) m.shade = { L: new Float32Array(m.nT), slot: new Uint8Array(m.nT), to: new Uint8Array(m.nT), base: new Uint8Array(m.nT) };
  return m.shade;
}
function setShade(t, pr, L) {
  const m = S.mesh, sv = shadeMem(m), slot = levelSlot(t, pr, L);
  sv.L[t] = L; sv.slot[t] = slot; sv.to[t] = pr.s; sv.base[t] = pr.b;
  if (m.paint[t] !== slot) { m.paint[t] = slot; triColor(t, paintColor(t)); }
}
const DITHER_CELL = 0.6; // mm (old dot pattern, kept for comparison)
// Where each shading step goes: layer stripes on sides, coarse dots on flat faces (prints smoothly).
function shadeTh(t) {
  const m = S.mesh;
  if (S.ditherMode === 'dots') return C.ditherValue(m.cent[t * 3], m.cent[t * 3 + 1], m.cent[t * 3 + 2], DITHER_CELL);
  return C.shadeThreshold(m.cent[t * 3], m.cent[t * 3 + 1], m.cent[t * 3 + 2], m.normals[t * 3 + 2], 0.4, 1.2);
}
function levelSlot(t, st, L) {
  const m = S.mesh, n = S.shSteps;
  let ramp = st.ramp;
  if (ramp === undefined) { ramp = st.ramp = getRamp(st.b, st.s, n) || [st.b, st.s]; }
  const steps = ramp.length - 1, th = shadeTh(t);
  const q = Math.max(0, Math.min(steps, Math.floor(Math.max(0, Math.min(1, L)) * steps + th)));
  return ramp[q];
}
// Big triangles can't hold the stripe/dot pattern (one triangle = one color), so after shading,
// split the shaded triangles that are taller than a stripe (on sides) or wider than a dot (on flat
// faces), carrying each one's exact shade level, then place the shading again on the finer mesh.
const SHADE_BAND = 0.4, SHADE_CELL = 1.2;
let lastShadeMask = null;
const grownMask = () => lastShadeMask;
/**
 * Split shaded triangles too big for the shading pattern, then re-place the pattern on the finer
 * mesh. Each triangle carries its exact shade level through refinement, so nothing drifts.
 * @param {?Uint8Array} mask Triangles to consider (the last stroke's area); null = all shaded ones.
 * @returns {boolean} True if the mesh changed.
 */
function refineShading(mask) {
  const m0 = S.mesh, sv = m0.shade; if (!sv) return false;
  const hasSel = !!S.sel, selColor = hasSel ? S.sel.color : 0;
  let V = m0.verts, T = m0.tris, carry = [m0.paint, m0.wall, sv.L, sv.slot, sv.to, sv.base, mask].concat(m0.part ? [m0.part] : []).concat(hasSel ? [S.sel.mask] : []);
  let changed = false;
  for (let lvl = 0; lvl < 8; lvl++) {
    const nT = T.length / 3, mk = new Uint8Array(nT), msk = carry[6], sl = carry[3], pt = carry[0]; let any = 0;
    for (let t = 0; t < nT; t++) {
      if (!msk[t] || sl[t] !== pt[t]) continue;
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, nl = Math.hypot(nx, ny, nz) || 1;
      let too;
      if (Math.abs(nz / nl) < 0.7) too = Math.max(V[a + 2], V[b + 2], V[c + 2]) - Math.min(V[a + 2], V[b + 2], V[c + 2]) > SHADE_BAND * 0.95;
      else too = Math.max(Math.hypot(ux, uy, uz), Math.hypot(wx, wy, wz), Math.hypot(wx - ux, wy - uy, wz - uz)) > SHADE_CELL * 0.95;
      if (too) { mk[t] = 1; any++; }
    }
    if (!any || T.length / 3 + any * 6 > MAX_TRIS) break;
    const r = C.refineMarked(V, T, mk, carry); V = r.verts; T = r.tris; carry = r.carry; changed = true;
  }
  if (!changed) return false;
  rebuild(V, T, carry[0], carry[1], m0.part ? carry[7] : null);
  const m = S.mesh; m.shade = { L: carry[2], slot: carry[3], to: carry[4], base: carry[5] };
  if (hasSel) { const sm = carry[carry.length - 1], list = []; for (let t = 0; t < sm.length; t++) if (sm[t]) list.push(t); S.sel = { mask: sm, list, color: selColor }; }
  lastShadeMask = carry[6];
  const pairs = new Map(), msk = carry[6];
  for (let t = 0; t < m.nT; t++) {
    if (!msk[t] || m.shade.slot[t] !== m.paint[t] || !m.shade.to[t]) continue;
    const k = m.shade.base[t] + '>' + m.shade.to[t];
    let pr = pairs.get(k); if (!pr) { pr = { b: m.shade.base[t], s: m.shade.to[t] }; pairs.set(k, pr); }
    const L = m.shade.L[t], slot = levelSlot(t, pr, L);
    m.shade.slot[t] = slot; m.paint[t] = slot;
  }
  recolorAll();
  if (S.sel) { openSel(); updateSelOutline(); }
  return true;
}
// Fold shading specks too small to print (under ~0.5 mm²) into the color around them.
const MIN_SPECK = 0.5;
/**
 * Merge shading islands smaller than MIN_SPECK mm² into their surroundings (two passes).
 * @param {?Uint8Array} mask Limit to these triangles; null = whole model.
 */
function despeckle(mask) {
  const m = S.mesh, sv = m.shade;
  for (let pass = 0; pass < 2; pass++) {
    const isl = C.findIslands(m.adj, m.paint, m.area, MIN_SPECK);
    let n = 0;
    for (const i of isl) {
      if (!i.tris.every(t => mask[t]) || !i.surround) continue;
      for (const t of i.tris) { m.paint[t] = i.surround; if (sv && sv.slot.length === m.nT) sv.slot[t] = i.surround; triColor(t, paintColor(t)); }
      n++;
    }
    if (!n) break;
  }
}
// Soft brush: each pass moves the area a little further toward the brush color (or back, when
// painting with the base color over shading). Within one stroke an area only counts once.
function softDab(seed, p, radius) {
  const m = S.mesh, sh = painting.soft, flow = S.flow / 100;
  m.stamp = (m.stamp + 1) >>> 0 || 1;
  const list = C.brushSelect(seed, p, radius, m.adj, m.cent, m.mark, m.stamp), r2 = radius * radius;
  for (const t of list) {
    if (!inSel(t)) continue;
    const dx = m.cent[t * 3] - p[0], dy = m.cent[t * 3 + 1] - p[1], dz = m.cent[t * 3 + 2] - p[2];
    let f = 1 - (dx * dx + dy * dy + dz * dz) / r2; if (f <= 0) continue;
    const a = f * f * flow;
    if (a <= (sh.amt.get(t) || 0)) continue;
    sh.amt.set(t, a);
    let st = sh.state.get(t);
    if (st === undefined) {
      const ss = shadeState(m.paint[t], S.slot);
      if (ss) {
        const k = ss.b + '>' + ss.s;
        let pair = sh.byPair.get(k); if (!pair) { pair = { b: ss.b, s: ss.s }; sh.byPair.set(k, pair); }
        st = { pair, L: ss.L, lighten: ss.lighten };
      } else st = null;
      sh.state.set(t, st);
    }
    if (!st) continue;
    const pr = st.pair;
    if (pr.ramp === undefined) pr.ramp = getRamp(pr.b, pr.s, S.shSteps) || [pr.b, pr.s];
    if (st.L0 === undefined) {
      const sv = shadeMem(m);
      if (sv.slot[t] === m.paint[t] && sv.to[t] === pr.s && m.paint[t] !== pr.s) st.L0 = sv.L[t]; // exact level from an earlier pass
      else { // centre the level inside its dithered step so repeat passes don't creep
        const n = pr.ramp.length - 1, th = shadeTh(t);
        st.L0 = Math.max(0, Math.min(1, st.L + (0.5 - th) / n));
      }
    }
    const L = Math.max(0, Math.min(1, st.lighten ? st.L0 - a : st.L0 + a));
    setShade(t, pr, L);
  }
}
// Gradient fill: from the area's color at the start of the drag to the current color at the end.
// The color a triangle belongs to, counting shading made here as part of the color it shades.
function baseColorOf(t) {
  const m = S.mesh, sl = m.paint[t], sv = m.shade;
  if (sv && sv.slot.length === m.nT && sv.slot[t] === sl && sv.base[t]) return sv.base[t];
  const info = rampOf.get(sl);
  return info ? info.b : sl;
}
// Everything connected to t that is the same color (including its shading): where a gradient goes.
function colorArea(t) {
  const m = S.mesh, B = baseColorOf(t), seen = new Uint8Array(m.nT), out = [t], st = [t];
  seen[t] = 1;
  while (st.length) {
    const a = st.pop();
    for (let e = 0; e < 3; e++) {
      const n = m.adj[a * 3 + e];
      if (n < 0 || seen[n]) continue;
      seen[n] = 1;
      if (!inSel(n) || baseColorOf(n) !== B) continue;
      out.push(n); st.push(n);
    }
  }
  return out;
}
function startGradient(hit) {
  const m = S.mesh;
  const area = S.sel && S.sel.mask[hit.t] ? S.sel.list.slice() : colorArea(hit.t);
  if (!area.length) return null;
  const s = S.slot, pairs = new Map(), st = new Array(area.length);
  area.forEach((t, i) => {
    const b = baseColorOf(t);
    if (b === s) { st[i] = null; return; }
    const k = b + '>' + s;
    if (!pairs.has(k)) pairs.set(k, { b, s });
    st[i] = pairs.get(k);
  });
  for (const pr of pairs.values()) pr.ramp = getRamp(pr.b, pr.s, S.shSteps) || [pr.b, pr.s];
  return { area, st, from: Uint8Array.from(area, t => m.paint[t]), p0: [hit.p.x, hit.p.y, hit.p.z], p1: null, pairs };
}
function drawGradient(g) {
  const m = S.mesh, a = g.p0, b = g.p1;
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], L2 = dx * dx + dy * dy + dz * dz || 1e-9;
  g.area.forEach((t, i) => {
    const pr = g.st[i]; if (!pr) return;
    const u = ((m.cent[t * 3] - a[0]) * dx + (m.cent[t * 3 + 1] - a[1]) * dy + (m.cent[t * 3 + 2] - a[2]) * dz) / L2;
    setShade(t, pr, Math.max(0, Math.min(1, u)));
  });
  const L = lift();
  setLiveLine([a[0], a[1], a[2] + L, b[0], b[1], b[2] + L]);
}
function finishGradient(g) {
  setLiveLine(null);
  if (!g.p1) { // a tap, not a drag
    const m = S.mesh; g.area.forEach((t, i) => { if (m.paint[t] !== g.from[i]) { m.paint[t] = g.from[i]; triColor(t, paintColor(t)); } });
    endStroke(); toast('Drag across the area: the gradient runs from its color where you start to the current color where you lift.', 4500); return;
  }
  if (S.smoothGrad) {
    const pr = [...g.pairs.values()];
    const phys = x => S.palette[x - 1] && !S.palette[x - 1].mixed;
    if (pr.length !== 1 || !phys(pr[0].b) || !phys(pr[0].s) || pr[0].b === pr[0].s) {
      toast('Smooth up/down needs one plain filament for the area and one for the shade (no mixes), so this gradient uses steps.', 5500);
    } else {
      const up = g.p1[2] >= g.p0[2]; // base at the bottom, shade at the top
      const range = up ? '0.9500,0.0500' : '0.0500,0.9500', comps = [pr[0].b, pr[0].s];
      let slot = 0;
      for (const p of S.palette) if (p.gradient && p.components && p.components.join(',') === comps.join(',') && String(p.gradRange) === range) slot = p.slot;
      if (!slot) { const made = addMixes([{ comps, pc: [50, 50], gradient: range, color: recipeColor(comps, [50, 50]) }]); if (!made) { endStroke(); return; } slot = made[0]; }
      const m = S.mesh; for (const t of g.area) m.paint[t] = slot;
      recolorAll(); endStroke();
      toast('Smooth gradient: Bambu Studio blends ' + label(S.palette[comps[0] - 1]) + ' into ' + label(S.palette[comps[1] - 1]) + ' layer by layer, over the full height of this area.', 6000);
      return;
    }
  }
  { const msk = new Uint8Array(S.mesh.nT); for (const t of g.area) msk[t] = 1; const grown = refineShading(msk); despeckle(grown ? grownMask(msk) : msk); }
  endStroke(); renderPalette();
  toast('Gradient in ' + S.shSteps + ' steps, speckled so they blend. Undo to try a different direction.', 3500);
}
// Hard brush: once the stroke is done, cut the mesh along the round brush outline so the edge is smooth.
function finishHardBrush(p) {
  const b = strokeBefore; if (!b) return endStroke();
  const caps = [];
  for (const ch of p.chains) {
    let prev = null;
    for (const d of ch) {
      if (!d) { prev = null; continue; }
      if (prev && Math.hypot(d[0] - prev[0], d[1] - prev[1], d[2] - prev[2]) < 3 * Math.max(d[3], prev[3])) caps.push(...prev, ...d);
      else caps.push(...d, ...d);
      prev = d;
    }
  }
  const m0 = S.mesh;
  if (!caps.length || !p.touched) return endStroke();
  let minR = 1e9; for (let i = 3; i < caps.length; i += 4) minR = Math.min(minR, caps[i]);
  const target = Math.min(S.detail, Math.max(0.1, minR / 4));
  const selMask = S.sel ? S.sel.mask : null, selColor = S.sel ? S.sel.color : 0;
  const carry = [m0.paint, m0.wall, b.paint, p.touched].concat(m0.part ? [m0.part] : []).concat(selMask ? [selMask] : []);
  const res = C.refineAlongCaps(m0.verts, m0.tris, carry, caps, target, MAX_TRIS);
  let before = b.paint, touched = p.touched;
  let mask = selMask;
  if (res.verts !== m0.verts) {
    rebuild(res.verts, res.tris, res.carry[0], res.carry[1], m0.part ? res.carry[4] : null); before = res.carry[2]; touched = res.carry[3];
    if (selMask) { mask = res.carry[res.carry.length - 1]; const list = []; for (let t = 0; t < mask.length; t++) if (mask[t]) list.push(t); S.sel = { mask, list, color: selColor }; }
  }
  const m = S.mesh, info = C.capsInfo(caps), slot = p.slot;
  const inside = t => (!mask || mask[t]) && C.insideCaps(caps, info, m.cent[t * 3], m.cent[t * 3 + 1], m.cent[t * 3 + 2]);
  // start from what the brush reached, then grow across the surface (never through the model)
  const seen = new Uint8Array(m.nT), stack = [];
  for (let t = 0; t < m.nT; t++) if (touched[t]) { seen[t] = 1; stack.push(t); }
  const changed = [];
  while (stack.length) {
    const t = stack.pop();
    const want = inside(t) ? slot : before[t];
    if (m.paint[t] !== want) { m.paint[t] = want; changed.push(t); }
    if (want !== slot) continue;
    for (let e = 0; e < 3; e++) { const n = m.adj[t * 3 + e]; if (n >= 0 && !seen[n] && inside(n)) { seen[n] = 1; stack.push(n); } }
  }
  if (res.verts !== m0.verts) { recolorAll(); if (S.sel) { openSel(); updateSelOutline(); } } else for (const t of changed) triColor(t, paintColor(t));
  endStroke();
}

// ---------------- image projection ----------------
// An image is placed over the view (screen space). Apply finds every triangle that is visible
// under it (by drawing the model once with each triangle in its own code color), refines big
// triangles so the picture keeps its detail, averages the image's pixels over each triangle, and
// paints it with the closest filament or mix. Optionally adds Bambu-measured mixes that best match.
let decal = null; // { img, w, h, data (ImageData), cx, cy, scale, rot, locked }
function showDecal() {
  const el = $('decal');
  if (!decal || S.tool !== 'image') { el.style.display = 'none'; return; }
  el.style.display = '';
  el.style.width = decal.w + 'px'; el.style.height = decal.h + 'px';
  el.style.opacity = S.imgOpacity / 100;
  el.style.transform = 'translate(' + decal.cx + 'px,' + decal.cy + 'px) rotate(' + decal.rot + 'rad) scale(' + decal.scale + ') translate(' + (-decal.w / 2) + 'px,' + (-decal.h / 2) + 'px)';
  el.classList.toggle('locked', !!decal.locked);
  $('decalHandle').style.transform = 'scale(' + (1 / decal.scale) + ')';
  $('bImgApply').disabled = !S.mesh;
}
function loadDecal(file) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    let w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 2048 / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h);
    $('decalImg').src = cv.toDataURL();
    const vw = view.clientWidth, vh = view.clientHeight;
    decal = { w, h, data, cx: vw / 2, cy: vh / 2, scale: Math.min(vw, vh) * 0.45 / Math.max(w, h), rot: 0, locked: false };
    $('tImgLock').classList.remove('on');
    showDecal(); URL.revokeObjectURL(url);
    toast('Drag the image over the model. Touch outside it to turn the model, then Apply.', 4500);
  };
  img.onerror = () => toast('That image could not be opened.');
  img.src = url;
}
// gestures on the image: one finger moves, two fingers pinch/twist, the handle resizes and turns
{
  const el = $('decal'), pts = new Map(); let start = null;
  const snap = () => { const a = [...pts.values()]; return { d: decal && { ...decal }, p: a.map(p => ({ ...p })) }; };
  el.addEventListener('pointerdown', e => {
    if (!decal || decal.locked) return;
    e.preventDefault(); e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY, handle: e.target.id === 'decalHandle' });
    start = snap();
  });
  el.addEventListener('pointermove', e => {
    if (!decal || !pts.has(e.pointerId) || !start) return;
    pts.get(e.pointerId).x = e.clientX; pts.get(e.pointerId).y = e.clientY;
    const a = [...pts.values()], s = start;
    if (a.length === 1 && a[0].handle) { // handle: scale and turn around the centre
      const p0 = s.p[0], v0 = [p0.x - s.d.cx, p0.y - s.d.cy], v1 = [a[0].x - s.d.cx, a[0].y - s.d.cy];
      decal.scale = Math.max(0.01, s.d.scale * Math.hypot(...v1) / Math.max(1, Math.hypot(...v0)));
      decal.rot = s.d.rot + Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]);
    } else if (a.length === 1) { decal.cx = s.d.cx + a[0].x - s.p[0].x; decal.cy = s.d.cy + a[0].y - s.p[0].y; }
    else if (a.length >= 2 && s.p.length >= 2) {
      const c0 = [(s.p[0].x + s.p[1].x) / 2, (s.p[0].y + s.p[1].y) / 2], c1 = [(a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2];
      const d0 = Math.hypot(s.p[1].x - s.p[0].x, s.p[1].y - s.p[0].y), d1 = Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y);
      const r0 = Math.atan2(s.p[1].y - s.p[0].y, s.p[1].x - s.p[0].x), r1 = Math.atan2(a[1].y - a[0].y, a[1].x - a[0].x);
      decal.cx = s.d.cx + c1[0] - c0[0]; decal.cy = s.d.cy + c1[1] - c0[1];
      decal.scale = Math.max(0.01, s.d.scale * d1 / Math.max(1, d0)); decal.rot = s.d.rot + r1 - r0;
    }
    showDecal();
  });
  const up = e => { pts.delete(e.pointerId); start = pts.size ? snap() : null; };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', e => { if (!decal) return; e.preventDefault(); decal.scale *= Math.exp(-e.deltaY * 0.0015); showDecal(); }, { passive: false });
}
// screen position (px in the view) -> image pixel, or null
function decalUV(sx, sy) {
  const dx = sx - decal.cx, dy = sy - decal.cy, c = Math.cos(-decal.rot), s = Math.sin(-decal.rot);
  const u = (dx * c - dy * s) / decal.scale + decal.w / 2, v = (dx * s + dy * c) / decal.scale + decal.h / 2;
  return u >= 0 && v >= 0 && u < decal.w && v < decal.h ? [u, v] : null;
}
/**
 * Find which triangle is visible at every pixel: render the model once off-screen with triangle
 * t + 1 encoded in RGB (24 bits, so up to 16.7 million triangles) and read the pixels back.
 * Exact occlusion for free, much faster than raycasting each pixel.
 * @returns {{ids: Int32Array, RW: number, RH: number, pr: number}} Triangle per pixel (−1 = background),
 *   top row first, at render resolution RW × RH; pr = pixel ratio used (≤ 2).
 */
function triangleIdPass() {
  const m = S.mesh, W = view.clientWidth, H = view.clientHeight, pr = Math.min(2, renderer.getPixelRatio()), RW = Math.round(W * pr), RH = Math.round(H * pr);
  const ids = new Uint8Array(m.nT * 9);
  for (let t = 0; t < m.nT; t++) { const v = t + 1, r = v & 255, g = (v >> 8) & 255, b = (v >> 16) & 255; for (let k = 0; k < 3; k++) { ids[t * 9 + k * 3] = r; ids[t * 9 + k * 3 + 1] = g; ids[t * 9 + k * 3 + 2] = b; } }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', model.geometry.getAttribute('position'));
  g.setAttribute('color', new THREE.BufferAttribute(ids, 3, true));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const mesh = new THREE.Mesh(g, mat), sc = new THREE.Scene(); sc.add(mesh);
  const rt = new THREE.WebGLRenderTarget(RW, RH, { type: THREE.UnsignedByteType });
  const prevBg = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(sc, camera);
  const buf = new Uint8Array(RW * RH * 4); renderer.readRenderTargetPixels(rt, 0, 0, RW, RH, buf);
  renderer.setRenderTarget(null); renderer.setClearColor(prevBg, prevA);
  rt.dispose(); mat.dispose(); g.deleteAttribute('position'); g.dispose(); needRender = true;
  const out = new Int32Array(RW * RH);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) { const i = ((RH - 1 - y) * RW + x) * 4; out[y * RW + x] = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16)) - 1; }
  return { ids: out, RW, RH, pr };
}
function srgbToLab(r, g, b) {
  const f = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const R = f(r), G = f(g), B = f(b);
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const h = v => v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  X = h(X); Y = h(Y); Z = h(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
/**
 * Paint the placed image onto the model (Image tool → Apply). Steps: find visible triangles under
 * the image's opaque pixels that face the camera, refine them to the Detail size, average the image
 * over each, optionally add up to N gallery mixes that most reduce colour error (greedy), paint the
 * closest colour in Lab, and clean up specks. One undo step. Respects an active selection.
 */
async function applyDecal() {
  if (!decal || !S.mesh || S.busy) return;
  S.busy = true; toast('Projecting the image…', 60000);
  await new Promise(r => setTimeout(r, 30));
  try {
    beginStroke();
    const camDir = new THREE.Vector3(), v3 = new THREE.Vector3();
    // 1. which triangles are visible under the image, and facing the camera
    const inFootprint = (pass, m) => {
      const cand = new Uint8Array(m.nT), { ids, RW, RH, pr } = pass;
      for (let y = 0; y < RH; y += 1) for (let x = 0; x < RW; x += 1) {
        const t = ids[y * RW + x]; if (t < 0 || cand[t]) continue;
        const uv = decalUV(x / pr, y / pr); if (!uv) continue;
        const a = decal.data.data[(Math.floor(uv[1]) * decal.w + Math.floor(uv[0])) * 4 + 3]; if (a < 128) continue;
        cand[t] = 1;
      }
      for (let t = 0; t < m.nT; t++) if (cand[t]) {
        camDir.set(camera.position.x - m.cent[t * 3], camera.position.y - m.cent[t * 3 + 1], camera.position.z - m.cent[t * 3 + 2]).normalize();
        if (camDir.x * m.normals[t * 3] + camDir.y * m.normals[t * 3 + 1] + camDir.z * m.normals[t * 3 + 2] < 0.15 || !inSel(t)) cand[t] = 0;
      }
      return cand;
    };
    let pass = triangleIdPass(), m0 = S.mesh, cand = inFootprint(pass, m0);
    // 2. refine big triangles under the image so the picture keeps its detail
    const target = S.imgDetail, hasSel = !!S.sel, selColor = hasSel ? S.sel.color : 0;
    let V = m0.verts, T = m0.tris, carry = [m0.paint, m0.wall, cand].concat(m0.part ? [m0.part] : []).concat(hasSel ? [S.sel.mask] : []), changed = false, limited = false;
    for (let lvl = 0; lvl < 10; lvl++) {
      const nT = T.length / 3, mk = new Uint8Array(nT), cd = carry[2]; let any = 0;
      for (let t = 0; t < nT; t++) {
        if (!cd[t]) continue;
        const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        const e = Math.max(Math.hypot(V[a] - V[b], V[a + 1] - V[b + 1], V[a + 2] - V[b + 2]), Math.hypot(V[b] - V[c], V[b + 1] - V[c + 1], V[b + 2] - V[c + 2]), Math.hypot(V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]));
        if (e > target) { mk[t] = 1; any++; }
      }
      if (!any) break;
      if (nT + any * 6 > MAX_TRIS) { limited = true; break; }
      const r = C.refineMarked(V, T, mk, carry); V = r.verts; T = r.tris; carry = r.carry; changed = true;
    }
    if (changed) {
      rebuild(V, T, carry[0], carry[1], m0.part ? carry[3] : null);
      if (hasSel) { const sm = carry[carry.length - 1], list = []; for (let t = 0; t < sm.length; t++) if (sm[t]) list.push(t); S.sel = { mask: sm, list, color: selColor }; }
      renderer.render(scene, camera);
      pass = triangleIdPass();
    }
    const m = S.mesh; cand = inFootprint(pass, m);
    // 3. average the image over each triangle's pixels
    const sum = new Float32Array(m.nT * 4), D = decal.data.data, { ids, RW, RH, pr } = pass;
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const t = ids[y * RW + x]; if (t < 0 || !cand[t]) continue;
      const uv = decalUV(x / pr, y / pr); if (!uv) continue;
      const i = (Math.floor(uv[1]) * decal.w + Math.floor(uv[0])) * 4; if (D[i + 3] < 128) continue;
      sum[t * 4] += D[i]; sum[t * 4 + 1] += D[i + 1]; sum[t * 4 + 2] += D[i + 2]; sum[t * 4 + 3]++;
    }
    // triangles too small to cover a pixel: take the pixel at their centre if a close neighbour is there
    const rect = view.getBoundingClientRect();
    for (let t = 0; t < m.nT; t++) {
      if (!cand[t] && !(sum[t * 4 + 3] === 0 && candNear(t))) continue;
      if (sum[t * 4 + 3]) continue;
      v3.set(m.cent[t * 3], m.cent[t * 3 + 1], m.cent[t * 3 + 2]).project(camera);
      const sx = (v3.x + 1) / 2 * view.clientWidth, sy = (1 - v3.y) / 2 * view.clientHeight;
      const uv = decalUV(sx, sy); if (!uv) continue;
      const px = Math.min(RW - 1, Math.max(0, Math.round(sx * pr))), py = Math.min(RH - 1, Math.max(0, Math.round(sy * pr))), o = ids[py * RW + px];
      if (o < 0 || Math.hypot(m.cent[o * 3] - m.cent[t * 3], m.cent[o * 3 + 1] - m.cent[t * 3 + 1], m.cent[o * 3 + 2] - m.cent[t * 3 + 2]) > Math.max(1, target * 3)) continue;
      const i = (Math.floor(uv[1]) * decal.w + Math.floor(uv[0])) * 4; if (D[i + 3] < 128) continue;
      sum[t * 4] = D[i]; sum[t * 4 + 1] = D[i + 1]; sum[t * 4 + 2] = D[i + 2]; sum[t * 4 + 3] = 1;
    }
    function candNear(t) { for (let e = 0; e < 3; e++) { const n = m.adj[t * 3 + e]; if (n >= 0 && cand[n]) return inSel(t); } return false; }
    const hit = []; for (let t = 0; t < m.nT; t++) if (sum[t * 4 + 3] > 0) hit.push(t);
    if (!hit.length) { endStroke(); S.busy = false; toast('The image is not over any part of the model that faces you.', 4000); return; }
    // 4. colors: Lab of each triangle, binned
    const lab = new Float32Array(hit.length * 3), bins = new Map();
    hit.forEach((t, i) => {
      const n = sum[t * 4 + 3], L = srgbToLab(sum[t * 4] / n, sum[t * 4 + 1] / n, sum[t * 4 + 2] / n);
      lab[i * 3] = L[0]; lab[i * 3 + 1] = L[1]; lab[i * 3 + 2] = L[2];
      const k = Math.round(L[0] / 3) + ',' + Math.round(L[1] / 3) + ',' + Math.round(L[2] / 3);
      const b = bins.get(k); if (b) { b.w += m.area[t]; } else bins.set(k, { L, w: m.area[t] });
    });
    const B = [...bins.values()];
    const usable = () => S.palette.filter(p => !p.gradient).map(p => ({ slot: p.slot, lab: C.hexToLab(p.color) }));
    let have = usable(), added = 0;
    if (S.imgColors === 'mix') {
      // greedily add the measured mixes that most reduce the color error, up to the limit
      const cands = galleryMixes().filter(c => !findSlotFor(Object.fromEntries(c.slots.map((s, i) => [s, c.pc[i] / 100]))));
      const best = new Float32Array(B.length);
      const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      B.forEach((b, i) => { best[i] = Math.min(...have.map(h => d(b.L, h.lab))); });
      const picks = [];
      for (let k = 0; k < S.imgMixes && cands.length; k++) {
        let gain = 0, bi = -1;
        cands.forEach((c, ci) => { let g = 0; for (let i = 0; i < B.length; i++) { const x = d(B[i].L, c.lab); if (x < best[i]) g += (best[i] - x) * B[i].w; } if (g > gain) { gain = g; bi = ci; } });
        if (bi < 0 || gain < 1) break;
        const c = cands.splice(bi, 1)[0]; picks.push(c);
        for (let i = 0; i < B.length; i++) best[i] = Math.min(best[i], d(B[i].L, c.lab));
      }
      if (picks.length) {
        const made = addMixes(picks.map(c => ({ comps: c.slots, pc: c.pc, color: c.color })));
        if (made) added = made.length;
        have = usable();
      }
    }
    // 5. paint each triangle with the closest color
    for (let i = 0; i < hit.length; i++) {
      const t = hit[i], L = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
      let bs = 1, bd = 1e9; for (const h of have) { const x = Math.hypot(L[0] - h.lab[0], L[1] - h.lab[1], L[2] - h.lab[2]); if (x < bd) { bd = x; bs = h.slot; } }
      m.paint[t] = bs;
    }
    const msk = new Uint8Array(m.nT); for (const t of hit) msk[t] = 1;
    despeckle(msk);
    recolorAll(); if (S.sel) { openSel(); updateSelOutline(); }
    endStroke(); renderPalette(); status();
    toast('Image applied to ' + hit.length.toLocaleString() + ' triangles' + (added ? ', with ' + added + ' new mix' + (added > 1 ? 'es' : '') : '') + (limited ? '. The mesh hit its size limit, so detail is coarser.' : '.') + ' Undo to try again.', 5000);
  } catch (err) { console.error(err); toast('Could not apply the image: ' + err.message, 6000); try { endStroke(); } catch (_) {} }
  S.busy = false;
}
$('bImgPick').onclick = () => $('fImage').click();
$('fImage').onchange = e => { const f = e.target.files[0]; if (f) loadDecal(f); e.target.value = ''; };
$('bImgClear').onclick = () => { decal = null; showDecal(); $('bImgApply').disabled = true; };
$('bImgApply').onclick = applyDecal;
$('tImgLock').onclick = e => { if (!decal) return; decal.locked = !decal.locked; e.currentTarget.classList.toggle('on', decal.locked); showDecal(); };
$('imgOpacity').value = S.imgOpacity; $('imgOpVal').textContent = S.imgOpacity + '%';
$('imgOpacity').oninput = e => { S.imgOpacity = +e.target.value; store('labcraft.imgOpacity', S.imgOpacity); $('imgOpVal').textContent = S.imgOpacity + '%'; showDecal(); };
$('imgDetail').value = S.imgDetail; $('imgDetVal').textContent = S.imgDetail + ' mm';
$('imgDetail').oninput = e => { S.imgDetail = +e.target.value; store('labcraft.imgDetail', S.imgDetail); $('imgDetVal').textContent = S.imgDetail + ' mm'; };
$('imgMixes').value = S.imgMixes; $('imgMixVal').textContent = S.imgMixes;
$('imgMixes').oninput = e => { S.imgMixes = +e.target.value; store('labcraft.imgMixes', S.imgMixes); $('imgMixVal').textContent = S.imgMixes; };
document.querySelectorAll('#imgColorsSeg button').forEach(b => { b.classList.toggle('on', b.dataset.c === S.imgColors); b.onclick = () => { S.imgColors = b.dataset.c; store('labcraft.imgColors', S.imgColors); document.querySelectorAll('#imgColorsSeg button').forEach(x => x.classList.toggle('on', x === b)); refreshRows(); }; });

// ---------------- undo ----------------
// Paint-only steps store just the triangles that changed (old and new colour), so undoing one tap
// changes only that tap's triangles. Steps that change the mesh or outlines keep a full snapshot.
function snapshot(copyPaint) {
  const m = S.mesh;
  return { kind: 'full', verts: m.verts, tris: m.tris, wall: m.wall, part: m.part, paint: copyPaint ? m.paint.slice() : m.paint, lines: S.lines.slice(), sel: selState() };
}
let strokeBefore = null;
// Selections are part of the history too, so undo steps back through shapes one at a time.
function selState() { return S.sel && S.mesh ? { list: S.sel.list, color: S.sel.color, nT: S.mesh.nT } : null; }
function setSelState(st) {
  if (st && S.mesh && st.nT === S.mesh.nT && st.list.length) setSel(st.list, st.color);
  else if (S.sel) endSel();
}
function selStep(prev) { const next = selState(); if (prev || next) { pushStep({ kind: 'sel', prev, next }); updateUndo(); } }
function beginStroke() { strokeBefore = snapshot(true); }
function pushStep(step) { S.undo.push(step); if (S.undo.length > 40) S.undo.shift(); S.redo = []; renderPalette(); }
function endStroke(force) {
  if (!strokeBefore) return;
  const m = S.mesh, b = strokeBefore;
  strokeBefore = null;
  const geometry = force || b.verts !== m.verts || b.wall !== m.wall || b.lines.length !== S.lines.length;
  if (geometry) pushStep(b);
  else {
    const p = m.paint, old = b.paint, idx = [];
    for (let i = 0; i < p.length; i++) if (p[i] !== old[i]) idx.push(i);
    if (idx.length) {
      const I = Int32Array.from(idx);
      pushStep({ kind: 'paint', nT: p.length, idx: I, from: Uint8Array.from(I, i => old[i]), to: Uint8Array.from(I, i => p[i]) });
    }
  }
  updateUndo();
}
function applyPaintStep(st, back) {
  const m = S.mesh;
  if (st.nT !== m.nT) return false;
  const vals = back ? st.from : st.to;
  for (let k = 0; k < st.idx.length; k++) m.paint[st.idx[k]] = vals[k];
  for (let k = 0; k < st.idx.length; k++) triColor(st.idx[k], paintColor(st.idx[k]));
  renderPalette(); status();
  return true;
}
function restore(st) {
  const m = S.mesh;
  S.sel = null;
  if (st.verts !== m.verts || st.tris !== m.tris) rebuild(st.verts, st.tris, st.paint, st.wall, st.part || null);
  else { m.paint = st.paint; m.wall = st.wall; if (st.part && st.part.length === m.nT) m.part = st.part; partBuckets = null; recolorAll(); updatePartLines(); }
  S.lines = st.lines; renderLines(); renderPalette(); status();
  if (st.sel) setSelState(st.sel); else closeSel();
  try { updateSelOutline(); } catch (_) {}
}
function updateUndo() {
  $('bUndo').disabled = !S.undo.length; $('bRedo').disabled = !S.redo.length;
  $('undoN').textContent = S.undo.length ? S.undo.length : '';
  $('bUndo').title = S.undo.length + ' step' + (S.undo.length === 1 ? '' : 's') + ' to undo (⌘Z)';
}
function undo() {
  if (!S.undo.length || S.busy) return;
  clearPreview();
  const st = S.undo.pop();
  if (st.kind === 'paint') { if (applyPaintStep(st, true)) S.redo.push(st); if (S.sel) openSel(); }
  else if (st.kind === 'sel') { setSelState(st.prev); S.redo.push(st); }
  else { S.redo.push(snapshot(false)); restore(st); }
  updateUndo();
}
function redo() {
  if (!S.redo.length || S.busy) return;
  clearPreview();
  const st = S.redo.pop();
  if (st.kind === 'paint') { if (applyPaintStep(st, false)) S.undo.push(st); if (S.sel) openSel(); }
  else if (st.kind === 'sel') { setSelState(st.next); S.undo.push(st); }
  else { S.undo.push(snapshot(false)); restore(st); }
  updateUndo();
}

// ---------------- picking ----------------
const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
const ndc = new THREE.Vector2();
function pick(cx, cy) {
  if (!model) return null;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(model, false)[0];
  return hit ? { t: hit.faceIndex, p: hit.point, n: hit.face.normal } : null;
}

// Fill / recolor region, bounded by outlines (and sharp edges for Fill).
function region(t) {
  const m = S.mesh;
  if (S.tool === 'parts') return partTris(t);
  const seed = C.nearestNonWall(t, m.adj, m.wall);
  if (seed < 0) return [];
  const mark = new Uint8Array(m.nT);
  let R, colorOnly = null;
  if (S.tool === 'fill') R = C.smartFill(seed, S.edges ? S.angle : 180, m.adj, m.normals, mark, m.wall);
  else if (S.tool === 'parts') return partTris(t);
  else { R = C.sameColorFill(seed, m.adj, m.paint, mark, m.wall); colorOnly = m.paint[seed]; }
  if (S.lines.length) R = R.concat(C.absorbWalls(R, m.adj, m.wall, S.segs, m.normals, m.cent, m.paint, colorOnly));
  return R;
}
function applyTris(list) {
  const p = S.mesh.paint, s = S.slot;
  for (const t of list) if (p[t] !== s) { p[t] = s; triColor(t, paintColor(t)); }
}
function brushDab(t, p, radius, chain) {
  const m = S.mesh;
  if (painting && painting.soft) return softDab(t, p, radius);
  m.stamp = (m.stamp + 1) >>> 0 || 1;
  let list = C.brushSelect(t, p, radius, m.adj, m.cent, m.mark, m.stamp);
  if (S.sel && S.tool !== 'select') list = list.filter(inSel);
  applyTris(list);
  if (painting && painting.chains) {
    if (!painting.touched) painting.touched = new Uint8Array(m.nT);
    for (const x of list) painting.touched[x] = 1;
    painting.chains[chain].push([p[0], p[1], p[2], radius]);
  }
}
function brushAt(hit, radius) {
  brushDab(hit.t, [hit.p.x, hit.p.y, hit.p.z], radius, 0);
  if (S.sym !== 'off' && S.home) {
    const q = mirrorPoint(hit.p.x, hit.p.y, hit.p.z), h = surfaceHit(q[0], q[1], q[2]);
    if (h && h.d < Math.max(radius, S.diag * 0.01)) brushDab(h.t, [h.x, h.y, h.z], radius, 1);
    else if (painting && painting.chains) painting.chains[1].push(null);
  }
}

// hover preview
let preview = null;
function clearPreview() {
  if (!preview || !S.mesh) { preview = null; return; }
  for (const t of preview.tris) if (t < S.mesh.nT) triColor(t, paintColor(t));
  preview = null;
}
function showRegion(list) {
  clearPreview();
  const lighten = c => [c[0] + (255 - c[0]) * .55, c[1] + (255 - c[1]) * .55, c[2] + (255 - c[2]) * .55];
  const memo = {};
  for (const t of list) { const s = S.mesh.paint[t]; triColor(t, memo[s] || (memo[s] = lighten(paintColor(t)))); }
  preview = { tris: list, set: new Set(list) };
}
function placeRing(hit, radius) {
  ring.visible = true;
  ring.position.copy(hit.p);
  const n = hit.n.clone().normalize();
  ring.lookAt(hit.p.clone().add(n));
  ring.position.addScaledVector(n, radius * 0.02);
  ring.scale.setScalar(radius);
  needRender = true;
}
function hideRing() { if (ring.visible) { ring.visible = false; needRender = true; } }

let hoverPending = null;
function hover(cx, cy) {
  hoverPending = [cx, cy];
  requestAnimationFrame(() => {
    if (!hoverPending || painting || S.checking) return;
    const [x, y] = hoverPending; hoverPending = null;
    const hit = pick(x, y);
    if (!hit) { hideRing(); clearPreview(); return; }
    if (S.tool === 'brush') { clearPreview(); placeRing(hit, S.size); }
    else if (S.tool === 'outline') { clearPreview(); placeRing(hit, Math.max(S.detail, S.diag / 150)); }
    else if (S.tool === 'select' && S.sel) { hideRing(); clearPreview(); }
    else if (S.tool === 'parts' && !(S.parts && S.mesh.part)) { hideRing(); }
    else { hideRing(); if (!preview || !preview.set.has(hit.t)) showRegion(region(hit.t)); }
  });
}

// ---------------- outline drawing ----------------
let samples = null; // [{sx, sy, x, y, z}]
const lift = () => Math.max(0.02, S.diag / 2000);
function liveFromSamples() {
  const a = new Float32Array(samples.length * 3);
  samples.forEach((s, i) => { a[i * 3] = s.x + s.nx * lift(); a[i * 3 + 1] = s.y + s.ny * lift(); a[i * 3 + 2] = s.z + s.nz * lift(); });
  return a;
}
// Streamline: the line trails the Pencil on a short "rope" (screen pixels), so hand wobble is absorbed while drawing;
// the whole stroke is smoothed again when the Pencil lifts.
let brushPt = null, strokeScreen = null;
const ropeLen = () => S.stream * 0.12; // 0..12 px
function startStreamline(cx, cy) { brushPt = [cx, cy]; strokeScreen = [[cx, cy]]; samples = []; addSample(cx, cy); }
function streamTo(cx, cy) {
  const dx = cx - brushPt[0], dy = cy - brushPt[1], d = Math.hypot(dx, dy), R = ropeLen();
  if (d <= R) return;
  brushPt = [brushPt[0] + dx * (d - R) / d, brushPt[1] + dy * (d - R) / d];
  const last = strokeScreen[strokeScreen.length - 1];
  if (Math.hypot(brushPt[0] - last[0], brushPt[1] - last[1]) < 1.5) return;
  strokeScreen.push(brushPt.slice());
  addSample(brushPt[0], brushPt[1]);
}
// When the Pencil lifts, the line catches up with the tip so the end of the stroke isn't lost.
function streamCatchUp(cx, cy) {
  const last = strokeScreen[strokeScreen.length - 1];
  const d = Math.hypot(cx - last[0], cy - last[1]);
  const steps = Math.ceil(d / 3);
  for (let k = 1; k <= steps; k++) {
    const x = last[0] + (cx - last[0]) * k / steps, y = last[1] + (cy - last[1]) * k / steps;
    strokeScreen.push([x, y]); addSample(x, y);
  }
}
// Smooth a screen-space stroke (Gaussian along its length) and resample it evenly.
function smoothStroke(P, closed) {
  const n = P.length;
  if (n < 3 || S.stream <= 0) return P;
  const arc = [0]; for (let i = 1; i < n; i++) arc.push(arc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const total = arc[n - 1] + (closed ? Math.hypot(P[0][0] - P[n - 1][0], P[0][1] - P[n - 1][1]) : 0);
  const sigma = Math.max(1, S.stream * 0.12), reach = 3 * sigma; // up to 12 px
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { out.push(P[i]); continue; }
    let sx = 0, sy = 0, sw = 0;
    for (let j = 0; j < n; j++) {
      let d = Math.abs(arc[j] - arc[i]); if (closed) d = Math.min(d, total - d);
      if (d > reach) continue;
      const w = Math.exp(-d * d / (2 * sigma * sigma)); sx += P[j][0] * w; sy += P[j][1] * w; sw += w;
    }
    // ease towards the ends so an open line still starts and ends where it was drawn
    const edge = closed ? 1 : Math.min(1, Math.min(arc[i], arc[n - 1] - arc[i]) / (2 * sigma));
    out.push([P[i][0] + (sx / sw - P[i][0]) * edge, P[i][1] + (sy / sw - P[i][1]) * edge]);
  }
  // even spacing, about 2 px
  const res = [out[0]];
  let carry = 0;
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = 2 - carry;
    while (t <= L) { res.push([a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L]); t += 2; }
    carry = L - (t - 2);
  }
  if (!closed) res.push(out[out.length - 1]);
  return res;
}
function addSample(cx, cy) {
  const hit = pick(cx, cy);
  if (!hit) return;
  const last = samples[samples.length - 1];
  if (last && Math.hypot(last.x - hit.p.x, last.y - hit.p.y, last.z - hit.p.z) < S.detail * 0.25) return;
  samples.push({ sx: cx, sy: cy, x: hit.p.x, y: hit.p.y, z: hit.p.z, nx: hit.n.x, ny: hit.n.y, nz: hit.n.z });
}
async function finishOutline() { return finishStroke('outline'); }
// Place a finished stroke on the model: smooth it, mirror it if symmetry is on, refine the mesh along it,
// then either keep it as outline lines (kind 'outline') or use the enclosed area as a selection (kind 'lasso').
async function finishStroke(kind) {
  let pts = samples; samples = null;
  let closed = kind === 'lasso';
  if (strokeScreen && strokeScreen.length > 2 && pts && pts.length > 2) {
    const a0 = pts[0], z0 = pts[pts.length - 1];
    const sA = strokeScreen[0], sZ = strokeScreen[strokeScreen.length - 1];
    if (!closed) closed = pts.length > 4 && (Math.hypot(a0.x - z0.x, a0.y - z0.y, a0.z - z0.z) < Math.max(S.detail * 6, S.diag * 0.03) || Math.hypot(sA[0] - sZ[0], sA[1] - sZ[1]) < 40);
    const sm = smoothStroke(strokeScreen, closed);
    const again = [];
    for (const [x, y] of sm) { const h = pick(x, y); if (h) again.push({ x: h.p.x, y: h.p.y, z: h.p.z }); }
    if (again.length > 2) pts = again;
  }
  strokeScreen = null; brushPt = null;
  if (!pts || pts.length < (kind === 'lasso' ? 4 : 2)) { setLiveLine(null); endStroke(); return; }
  const polys = [pts.map(p => [p.x, p.y, p.z])];
  let mirrorMissed = false;
  if (S.sym !== 'off' && S.home) { const mp = mirrorPoly(polys[0]); if (mp) polys.push(mp); else mirrorMissed = true; }
  // 1. refine the mesh along the line(s) so the colour edge can follow them
  const flat = [];
  for (const poly of polys) {
    let lp = null;
    for (const p of poly.concat(closed ? [poly[0]] : [])) {
      if (lp) { const d = Math.hypot(p[0] - lp[0], p[1] - lp[1], p[2] - lp[2]), n = Math.ceil(d / (S.detail * 0.5)); for (let k = 1; k < n; k++) flat.push(lp[0] + (p[0] - lp[0]) * k / n, lp[1] + (p[1] - lp[1]) * k / n, lp[2] + (p[2] - lp[2]) * k / n); }
      flat.push(p[0], p[1], p[2]); lp = p;
    }
  }
  toast(kind === 'lasso' ? 'Fitting the shape…' : 'Fitting the outline…', 20000);
  await new Promise(r => setTimeout(r, 20));
  const m0 = S.mesh, oldSel = S.sel;
  const carry = [m0.paint, m0.wall].concat(m0.part ? [m0.part] : []).concat(oldSel ? [oldSel.mask] : []);
  const res = C.refineNear(m0.verts, m0.tris, carry, flat, S.detail, MAX_TRIS);
  if (res.verts !== m0.verts) rebuild(res.verts, res.tris, res.carry[0], res.carry[1], m0.part ? res.carry[2] : null);
  const prevMask = oldSel ? res.carry[res.carry.length - 1] : null;
  const m = S.mesh;
  // 2. find each line's triangles on the refined mesh and chain them edge to edge
  const L = lift(), chains = [];
  let gaps = 0;
  for (const poly of polys) {
    const hits = [];
    for (const p of poly) { const h = surfaceHit(p[0], p[1], p[2]); if (h) hits.push(h); }
    if (closed && hits.length) hits.push(hits[0]);
    chains.push(hits);
  }
  if (kind === 'outline') {
    if (m.wall === m0.wall) m.wall = m.wall.slice(); // keep the undo snapshot's walls intact
    const newLines = [];
    for (const hits of chains) {
      for (let i = 0; i < hits.length - 1; i++) {
        const A = hits[i], B = hits[i + 1], sIdx = S.segs.length / 6;
        S.segs.push(A.x, A.y, A.z, B.x, B.y, B.z);
        const path = C.linkPath(m.adj, A.t, B.t, 6000);
        if (!path) { gaps++; continue; }
        for (const t of path) if (m.wall[t] < 0) m.wall[t] = sIdx;
      }
      const disp = new Float32Array(hits.length * 3);
      hits.forEach((h, i) => { disp[i * 3] = h.x + h.nx * L; disp[i * 3 + 1] = h.y + h.ny * L; disp[i * 3 + 2] = h.z + h.nz * L; });
      newLines.push(disp);
    }
    S.lines = S.lines.concat(newLines);
    setLiveLine(null); renderLines();
    endStroke(true);
    const msgs = [closed ? 'Closed outline' + (polys.length > 1 ? 's (mirrored)' : '') + '. Switch to Fill and tap inside.' : 'Outline added. Fill stops at it; draw back to the start to close a shape.'];
    if (mirrorMissed) msgs.push('The mirrored line was skipped: the model isn\'t symmetric there.');
    if (res.limited) msgs.push('The mesh hit its size limit, so the edge is coarser here.');
    if (gaps) msgs.push('The line crossed a gap in the model in ' + gaps + ' place' + (gaps > 1 ? 's' : '') + '; fills may leak there.');
    toast(msgs.join(' '), 4500);
    return;
  }
  // lasso: the area inside each closed shape
  let inside = [];
  for (const hits of chains) {
    const wall = new Int32Array(m.nT).fill(-1), segs = [];
    for (let i = 0; i < hits.length - 1; i++) {
      const A = hits[i], B = hits[i + 1], sIdx = segs.length / 6;
      segs.push(A.x, A.y, A.z, B.x, B.y, B.z);
      const path = C.linkPath(m.adj, A.t, B.t, 6000);
      if (path) for (const t of path) if (wall[t] < 0) wall[t] = sIdx;
    }
    const R = C.lassoRegion(m.adj, wall, segs, m.normals, m.cent, m.area);
    if (R) inside = inside.concat(R); else gaps++;
  }
  setLiveLine(null);
  const nUndo = S.undo.length;
  endStroke(); // records the mesh refinement (if any) as an undo step
  if (prevMask) { const list = []; for (let t = 0; t < prevMask.length; t++) if (prevMask[t]) list.push(t); S.sel = { mask: prevMask, list, color: oldSel.color }; }
  if (!inside.length) { toast('That shape didn\'t close around an area. Draw all the way around, back to the start.', 4500); if (S.sel) openSel(); return; }
  if (S.undo.length > nUndo) applySelectionNow(inside); else applySelection(inside); // one undo step per shape
  toast((S.selMode === 'add' ? 'Added to' : S.selMode === 'sub' ? 'Subtracted from' : 'Selected') + ' the shape' + (polys.length > 1 ? ' and its mirror' : '') + '. Paint fills it.' + (mirrorMissed ? ' (No mirror: the model isn\'t symmetric there.)' : ''), 3500);
}

// ---------------- pointer handling: Pencil/mouse paint, fingers navigate ----------------
let painting = null;
function isPaintPointer(e) {
  if (e.pointerType === 'pen') return true;
  if (e.pointerType === 'mouse') return e.button === 0 && !e.altKey;
  if (e.pointerType === 'touch') return S.finger;
  return false;
}
function radiusFor(e) {
  if (e.pointerType === 'pen' && S.pressure && e.pressure > 0) return S.size * (0.3 + 0.9 * Math.min(1, e.pressure));
  return S.size;
}
view.addEventListener('pointerdown', e => {
  if (S.tool === 'image') return; // the image tool leaves the view for turning the model
  if (!S.mesh || !isPaintPointer(e) || painting) return;
  if (S.busy) { toast('Still smoothing edges, one moment…'); return; }
  const hit = pick(e.clientX, e.clientY);
  if (!hit) return; // missed the model: the stroke turns the view instead
  e.stopPropagation(); e.preventDefault();
  if (S.checking) endChecks();
  clearPreview();
  if (S.symSetting) { setMirrorFromTap(hit.p); return; }
  beginStroke();
  if (S.tool === 'brush' || S.tool === 'outline') {
    painting = { id: e.pointerId, last: [e.clientX, e.clientY], touch: e.pointerType === 'touch' };
    if (S.tool === 'brush') {
      if (S.brushMode === 'soft') painting.soft = { amt: new Map(), state: new Map(), byPair: new Map() };
      else { painting.chains = [[], []]; painting.slot = S.slot; }
    }
    try { view.setPointerCapture(e.pointerId); } catch (_) {}
    if (S.tool === 'brush') { brushAt(hit, radiusFor(e)); placeRing(hit, radiusFor(e)); }
    else { hideRing(); startStreamline(e.clientX, e.clientY); }
  } else if (S.tool === 'select') {
    painting = { id: e.pointerId, last: [e.clientX, e.clientY], touch: e.pointerType === 'touch', lasso: true, moved: false, sx: e.clientX, sy: e.clientY, hitT: hit.t };
    try { view.setPointerCapture(e.pointerId); } catch (_) {}
  } else if (S.tool === 'parts') {
    if (!(S.parts && S.mesh.part)) { strokeBefore = null; ensureParts(); return; }
    const list = partTris(hit.t);
    applyTris(list);
    const before = S.undo.length;
    endStroke();
    if (S.undo.length === before && list.length) toast('That part is already ' + label(S.palette[S.slot - 1]) + '.', 2200);
  } else if (S.tool === 'fill' && S.fillMode === 'gradient') {
    const g = startGradient(hit);
    if (!g) { endStroke(); return; }
    painting = { id: e.pointerId, last: [e.clientX, e.clientY], touch: e.pointerType === 'touch', grad: g };
    try { view.setPointerCapture(e.pointerId); } catch (_) {}
  } else {
    applyTris(S.sel && S.sel.mask[hit.t] ? S.sel.list : region(hit.t).filter(inSel));
    endStroke();
  }
}, true);
view.addEventListener('pointermove', e => {
  if (painting && e.pointerId === painting.id) {
    e.stopPropagation();
    if (painting.grad) {
      const h = pick(e.clientX, e.clientY);
      if (h) { painting.grad.p1 = [h.p.x, h.p.y, h.p.z]; if (!painting.gradQueued) { painting.gradQueued = true; const pg = painting; requestAnimationFrame(() => { pg.gradQueued = false; if (pg.grad.p1) drawGradient(pg.grad); }); } }
      return;
    }
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const [lx, ly] = painting.last;
      const dx = ev.clientX - lx, dy = ev.clientY - ly;
      if (painting.lasso && !painting.moved) {
        if (Math.hypot(ev.clientX - painting.sx, ev.clientY - painting.sy) < 8) continue;
        painting.moved = true; hideRing(); clearPreview(); startStreamline(painting.sx, painting.sy);
      }
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (S.tool === 'outline' || painting.lasso ? 2 : 6)));
      for (let i = 1; i <= steps; i++) {
        const x = lx + dx * i / steps, y = ly + dy * i / steps;
        if (S.tool === 'outline' || painting.lasso) { streamTo(x, y); continue; }
        const hit = pick(x, y);
        if (hit) { const r = radiusFor(ev); brushAt(hit, r); if (i === steps) placeRing(hit, r); }
        else if (painting.chains) { painting.chains[0].push(null); painting.chains[1].push(null); }
      }
      painting.last = [ev.clientX, ev.clientY];
    }
    if ((S.tool === 'outline' || painting.lasso) && samples) setLiveLine(liveFromSamples());
    return;
  }
  if (e.buttons === 0 && (e.pointerType === 'mouse' || e.pointerType === 'pen') && S.mesh) hover(e.clientX, e.clientY);
}, true);
function stopPaint(e) {
  if (!painting || e.pointerId !== painting.id) return;
  const lastXY = painting.last, was = painting;
  painting = null;
  if (was.lasso) {
    if (!was.moved) { strokeBefore = null; selectAt(was.hitT); return; }
    if (brushPt && lastXY) streamCatchUp(lastXY[0], lastXY[1]);
    finishStroke('lasso'); return;
  }
  if (was.grad) { if (was.grad.p1) drawGradient(was.grad); finishGradient(was.grad); return; }
  if (S.tool === 'outline' && brushPt && lastXY) streamCatchUp(lastXY[0], lastXY[1]);
  if (S.tool === 'outline') finishOutline();
  else {
    if (was.soft) { const msk = new Uint8Array(S.mesh.nT); for (const t of was.soft.state.keys()) msk[t] = 1; const grown = refineShading(msk); despeckle(grown ? grownMask(msk) : msk); }
    if (was.chains) finishHardBrush(was); else endStroke();
    if (was.soft) renderPalette();
    if (e.pointerType !== 'mouse') hideRing();
  }
}
view.addEventListener('pointerup', stopPaint, true);
// Finger taps: two fingers = undo, three fingers = redo (taps only: no movement, quick).
const taps = { pts: new Map(), max: 0, start: 0, moved: false };
view.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  if (!taps.pts.size) { taps.max = 0; taps.start = performance.now(); taps.moved = false; }
  taps.pts.set(e.pointerId, [e.clientX, e.clientY]);
  taps.max = Math.max(taps.max, taps.pts.size);
  // a second finger landing right after the first cancels a finger-paint stroke that just started
  if (taps.pts.size >= 2 && painting && painting.touch && performance.now() - taps.start < 200) cancelFingerStroke();
}, true);
view.addEventListener('pointermove', e => {
  const p = e.pointerType === 'touch' && taps.pts.get(e.pointerId);
  if (p && Math.hypot(e.clientX - p[0], e.clientY - p[1]) > 12) taps.moved = true;
}, true);
function tapEnd(e) {
  if (e.pointerType !== 'touch' || !taps.pts.has(e.pointerId)) return;
  taps.pts.delete(e.pointerId);
  if (taps.pts.size) return;
  const quick = performance.now() - taps.start < 350;
  if (quick && !taps.moved && taps.max === 2) { if (S.undo.length) { undo(); toast('Undo', 900); } }
  else if (quick && !taps.moved && taps.max === 3) { if (S.redo.length) { redo(); toast('Redo', 900); } }
}
view.addEventListener('pointerup', tapEnd, true);
view.addEventListener('pointercancel', tapEnd, true);
function cancelFingerStroke() {
  const before = S.undo.length;
  painting = null; samples = null; strokeScreen = null; brushPt = null; setLiveLine(null); hideRing();
  endStroke();
  if (S.undo.length > before) { undo(); S.redo.pop(); updateUndo(); }
}
view.addEventListener('pointercancel', stopPaint, true);
view.addEventListener('pointerleave', e => { if (!painting && e.pointerType !== 'touch') { hideRing(); clearPreview(); } });
view.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());

// ---------------- collapsible panels ----------------
function setCollapsed(id, on) {
  $(id).classList.toggle('min', on);
  store('labcraft.min.' + id, on);
  $(id + 'Min').setAttribute('aria-label', (on ? 'Expand ' : 'Collapse ') + (id === 'tools' ? 'tools' : 'filaments'));
  $(id + 'Min').classList.toggle('flip', on);
}
for (const id of ['tools', 'palette']) {
  $(id + 'Min').onclick = () => setCollapsed(id, !$(id).classList.contains('min'));
  setCollapsed(id, load('labcraft.min.' + id, false));
}

// ---------------- tools UI ----------------
const HINTS = {
  brush: 'Pencil paints, fingers turn and zoom. With a mouse: left paints, right drag turns, shift + right drag pans.',
  outline: 'Draw a line on the model; Fill stops at it. End near where you started to close the shape. Streamline smooths out hand wobble (higher = smoother, slightly less exact). Smaller line detail = crisper color edge.',
  fill: 'Tap to fill an area. It stops at your outlines, and at sharp edges when that switch is on. Hover with Pencil or mouse to preview first.',
  image: 'Choose an image, then drag it to move it; pinch, twist or drag the blue handle to resize and turn it. Touch outside the image (or Lock it) to turn the model. Apply projects it onto the surfaces facing you; see-through parts of a PNG keep the paint underneath, and a selection limits where it goes.',
  parts: 'Lines + folds: areas inside sculpted outlines (raised details keep their sides, engraved lines get their own strip), plus pieces like arms and legs split where they join. Shape: only where the surface folds. Tap a part to paint it; use Outline for details with no sculpted line.',
  soft: 'Soft brush shades toward the current color a little more each pass. Paint with the area\'s own color to fade shading back. Shading prints as a few mixes (Shade steps), finely speckled so the steps blend.',
  gradient: 'Start on a color and drag: that color area (only that color) shades from its own color where you start to the current color where you lift. Inside a selection, the selection is used instead. Smooth up/down lets Bambu Studio blend layer by layer (plain filaments only, bottom-to-top).',
  select: 'Tap a color area to select it, or draw around an area to select a shape (Streamline smooths your stroke). Use + Add / − Subtract to build a shape from several strokes, then Paint fills it, or switch to Brush or Fill to paint inside it.',
  selectOld: 'Tap a color area to select it, or draw around an area to select a shape. Use + Add / − Subtract to build a shape from several strokes, then Paint fills it.'
};
function refreshRows() {
  const tool = S.tool, show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
  show('rowImgMixes', tool === 'image' && S.imgColors === 'mix');
  show('rowAngle', tool === 'fill' && S.edges && S.fillMode === 'solid');
  show('rowEdges', tool === 'fill' && S.fillMode === 'solid');
  show('rowFlow', tool === 'brush' && S.brushMode === 'soft');
  show('rowSteps', (tool === 'brush' && S.brushMode === 'soft') || (tool === 'fill' && S.fillMode === 'gradient'));
  show('rowSmoothGrad', tool === 'fill' && S.fillMode === 'gradient' && !isTC());
  show('symPlace', ['brush', 'outline', 'select'].includes(tool) && S.sym !== 'off');
  $('hint').textContent = tool === 'brush' && S.brushMode === 'soft' ? HINTS.soft : tool === 'fill' && S.fillMode === 'gradient' ? HINTS.gradient : HINTS[tool];
}
function selectTool(tool) {
  S.tool = tool;
  document.querySelectorAll('#toolSeg button').forEach(x => x.classList.toggle('on', x.dataset.tool === tool));
  document.querySelectorAll('#tools [data-for]').forEach(el => { el.style.display = el.dataset.for.split(' ').includes(tool) ? '' : 'none'; });
  refreshRows();
  clearPreview(); hideRing();
  if (S.sel && !['select', 'brush', 'fill', 'image'].includes(tool)) { const prev = selState(); endSel(); selStep(prev); }
  try { showDecal(); } catch (_) {}
  if (S.sel) { openSel(); updateSelOutline(); if (tool !== 'select') toast('Painting stays inside the selection. Tap Done to paint anywhere.', 3000); }
  try { if (S.symSetting && !['brush', 'outline', 'select'].includes(tool)) setSymSetting(false); updateSymPlane(); } catch (_) {}
  refreshRows();
  if (S.mesh) { recolorAll(); if (tool === 'parts') ensureParts(); }
  updatePartsUI(); try { updatePartLines(); } catch (_) {}
}
document.querySelectorAll('#toolSeg button').forEach(b => b.onclick = () => selectTool(b.dataset.tool));
$('size').oninput = e => { S.size = +e.target.value; $('sizeVal').textContent = S.size + ' mm'; };
$('angle').oninput = e => { S.angle = +e.target.value; $('angleVal').textContent = S.angle + '°'; clearPreview(); };
$('detail').oninput = e => { S.detail = +e.target.value; $('detailVal').textContent = S.detail + ' mm'; };
$('stream').oninput = e => { S.stream = +e.target.value; $('streamVal').textContent = S.stream + '%'; store('labcraft.stream', S.stream); };
$('stream').value = S.stream; $('streamVal').textContent = S.stream + '%';
$('tEdges').classList.toggle('on', S.edges);
$('tEdges').onclick = e => { S.edges = !S.edges; store('labcraft.edges', S.edges); e.currentTarget.classList.toggle('on', S.edges); refreshRows(); clearPreview(); };
const segPick = (id, attr, key, after) => {
  const btns = document.querySelectorAll('#' + id + ' button');
  const set = v => { S[key] = v; store('labcraft.' + key, v); btns.forEach(x => x.classList.toggle('on', x.dataset[attr] === v)); refreshRows(); if (after) after(v); };
  btns.forEach(x => x.onclick = () => set(x.dataset[attr]));
  btns.forEach(x => x.classList.toggle('on', x.dataset[attr] === S[key]));
};
segPick('brushModeSeg', 'b', 'brushMode', () => clearPreview());
segPick('fillModeSeg', 'f', 'fillMode', () => clearPreview());
$('flow').value = S.flow; $('flowVal').textContent = S.flow + '%';
$('flow').oninput = e => { S.flow = +e.target.value; store('labcraft.flow', S.flow); $('flowVal').textContent = S.flow + '%'; };
$('shSteps').value = S.shSteps; $('stepsVal').textContent = S.shSteps;
$('shSteps').oninput = e => { S.shSteps = +e.target.value; store('labcraft.shSteps', S.shSteps); $('stepsVal').textContent = S.shSteps; };
$('tSmoothGrad').classList.toggle('on', S.smoothGrad);
$('tSmoothGrad').onclick = e => { S.smoothGrad = !S.smoothGrad; store('labcraft.smoothGrad', S.smoothGrad); e.currentTarget.classList.toggle('on', S.smoothGrad); };
$('tPressure').onclick = e => { S.pressure = !S.pressure; e.currentTarget.classList.toggle('on', S.pressure); };
$('tFinger').onclick = e => {
  S.finger = !S.finger; e.currentTarget.classList.toggle('on', S.finger);
  toast(S.finger ? 'Fingers now paint. Use two fingers to turn and zoom.' : 'Fingers turn and zoom again; Pencil paints.');
  controls.touches = S.finger ? { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
};
$('bUndo').onclick = undo; $('bRedo').onclick = redo;
function pickSym(v) {
  S.sym = v; document.querySelectorAll('#symSeg button').forEach(x => x.classList.toggle('on', x.dataset.s === v));
  try { refreshRows(); } catch (_) {}
  if (v === 'off' && S.symSetting) setSymSetting(false);
  updateSymPlane();
}
document.querySelectorAll('#symSeg button').forEach(b => b.onclick = () => {
  pickSym(b.dataset.s);
  if (S.sym !== 'off') toast('Symmetry ' + (S.sym === 'x' ? 'left/right' : 'front/back') + ': strokes are mirrored across the blue plane. Use Place mirror to move it.', 3500);
});
$('bSymSet').onclick = () => setSymSetting(!S.symSetting);
$('bSymCenter').onclick = () => { S.symCtr = null; S.symTaps = []; updateSymPlane(); toast('Mirror back at the model\'s center.'); };
pickSym('off');
document.querySelectorAll('#selModeSeg button').forEach(b => b.onclick = () => {
  S.selMode = b.dataset.m; document.querySelectorAll('#selModeSeg button').forEach(x => x.classList.toggle('on', x === b));
});
const sw = (id, key, fn) => { $(id).classList.toggle('on', S[key]); $(id).onclick = () => { S[key] = !S[key]; store('labcraft.' + key, S[key]); $(id).classList.toggle('on', S[key]); fn(); }; };
sw('tFree', 'free', () => { setFree(S.free); toast(S.free ? 'Free rotate: one finger tumbles the model any way. Fit view sets it upright again.' : 'Turntable: the model stays upright.', 3500); });
sw('tCreases', 'creases', updateViewAids);
sw('tCavity', 'cavity', updateViewAids);
setFree(S.free);
$('bFit').onclick = fitView;
$('bFillAll').onclick = () => { beginStroke(); applyTris(Array.from({ length: S.mesh.nT }, (_, i) => i)); endStroke(); };
$('bClearLines').onclick = () => {
  beginStroke();
  S.mesh.wall = new Int32Array(S.mesh.nT).fill(-1);
  S.lines = []; renderLines(); clearPreview();
  endStroke(true);
  toast('Outlines cleared. Your paint and the finer mesh stay; undo brings the lines back.');
};
$('bRefine').onclick = () => {
  const m = S.mesh;
  if (m.nT * 4 > MAX_TRIS) { toast('Refining would make ' + (m.nT * 4).toLocaleString() + ' triangles, too many for a tablet browser.'); return; }
  clearPreview(); beginStroke();
  const s = C.subdivide(m.verts, m.tris, m.paint, [m.wall].concat(m.part ? [m.part] : []));
  rebuild(s.verts, s.tris, s.paint, s.extra[0], m.part ? s.extra[1] : null);
  endStroke(true);
  toast('Mesh refined to ' + S.mesh.nT.toLocaleString() + ' triangles for finer painting.');
};
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === 'b') selectTool('brush');

  else if (e.key === 'f') selectTool('fill');
  else if (e.key === 's' || e.key === 'r') selectTool('select');
  else if (e.key === '[' || e.key === ']') { const v = Math.max(0.4, S.size * (e.key === ']' ? 1.2 : 1 / 1.2)); S.size = +v.toFixed(1); $('size').value = S.size; $('sizeVal').textContent = S.size + ' mm'; }
  else if (/^[1-9]$/.test(e.key) && +e.key <= S.palette.length) { S.slot = +e.key; renderPalette(); status(); }
});

// ---------------- parts ----------------
let partBuckets = null, segWorker = null, partsBusy = false;
function updatePartsUI() {
  const p = S.parts;
  $('partsN').disabled = !p;
  if (p) {
    $('partsN').min = p.min; $('partsN').max = p.max; $('partsN').value = p.count;
    $('partsVal').textContent = p.count;
  } else $('partsVal').textContent = partsBusy ? 'finding…' : '–';
}
// Heavy jobs run in a background worker built from the same core code, so the page stays responsive.
let jobId = 0; const jobs = new Map();
function coreWorker() {
  if (segWorker) return segWorker;
  const src = document.getElementById('coreSrc').textContent + `
self.onmessage = function (e) {
  var d = e.data, a = d.a, r, tr = [];
  try {
    if (d.op === 'seg') { r = a.method === 'lines' ? LabCore.segmentCombined(a.verts, a.tris, a.adj, a.normals, a.cent, a.area) : LabCore.segmentParts(a.verts, a.tris, a.adj, a.normals, a.cent, a.area); tr = [r.base.buffer, r.merges.buffer, r.costs.buffer]; }
    else if (d.op === 'clean') { r = LabCore.cleanEdges(a.verts, a.tris, a.paint, a.extra, a.opts);
      if (r) { var seen = new Set(); [r.verts, r.tris, r.paint].concat(r.carry).forEach(function (x) { if (!seen.has(x.buffer)) { seen.add(x.buffer); tr.push(x.buffer); } }); } }
    self.postMessage({ id: d.id, r: r }, tr);
  } catch (err) { self.postMessage({ id: d.id, error: String(err && err.message || err) }); }
};`;
  segWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  segWorker.onmessage = e => { const j = jobs.get(e.data.id); if (!j) return; jobs.delete(e.data.id); e.data.error ? j.fail(e.data.error) : j.done(e.data.r); };
  segWorker.onerror = e => { if (e.preventDefault) e.preventDefault(); const w = segWorker; segWorker = null; for (const [id, j] of jobs) { jobs.delete(id); j.fail('worker'); } try { w.terminate(); } catch (_) {} };
  return segWorker;
}
function runJob(op, a, fallback) {
  return new Promise(resolve => {
    let w;
    try { w = coreWorker(); } catch (err) { segWorker = null; resolve(fallback()); return; }
    const id = ++jobId;
    jobs.set(id, { done: resolve, fail: () => resolve(fallback()) });
    w.postMessage({ id, op, a });
  });
}
function runSegmentation(m, method) {
  return runJob('seg', { method, verts: m.verts, tris: m.tris, adj: m.adj, normals: m.normals, cent: m.cent, area: m.area },
    () => method === 'lines' ? C.segmentCombined(m.verts, m.tris, m.adj, m.normals, m.cent, m.area) : C.segmentParts(m.verts, m.tris, m.adj, m.normals, m.cent, m.area));
}
async function ensureParts() {
  const m = S.mesh;
  if (!m || partsBusy || (S.parts && m.part)) return;
  partsBusy = true; updatePartsUI();
  toast('Finding parts…', 60000);
  const method = S.partsMethod;
  const r = await runSegmentation(m, method);
  partsBusy = false;
  if (S.mesh !== m || r.base.length !== m.nT || method !== S.partsMethod) { updatePartsUI(); if (method !== S.partsMethod) ensureParts(); return; }
  m.part = r.base;
  const minParts = Math.max(1, r.nBase - r.costs.length);
  const count = method === 'lines' ? C.suggestCombined(r.nBase, r.costs) : C.suggestParts(r.nBase, r.costs);
  S.parts = { nBase: r.nBase, merges: r.merges, costs: r.costs, min: minParts, max: Math.max(minParts + 1, Math.min(r.nBase, method === 'lines' ? Math.max(150, count + 50) : 60)), count };
  setPartCount(count);
  toast('Found ' + count + ' parts' + (method === 'lines' ? ' from sculpted lines and folds' : '') + '. Use the slider for bigger or smaller pieces, and tap a part to paint it.', 5000);
}
function setPartCount(n) {
  const p = S.parts; if (!p) return;
  const r = C.partLabels(p.nBase, p.merges, n);
  p.map = r.map; p.count = r.count; partBuckets = null;
  clearPreview(); updatePartsUI(); recolorAll(); updatePartLines();
}
function buildBuckets() {
  const m = S.mesh, map = S.parts.map, n = S.parts.count;
  const start = new Int32Array(n + 1), lab = new Int32Array(m.nT);
  for (let t = 0; t < m.nT; t++) { lab[t] = map[m.part[t]]; start[lab[t] + 1]++; }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n), list = new Int32Array(m.nT);
  for (let t = 0; t < m.nT; t++) list[fill[lab[t]]++] = t;
  partBuckets = { start, list, lab };
}
function partTris(t) {
  if (!S.parts || !S.mesh.part) return [];
  if (!partBuckets) buildBuckets();
  const L = partBuckets.lab[t];
  return Array.from(partBuckets.list.subarray(partBuckets.start[L], partBuckets.start[L + 1]));
}
$('partsN').oninput = e => setPartCount(+e.target.value);
document.querySelectorAll('#splitSeg button').forEach(b => b.onclick = () => {
  if (S.partsMethod === b.dataset.m) return;
  S.partsMethod = b.dataset.m;
  document.querySelectorAll('#splitSeg button').forEach(x => x.classList.toggle('on', x === b));
  for (const st of S.undo.concat(S.redo)) st.part = null;
  if (S.mesh) { S.mesh.part = null; S.parts = null; partBuckets = null; updatePartLines(); ensureParts(); }
});
$('tShowParts').onclick = e => { S.showParts = !S.showParts; e.currentTarget.classList.toggle('on', S.showParts); updatePartLines(); };

// part outlines: thin lines along every border between parts (colours stay exactly as painted)
const partLineMat = new LineMaterial({ color: 0x15171a, linewidth: 1.4, worldUnits: false, transparent: true, opacity: 0.8 });
let partLines = null, partLinesKey = null;
function updatePartLines() {
  const m = S.mesh;
  const want = m && S.tool === 'parts' && S.showParts && S.parts && m.part;
  const key = want ? [m.verts.length, m.tris.length, S.parts.count, S.parts.nBase, S.partsMethod, m.part.length].join('/') + (m.tris === (partLines && partLines.userData.tris) ? '' : '*') : null;
  if (!want) { if (partLines) partLines.visible = false; needRender = true; return; }
  if (partLines && partLinesKey === key && partLines.userData.tris === m.tris && partLines.userData.part === m.part) { partLines.visible = true; needRender = true; return; }
  if (partLines) { scene.remove(partLines); partLines.geometry.dispose(); partLines = null; }
  const map = S.parts.map, pos = [], L = lift();
  for (let t = 0; t < m.nT; t++) for (let e = 0; e < 3; e++) {
    const n = m.adj[t * 3 + e];
    if (n <= t || map[m.part[t]] === map[m.part[n]]) continue;
    const a = m.tris[t * 3 + e] * 3, b = m.tris[t * 3 + (e + 1) % 3] * 3;
    const nx = (m.normals[t * 3] + m.normals[n * 3]) * L, ny = (m.normals[t * 3 + 1] + m.normals[n * 3 + 1]) * L, nz = (m.normals[t * 3 + 2] + m.normals[n * 3 + 2]) * L;
    pos.push(m.verts[a] + nx, m.verts[a + 1] + ny, m.verts[a + 2] + nz, m.verts[b] + nx, m.verts[b + 1] + ny, m.verts[b + 2] + nz);
  }
  partLineMat.resolution.set(view.clientWidth, view.clientHeight);
  const g = new LineSegmentsGeometry(); g.setPositions(pos);
  partLines = new LineSegments2(g, partLineMat); partLines.renderOrder = 4;
  partLines.userData = { tris: m.tris, part: m.part };
  partLinesKey = key; scene.add(partLines); needRender = true;
}

// ---------------- select: region editing ----------------
function setSel(list, color) {
  const m = S.mesh, mask = new Uint8Array(m.nT);
  for (const t of list) mask[t] = 1;
  const old = S.sel; S.sel = { mask, list, color };
  if (old) for (const t of old.list) if (!mask[t] && t < m.nT) triColor(t, paintColor(t));
  for (const t of list) triColor(t, paintColor(t));
  openSel(); try { updateSelOutline(); } catch (_) {}
}
function selectAt(t) {
  clearPreview();
  const R = region(t);
  if (!R.length) return;
  applySelection(R);
}
// Combine a new area with the current selection: New replaces, Add unions, Subtract removes.
function applySelection(list) {
  const prev = selState();
  applySelectionNow(list);
  selStep(prev);
}
function applySelectionNow(list) {
  const m = S.mesh, old = S.sel, mode = S.selMode;
  const mask = new Uint8Array(m.nT);
  if (old && mode !== 'new' && old.mask.length === m.nT) mask.set(old.mask);
  for (const t of list) mask[t] = mode === 'sub' ? 0 : 1;
  const out = []; for (let t = 0; t < m.nT; t++) if (mask[t]) out.push(t);
  if (!out.length) { endSel(); return; }
  const cnt = new Map(); for (const t of out) cnt.set(m.paint[t], (cnt.get(m.paint[t]) || 0) + 1);
  let color = 1, best = -1; for (const [c, n] of cnt) if (n > best) { best = n; color = c; }
  setSel(out, color);
}
function openSel() {
  const s = S.sel; if (!s) return closeSel();
  let a = 0, tot = 0; const m = S.mesh;
  for (let t = 0; t < m.nT; t++) tot += m.area[t];
  for (const t of s.list) a += m.area[t];
  const p = S.palette[s.color - 1];
  $('selInfo').textContent = (p ? label(p) : 'Area') + ' · ' + (100 * a / tot).toFixed(a / tot < 0.01 ? 2 : 1) + '% of surface';
  $('sDot').style.background = S.palette[S.slot - 1] ? S.palette[S.slot - 1].color : '#999';
  $('sPaint').lastChild.textContent = 'Paint ' + (S.palette[S.slot - 1] ? label(S.palette[S.slot - 1]) : '');
  // grow, shrink, same colour and merge only make sense when the selection is one colour
  const uniform = s.list.every(t => m.paint[t] === s.color);
  for (const id of ['sGrow', 'sShrink', 'sAll', 'sMerge']) $(id).style.display = uniform ? '' : 'none';
  if (!uniform) $('selInfo').textContent = 'Shape · ' + (100 * a / tot).toFixed(a / tot < 0.01 ? 2 : 1) + '% of surface';
  $('selbar').classList.add('open');
}
function closeSel() { $('selbar').classList.remove('open'); }
function endSel() { const s = S.sel; S.sel = null; closeSel(); try { updateSelOutline(); } catch (_) {} if (s && S.mesh) for (const t of s.list) if (t < S.mesh.nT) triColor(t, paintColor(t)); }
$('sDone').onclick = () => { const prev = selState(); endSel(); selStep(prev); };
$('sPaint').onclick = () => {
  const s = S.sel; if (!s) return;
  beginStroke(); applyTris(s.list); s.color = S.slot; for (const t of s.list) triColor(t, paintColor(t)); endStroke(); openSel();
};
$('sGrow').onclick = () => {
  const s = S.sel, m = S.mesh; if (!s) return;
  beginStroke();
  const add = C.growSel(m.adj, m.cent, s.list, s.mask, S.step, m.wall);
  for (const t of add) { m.paint[t] = s.color; s.mask[t] = 1; s.list.push(t); triColor(t, paintColor(t)); }
  endStroke(); openSel();
  if (!add.length) toast('Nothing to grow into here (an outline or the edge of the model is in the way).');
};
$('sShrink').onclick = () => {
  const s = S.sel, m = S.mesh; if (!s) return;
  const out = C.shrinkSel(m.adj, m.cent, s.list, s.mask, m.paint, S.step);
  if (out.length >= s.list.length) { toast('Shrinking would remove this whole area. Use a smaller step, or Merge into surroundings to remove it.', 5000); return; }
  beginStroke();
  for (const [t, c] of out) { m.paint[t] = c; s.mask[t] = 0; }
  s.list = s.list.filter(t => s.mask[t]);
  for (const [t] of out) triColor(t, paintColor(t));
  endStroke(); openSel();
};
$('sAll').onclick = () => {
  const s = S.sel, m = S.mesh; if (!s) return;
  const list = []; for (let t = 0; t < m.nT; t++) if (m.paint[t] === s.color) list.push(t);
  setSel(list, s.color);
  toast('Selected every ' + label(S.palette[s.color - 1]) + ' area on the model.');
};
$('sMerge').onclick = () => {
  const s = S.sel, m = S.mesh; if (!s) return;
  const votes = {};
  for (const t of s.list) for (let e = 0; e < 3; e++) { const n = m.adj[t * 3 + e]; if (n >= 0 && !s.mask[n]) votes[m.paint[n]] = (votes[m.paint[n]] || 0) + 1; }
  let best = 0, bn = 0; for (const c in votes) if (votes[c] > bn) { bn = votes[c]; best = +c; }
  if (!best) { toast('This area has no other color around it.'); return; }
  beginStroke();
  for (const t of s.list) m.paint[t] = best;
  const list = s.list; S.sel = null; closeSel();
  for (const t of list) triColor(t, paintColor(t));
  endStroke();
  toast('Merged into ' + label(S.palette[best - 1]) + '.');
};
async function smoothEdges(mask) {
  const m = S.mesh; if (!m) return null;
  if (S.busy) return null;
  clearPreview(); hideRing();
  toast('Smoothing color edges…', 120000);
  await new Promise(r => setTimeout(r, 30));
  const extra = [m.wall].concat(m.part ? [m.part] : []).concat(mask ? [mask] : []);
  const opts = { smoothLen: [0.5, 1.5, 3][S.smooth - 1], detail: S.detail, maxTris: MAX_TRIS, mask };
  S.busy = true;
  const res = await runJob('clean', { verts: m.verts, tris: m.tris, paint: m.paint, extra, opts }, () => C.cleanEdges(m.verts, m.tris, m.paint, extra, opts));
  S.busy = false;
  if (S.mesh !== m) return null;
  if (!res || !res.changed) { toast('Nothing to smooth here. Edges along sharp creases and corners are kept as they are.', 4500); return null; }
  beginStroke();
  rebuild(res.verts, res.tris, res.paint, res.carry[0], m.part ? res.carry[1] : null);
  endStroke(true);
  toast('Smoothed ' + res.chains + ' color edge' + (res.chains === 1 ? '' : 's') + (res.limited ? '. The mesh hit its size limit, so some edges are coarser.' : '.') + ' Undo if you prefer the old edges.', 5000);
  return mask ? res.carry[res.carry.length - 1] : null;
}
$('bSmoothAll').onclick = () => { if (S.sel) endSel(); smoothEdges(null); };
$('sSmooth').onclick = async () => {
  const s = S.sel; if (!s) return;
  const color = s.color;
  S.sel = null; closeSel();
  const mask = await smoothEdges(s.mask);
  if (mask) { const list = []; for (let t = 0; t < mask.length; t++) if (mask[t] && S.mesh.paint[t] === color) list.push(t); if (list.length) setSel(list, color); }
  else if (s.list.every(t => t < S.mesh.nT)) setSel(s.list, color);
};
$('step').oninput = e => { S.step = +e.target.value; $('stepVal').textContent = S.step + ' mm'; };
$('smooth').oninput = e => { S.smooth = +e.target.value; $('smoothVal').textContent = ['Light', 'Medium', 'Strong'][S.smooth - 1]; };

// ---------------- loading files ----------------
async function readZip(buf) {
  const zip = await JSZip.loadAsync(buf);
  const files = {};
  for (const p of Object.keys(zip.files)) {
    const f = zip.files[p]; if (f.dir) continue;
    files[p] = /\.(model|config|xml|rels|json)$/i.test(p) ? await f.async('string') : await f.async('uint8array');
  }
  return files;
}
function samePalette(a, b) {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.color === b[i].color && p.mixed === b[i].mixed);
}
function askPalette(filePal) {
  return new Promise(resolve => {
    const dots = pal => pal.map(p => '<span title="' + p.slot + '" style="background:' + p.color + '"></span>').join('');
    $('impFile').innerHTML = dots(filePal); $('impMine').innerHTML = dots(S.palette);
    $('impNote').textContent = 'Keeping yours matches each of the file\'s ' + filePal.length + ' filaments to your closest color.';
    $('importSheet').classList.add('open');
    $('iFile').onclick = () => { $('importSheet').classList.remove('open'); resolve('file'); };
    $('iMine').onclick = () => { $('importSheet').classList.remove('open'); resolve('mine'); };
  });
}
async function openModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['stl', '3mf'].includes(ext)) { toast('Please choose an .stl or .3mf file'); return; }
  toast('Loading ' + file.name + '…', 60000);
  await new Promise(r => setTimeout(r, 30));
  try {
    const buf = await file.arrayBuffer();
    let res, msgs = [];
    if (ext === 'stl') res = C.parseSTL(buf);
    else {
      const files = await readZip(buf);
      res = C.parse3MF(files);
      if (res.settings && res.paint) {
        const filePal = C.parsePalette(res.settings);
        learnMixColors(filePal);
        if (!samePalette(filePal, S.palette)) {
          $('toast').classList.remove('show');
          const choice = await askPalette(filePal);
          if (choice === 'file') { setTemplate(templateOf(files), file.name.replace(/\.3mf$/i, ''), false); msgs.push('Painting with this file\'s filaments (Palette brings yours back)'); }
          else {
            const map = filePal.map(p => C.nearestSlot(p.color, S.palette));
            res.paint = res.paint.map(v => v ? map[v - 1] || 1 : 0);
            msgs.push('Matched the file\'s colors to your filaments');
          }
        }
      } else if (res.triColors) {
        const memo = {};
        res.paint = Uint8Array.from(res.triColors, h => h ? (memo[h] || (memo[h] = C.nearestSlot(h, S.palette))) : 1);
        msgs.push('Matched the file\'s ' + Object.keys(memo).length + ' colors to your nearest filaments');
      }
      if (res.skippedParts) msgs.push('left out ' + res.skippedParts + ' modifier part' + (res.skippedParts > 1 ? 's' : ''));
    }
    const nT0 = res.positions.length / 9;
    if (!nT0) throw new Error('No triangles found');
    if (nT0 > MAX_TRIS) throw new Error('This model has ' + nT0.toLocaleString() + ' triangles, more than a tablet browser can paint smoothly. Simplify it first.');
    const w = C.weld(res.positions);
    let paint;
    if (res.paint) {
      paint = w.kept ? Uint8Array.from(w.kept, i => res.paint[i]) : Uint8Array.from(res.paint);
      for (let i = 0; i < paint.length; i++) if (!paint[i] || paint[i] > S.palette.length) paint[i] = 1;
    } else {
      paint = new Uint8Array(w.tris.length / 3).fill(1);
      msgs.push('Everything starts as filament 1 (' + label(S.palette[0]) + '). Pick a color and tap Fill all to change the base');
    }
    if (res.simplified) msgs.push('fine paint detail inside triangles was simplified to whole triangles');
    S.name = file.name.replace(/\.(stl|3mf)$/i, '');
    setMesh(w.verts, w.tris, paint);
    toast(msgs.join('; ') || 'Loaded ' + file.name, 5500);
  } catch (err) {
    console.error(err); toast('Could not open that file: ' + err.message, 6000);
  }
}
async function openPaletteFile(file) {
  if (!/\.3mf$/i.test(file.name)) { toast('Choose a Bambu Studio project (.3mf)'); return; }
  try {
    const files = await readZip(await file.arrayBuffer());
    if (typeof files['Metadata/project_settings.config'] !== 'string') throw new Error('that 3MF has no Bambu project settings in it. Save it from Bambu Studio as a project.');
    setTemplate(templateOf(files), file.name.replace(/\.3mf$/i, ''), true);
    toast('Palette loaded: ' + S.palette.length + ' filaments (' + S.palette.filter(p => p.mixed).length + ' mixes). It will be remembered on this device.', 5000);
  } catch (err) { toast('Could not read palette: ' + err.message, 6000); }
}
$('bOpen').onclick = $('eOpen').onclick = () => $('fModel').click();
$('fModel').onchange = e => { const f = e.target.files[0]; if (f) openModelFile(f); e.target.value = ''; };
$('bPalette').onclick = () => {
  const mixes = S.palette.filter(p => p.mixed).length;
  $('plNow').textContent = 'now ' + (S.palette.length - mixes) + ' filament' + (S.palette.length - mixes === 1 ? '' : 's') + (mixes ? ' and ' + mixes + ' mix' + (mixes === 1 ? '' : 'es') : '') + ', from ' + S.palSource;
  $('palLoadSheet').classList.add('open');
};
$('bAbout').onclick = () => $('aboutSheet').classList.add('open');
$('aboutClose').onclick = () => $('aboutSheet').classList.remove('open');
$('aboutSheet').addEventListener('click', e => { if (e.target.id === 'aboutSheet') $('aboutSheet').classList.remove('open'); });
$('plCancel').onclick = () => $('palLoadSheet').classList.remove('open');
$('palLoadSheet').addEventListener('click', e => { if (e.target.id === 'palLoadSheet') $('palLoadSheet').classList.remove('open'); });
$('plGo').onclick = () => { $('palLoadSheet').classList.remove('open'); $('fPalette').click(); };
$('fPalette').onchange = e => { const f = e.target.files[0]; if (f) openPaletteFile(f); e.target.value = ''; };
window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('drop'); });
window.addEventListener('dragleave', () => document.body.classList.remove('drop'));
window.addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('drop'); const f = e.dataTransfer.files[0]; if (f) openModelFile(f); });

// sample: Sarah's octopus in a beret (packed mesh); if it can't be loaded, the app builds a simpler one itself
/**
 * Load the "Try a sample" mesh: Sarah's octopus, packed as a zip of mesh.json (counts and bounds),
 * verts.u16 (positions quantised to 16 bits within the bounds, < 0.001 mm error) and tris.i32
 * (triangle indices delta-coded, which compresses well). Tries artifact storage (Claude-hosted copy)
 * then samples/octopus.zip (public site); falls back to the procedural LabSample.octopus().
 * @returns {Promise<{verts: Float32Array, tris: Uint32Array}>}
 */
async function loadSampleMesh() {
  for (const u of ['/_blob/220e57c94cc6b0ca291e464433ece6c5', 'samples/octopus.zip']) {
    try {
      const r = await fetch(u); if (!r.ok) continue;
      const z = await JSZip.loadAsync(await r.arrayBuffer());
      const h = JSON.parse(await z.file('mesh.json').async('string'));
      const q = new Uint16Array(await z.file('verts.u16').async('arraybuffer')), d = new Int32Array(await z.file('tris.i32').async('arraybuffer'));
      const verts = new Float32Array(h.nV * 3), tris = new Uint32Array(h.nT * 3);
      for (let i = 0; i < h.nV; i++) for (let k = 0; k < 3; k++) verts[i * 3 + k] = h.min[k] + q[i * 3 + k] / 65535 * (h.max[k] - h.min[k]);
      let prev = 0; for (let i = 0; i < d.length; i++) { prev += d[i]; tris[i] = prev; }
      return { verts, tris };
    } catch (_) { /* try the next place */ }
  }
  return window.LabSample.octopus();
}
$('eSample').onclick = async () => {
  $('eSample').disabled = true;
  try {
    const m = await loadSampleMesh();
    const paint = new Uint8Array(m.tris.length / 3).fill(Math.min(5, S.palette.length)); // start white so colors show up
    S.name = 'Sample octopus';
    setMesh(m.verts, m.tris, paint);
    toast('Try it: Fill his beret and eyes, shade his head with the Soft brush, or put an image on him.', 5000);
  } finally { $('eSample').disabled = false; }
};

// ---------------- print checks ----------------
function computeChecks() {
  const m = S.mesh, minA = +$('islandMin').value;
  const near = (a, b) => { // shading specks: one color is a mix of the other plus something
    const ra = recipeOf(a), rb = recipeOf(b); if (!ra || !rb) return false;
    const ka = Object.keys(ra), kb = Object.keys(rb);
    if (ka.length === kb.length && ka.length === 1) return false;
    const [sm, lg] = ka.length <= kb.length ? [ka, rb] : [kb, ra];
    return sm.every(k => lg[k] != null);
  };
  const islands = C.findIslands(m.adj, m.paint, m.area, minA).filter(i => !near(i.color, i.surround));
  const flat = [];
  for (let t = 0; t < m.nT; t++) {
    const p = S.palette[m.paint[t] - 1];
    if (p && p.mixed && Math.abs(m.normals[t * 3 + 2]) > 0.5) flat.push(t);
  }
  return { islands, flat };
}
let lastChecks = null;
$('bCheck').onclick = () => { renderChecks(); $('checkSheet').classList.add('open'); };
$('islandMin').onchange = renderChecks;
function renderChecks() {
  const r = lastChecks = computeChecks();
  const nIsl = r.islands.length, islTris = r.islands.reduce((a, i) => a + i.tris.length, 0);
  let flatArea = 0; for (const t of r.flat) flatArea += S.mesh.area[t];
  const used = new Set(S.mesh.paint);
  const physical = new Set();
  for (const s of used) { const p = S.palette[s - 1]; if (!p) continue; if (p.mixed) p.components.forEach(c => physical.add(c)); else physical.add(s); }
  $('checkList').innerHTML =
    item(nIsl === 0, nIsl ? nIsl + ' tiny color island' + (nIsl > 1 ? 's' : '') : 'No tiny color islands',
      nIsl ? islTris.toLocaleString() + ' triangles. Each one forces extra filament swaps and may be too small to print. Clean up merges them into the color around them.' : 'Every color area is at least ' + $('islandMin').value + ' mm².') +
    item(r.flat.length === 0, r.flat.length ? 'Color mix on flat or sloped surfaces' : 'Mixes are on walls only',
      r.flat.length ? Math.round(flatArea) + ' mm² of mixed color sits on a surface tilted more than 30° from vertical. Bambu says mixing can look uneven on top, bottom and sloped surfaces; print a test first.' : 'Mixed colors work best on near-vertical walls, and that is where yours are.') +
    item(true, physical.size + ' filament' + (physical.size === 1 ? '' : 's') + ' needed',
      'Slots ' + [...physical].sort((a, b) => a - b).join(', ') + ' have to be loaded.' + ([...used].some(s => S.palette[s - 1] && S.palette[s - 1].mixed) ? ' Files with mixes can\'t be uploaded to MakerWorld yet.' : ''));
  $('cClean').disabled = !nIsl;
}
function item(ok, title, text) { return '<div class="check"><div class="ic ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓' : '!') + '</div><div><b>' + title + '</b><span>' + text + '</span></div></div>'; }
$('cClean').onclick = () => {
  beginStroke();
  let n = 0;
  for (let pass = 0; pass < 3; pass++) {
    const isl = C.findIslands(S.mesh.adj, S.mesh.paint, S.mesh.area, +$('islandMin').value);
    if (!isl.length) break;
    for (const i of isl) { for (const t of i.tris) { S.mesh.paint[t] = i.surround; triColor(t, palLinear[i.surround]); } n++; }
  }
  endStroke(); renderChecks();
  toast('Merged ' + n + ' island' + (n === 1 ? '' : 's') + ' into the surrounding color. Undo if you want them back.');
};
$('cShow').onclick = () => { $('checkSheet').classList.remove('open'); showChecks(); };
for (const id of ['checkSheet', 'exportSheet', 'renameSheet']) $(id).addEventListener('click', e => { if (e.target.id === id) $(id).classList.remove('open'); });
function showChecks() {
  const r = lastChecks || computeChecks();
  clearPreview(); hideRing();
  S.checking = true;
  const m = S.mesh;
  for (let t = 0; t < m.nT; t++) { const c = paintColor(t); const g = (c[0] + c[1] + c[2]) / 3 * .35 + 150; triColor(t, [g, g, g]); }
  for (const t of r.flat) triColor(t, [255, 80, 1]);
  for (const i of r.islands) for (const t of i.tris) triColor(t, [255, 9, 20]);
  $('checkMsg').textContent = r.islands.length + ' islands · ' + r.flat.length.toLocaleString() + ' mixed triangles on slopes';
  $('checkbar').classList.add('open');
}
function endChecks() { S.checking = false; recolorAll(); $('checkbar').classList.remove('open'); }
$('checkClose').onclick = endChecks;

// ---------------- export ----------------
$('bExport').onclick = () => {
  $('expName').value = S.name;
  $('expNote').textContent = downloads
    ? 'Inside Claude, files can only be saved as .zip. You\'ll get "' + S.name + '.3mf.zip": rename it to end in .3mf (in Files: press and hold, Rename), then open it in Bambu Studio.'
    : 'Saves a .3mf you can open directly in Bambu Studio.';
  $('expTitle').textContent = isTC() ? 'Export for Snapmaker Orca' : 'Export for Bambu Studio';
  $('xGo').disabled = false;
  if (isTC()) {
    const n = physicalPalette().length;
    $('expNote').textContent = (n > 4
      ? 'Toolchangers like the Snapmaker U1 and Flashforge Creator 5 have 4 heads, and this palette has ' + n + ' filaments. Remove ' + (n - 4) + ' to export.'
      : 'Saves a Snapmaker Orca project (2.3.3 or newer, with Full Spectrum) for the Snapmaker U1, with your filaments on heads 1–' + Math.max(n, 1) + ' and your mixes as Full Spectrum mixed filaments. It also opens in the Full Spectrum fork, where you can switch the printer (for example to a Flashforge Creator 5). Set your real filament presets and nozzle in the slicer. ') +
      (downloads && n <= 4 ? 'Inside Claude, files are saved as .zip: rename "' + S.name + '.3mf.zip" to end in .3mf before opening.' : '');
    $('xGo').disabled = n > 4;
  }
  $('exportSheet').classList.add('open');
};
$('xCancel').onclick = () => $('exportSheet').classList.remove('open');
/**
 * Serialise mixes as Snapmaker Orca / Full Spectrum `mixed_filament_definitions`: rows joined by ';'.
 * Row fields match a project saved by Snapmaker Orca 2.4.1: a,b,enabled,custom,B%,pointillism,
 * g<ids>,w<weights>,m<mode>,z,xa,xb,d<deleted>,o<origin_auto>,u<stable id>,cm<ui mode>.
 * 2-filament mixes use mode 2 (simple pair, share of b); 3+ filaments use mode 0 with the
 * explicit id/weight lists.
 * @param {Array} pal Palette (parsePalette output).
 * @param {Object<number, number>} idOf CthulHue slot → slicer filament id.
 * @returns {string}
 */
function snorcaRows(pal, idOf) {
  const rows = [];
  pal.filter(p => p.mixed).forEach((p, k) => {
    const ids = p.components.map(c => idOf[c]);
    let w = p.components.map((c, i) => p.ratios[i] != null ? p.ratios[i] : 1 / p.components.length);
    const tot = w.reduce((a, b) => a + b, 0) || 1;
    w = w.map(x => Math.round(100 * x / tot)); w[0] += 100 - w.reduce((a, b) => a + b, 0);
    const tail = ',z0,xa0,xb0,d0,o0,u' + (k + 1) + ',cm0';
    if (ids.length === 2) rows.push(ids[0] + ',' + ids[1] + ',1,1,' + w[1] + ',0,g,w,m2' + tail);
    else rows.push(ids[0] + ',' + ids[1] + ',1,1,50,0,g' + ids.join('') + ',w' + w.join('/') + ',m0' + tail);
  });
  return rows.join(';');
}
/**
 * Build a Snapmaker Orca project (U1, Full Spectrum) from the painted mesh.
 *
 * Physical filaments go on heads 1–4 (padded with white); mixes become filament ids 5, 6… in palette
 * order, painted with the same paint_color codes as Bambu. The slicer numbers mixes in file order and
 * appends its own auto-generated 50/50 pairs after them, so painted ids stay correct. Reuses build3MF
 * with the Snapmaker template, then swaps the Bambu tags: Snapmaker Orca only treats the file as its
 * project when the Application starts with "Snapmaker_Orca-" (the template supplies "Snapmaker_Orca-2.4.1").
 * @param {{verts, tris, paint}} m Mesh with 1-based CthulHue slots.
 * @param {string} name
 * @returns {Object<string, string|Uint8Array>} 3MF files.
 */
function buildSnorca(m, name) {
  const T = window.SNORCA_TEMPLATE, t = {};
  for (const [p, v] of Object.entries(T)) t[p] = typeof v === 'string' ? v : b64ToBytes(v.b64);
  const st = JSON.parse(t['Metadata/project_settings.config']);
  const heads = (st.filament_colour || []).length || 4;
  const pal = S.palette, phys = pal.filter(p => !p.mixed), idOf = {};
  phys.forEach((p, i) => idOf[p.slot] = i + 1);
  let k = heads; pal.filter(p => p.mixed).forEach(p => idOf[p.slot] = ++k);
  st.filament_colour = Array.from({ length: heads }, (_, i) => phys[i] ? phys[i].color : '#FFFFFF');
  st.mixed_filament_definitions = snorcaRows(pal, idOf);
  t['Metadata/project_settings.config'] = JSON.stringify(st, null, 4);
  const paint = new Uint8Array(m.paint.length);
  for (let i = 0; i < paint.length; i++) paint[i] = m.paint[i] ? (idOf[m.paint[i]] || 1) : 0;
  const out = C.build3MF(t, { verts: m.verts, tris: m.tris, paint }, name);
  for (const p of ['3D/3dmodel.model', '3D/Objects/object_1.model'])
    out[p] = out[p].replace(' xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"', '').replace(/BambuStudio:3mfVersion/g, 'Snapmaker_Orca:3mfVersion');
  return out;
}
$('xGo').onclick = async () => {
  const name = ($('expName').value || 'Painted model').trim().replace(/[\\/:*?"<>|]+/g, '-');
  S.name = name;
  $('xGo').disabled = true; $('xGo').textContent = 'Building…';
  try {
    const m = S.mesh;
    const files = isTC() ? buildSnorca(m, name) : C.build3MF(S.template, { verts: m.verts, tris: m.tris, paint: m.paint }, name);
    const zip = new JSZip();
    for (const p in files) zip.file(p, files[p]);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'model/3mf' });
    $('exportSheet').classList.remove('open');
    if (downloads) {
      try {
        await downloads.save({ filename: name + '.3mf.zip', data: blob });
        toast('Saved. Rename it to "' + name + '.3mf" before opening in ' + (isTC() ? 'Snapmaker Orca.' : 'Bambu Studio.'), 7000);
      } catch (err) {
        if (err && err.code === 'declined') toast('Export cancelled');
        else toast('Could not save here (' + (err && err.code || 'error') + ').', 6000);
      }
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name + '.3mf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      toast('Saved ' + name + '.3mf');
    }
  } catch (err) { console.error(err); toast('Export failed: ' + err.message, 6000); }
  $('xGo').disabled = false; $('xGo').textContent = 'Export';
};

// ---------------- start ----------------
setTemplate(loadDefaultTemplate(), S.palSource, false);
selectTool('brush');
window.__lab = { cube: () => cube, applyDecal: () => applyDecal(), decal: () => decal, setDecal: d => { Object.assign(decal, d); showDecal(); }, refineShading: m => refineShading(m), S, pick, setMesh, C, camera, controls, paintColor: t => paintColor(t), colorAttr: () => colorAttr, ants: () => ({ dashed: antDash.dashed, defines: Object.assign({}, antDash.defines), dashSize: antDash.dashSize, gap: antDash.gapSize, scale: antDash.dashScale, offset: antDash.dashOffset, segs: antsDash ? antsDash.geometry.attributes.instanceStart.count : 0, dist: antsDash && antsDash.geometry.attributes.instanceDistanceStart ? Array.from(antsDash.geometry.attributes.instanceDistanceStart.array.slice(0, 6)) : null }) };
