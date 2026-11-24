/**
 * @file CthulHue core: everything that works on meshes, paint and project settings, with no UI.
 *
 * Plain functions with no DOM access, so they run in Node for tests and in the page (exposed as
 * `window.LabCore`; app.js imports it as `C`).
 *
 * Conventions used throughout:
 * - A mesh is `verts` (Float32Array, x,y,z per vertex, mm, Z up) and `tris` (Uint32Array, 3 vertex
 *   indices per triangle, counter-clockwise seen from outside).
 * - Paint is a Uint8Array with one **1-based filament slot** per triangle (0 = unpainted).
 * - `adj` (from {@link adjacency}) is an Int32Array: `adj[t*3+e]` is the triangle across edge e of
 *   triangle t, where edge e runs from corner e to corner (e+1)%3; -1 means no neighbour.
 * - Project settings are the parsed JSON of a Bambu/Orca `Metadata/project_settings.config`. Most
 *   filament settings are arrays with one entry (or one block of entries) per filament slot.
 *
 * Sections: paint codec · 3MF/STL import · palette and colour · mesh topology · fills and outlines ·
 * refinement · filament settings editing · shading patterns · part segmentation (unused in the UI
 * since v1) · selection grow/shrink and edge smoothing · 3MF export.
 */
(function (root) {
  'use strict';

  // ---------- paint_color encoding (Bambu / Prusa TriangleSelector format) ----------
  /**
   * Encode one filament slot as a whole-triangle `paint_color` attribute value.
   *
   * Format (TriangleSelector::serialize): a hex string read from its END, bits LSB first. A leaf
   * node is 2 bits "split count" (0) + 2 bits state; state 3 means "read the next nibble and add 3",
   * and each nibble of 15 means "add 15 and keep reading". So slot 1 = "4", 2 = "8", 3..17 = "<n-3>C",
   * 18+ needs extra "F" nibbles. Both Bambu Studio and Snapmaker Orca use this same encoding.
   *
   * @param {number} state 1-based filament slot; 0 or falsy for unpainted.
   * @returns {string} Attribute value, or '' for unpainted (the attribute is then omitted).
   */
  function encodePaint(state) {
    if (!state) return '';
    if (state < 3) return (state << 2).toString(16).toUpperCase();
    // 0b1100, then (state-3) in nibbles: each full 15 is written as F (Bambu TriangleSelector::serialize)
    const nib = [0xC];
    let n = state - 3;
    while (n >= 15) { nib.push(15); n -= 15; }
    nib.push(n);
    return nib.reverse().map(x => x.toString(16).toUpperCase()).join('');
  }

  /**
   * Decode a `paint_color` value to a single slot for the whole triangle.
   *
   * Slicers may store a triangle subdivided into painted sub-triangles. CthulHue paints whole
   * triangles, so this returns the most common leaf state; the subdivision is not reproduced.
   *
   * @param {string} str `paint_color` attribute value (may be empty).
   * @returns {number} 1-based slot, or 0 when unpainted.
   */
  function decodePaint(str) {
    if (!str) return 0;
    const nibbles = [];
    for (let i = str.length - 1; i >= 0; i--) nibbles.push(parseInt(str[i], 16) || 0);
    let bitPos = 0;
    const totalBits = nibbles.length * 4;
    function bits(n) {
      let v = 0;
      for (let k = 0; k < n; k++) {
        if (bitPos >= totalBits) return v;
        const nib = nibbles[bitPos >> 2];
        v |= ((nib >> (bitPos & 3)) & 1) << k;
        bitPos++;
      }
      return v;
    }
    const counts = {};
    function node(depth) {
      if (depth > 40 || bitPos >= totalBits) return;
      const split = bits(2);
      if (split === 0) {
        let s = bits(2);
        if (s === 3) { let n = bits(4); s = 3; while (n === 15) { s += 15; n = bits(4); } s += n; }
        counts[s] = (counts[s] || 0) + 1;
      } else {
        bits(2); // special side
        for (let c = 0; c <= split; c++) node(depth + 1);
      }
    }
    node(0);
    let best = 0, bestN = -1;
    for (const k in counts) if (counts[k] > bestN) { bestN = counts[k]; best = +k; }
    return best;
  }

  // ---------- small XML helpers (regex based: fast on big meshes, works in Node) ----------
  function attrs(s) {
    const o = {};
    const re = /([\w:]+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) o[m[1]] = m[2];
    return o;
  }
  function parseMatrix(t) {
    if (!t) return null;
    const v = t.trim().split(/\s+/).map(Number);
    return v.length === 12 ? v : null;
  }
  // 3MF matrices are row-vector 4x3: [m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32]
  function mulMatrix(a, b) { // apply a, then b
    if (!a) return b; if (!b) return a;
    const r = new Array(12);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
      let s = (i === 3 ? b[9 + j] : 0);
      for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
      r[i * 3 + j] = s;
    }
    return r;
  }

  // ---------- STL ----------
  /**
   * Parse a binary or ASCII STL.
   * @param {ArrayBuffer} buf File contents.
   * @returns {Float32Array} Unwelded positions, 9 floats (3 vertices) per triangle. Pass to {@link weld}.
   */
  function parseSTL(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let binary = true;
    if (u8.length >= 84) {
      const n = dv.getUint32(80, true);
      if (84 + n * 50 !== u8.length) {
        const head = new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 512))).trim();
        if (head.startsWith('solid') && /facet/.test(new TextDecoder().decode(u8.subarray(0, Math.min(u8.length, 4096))))) binary = false;
      }
    } else binary = false;
    if (binary) {
      const n = dv.getUint32(80, true);
      const pos = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12;
        for (let k = 0; k < 9; k++) pos[i * 9 + k] = dv.getFloat32(o + k * 4, true);
      }
      return { positions: pos, paint: null };
    }
    const txt = new TextDecoder().decode(u8);
    const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
    const out = [];
    let m;
    while ((m = re.exec(txt))) out.push(+m[1], +m[2], +m[3]);
    return { positions: new Float32Array(out.length - (out.length % 9) ? out.slice(0, out.length - (out.length % 9)) : out), paint: null };
  }

  // ---------- 3MF (mesh + paint + project settings) ----------
  // files: { path: string | Uint8Array } with string content for text files.
  // Returns per-triangle filament slot (paint, 1-based) using, in order: painted color,
  // the part's filament, the object's filament. Modifier / negative / support-blocker parts are skipped.
  // Plain 3MF colors (colorgroup / basematerials) come back as triColors (hex per triangle).
  /**
   * Read the geometry, paint and settings of a 3MF (Bambu Studio, Orca and plain 3MF).
   *
   * Follows components and build-item transforms; per-object and per-part filament assignments
   * from `model_settings.config` become paint for unpainted triangles. Modifier, support-blocker and
   * other non-printing parts are skipped (counted in `skippedParts`).
   *
   * @param {Object<string, string|Uint8Array>} files Unzipped 3MF: path → text (XML/JSON) or bytes.
   * @returns {{positions: Float32Array, paint: ?Uint8Array, triColors: ?Array, settings: ?Object,
   *   simplified: boolean, skippedParts: number}} `positions` are unwelded (9 floats per triangle).
   *   `paint` is null when the file has no slot information; `triColors` holds plain per-triangle
   *   colours (non-Bambu 3MF) when there is no paint.
   */
  function parse3MF(files) {
    const rels = files['_rels/.rels'] || '';
    let rootPath = '3D/3dmodel.model';
    const rm = /Target="\/?([^"]+\.model)"/i.exec(rels);
    if (rm) rootPath = rm[1];

    // Bambu/Orca per-object and per-part filament + part type
    const objExtr = {}, partExtr = {}, partType = {};
    const ms = files['Metadata/model_settings.config'];
    if (typeof ms === 'string') {
      const oRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
      let m;
      while ((m = oRe.exec(ms))) {
        const oid = attrs(m[1]).id;
        const body = m[2];
        const head = body.split(/<part\b/)[0];
        const ex = /key="extruder"\s+value="(\d+)"/.exec(head);
        if (ex) objExtr[oid] = +ex[1];
        partExtr[oid] = {}; partType[oid] = {};
        const pRe = /<part\b([^>]*)>([\s\S]*?)<\/part>/g;
        let p;
        while ((p = pRe.exec(body))) {
          const pa = attrs(p[1]);
          partType[oid][pa.id] = pa.subtype || 'normal_part';
          const pe = /key="extruder"\s+value="(\d+)"/.exec(p[2]);
          if (pe) partExtr[oid][pa.id] = +pe[1];
        }
      }
    }

    const cache = {};
    function modelFile(path) {
      path = path.replace(/^\//, '');
      if (cache[path]) return cache[path];
      const xml = files[path];
      if (typeof xml !== 'string') throw new Error('Missing model part ' + path);
      // color resources
      const res = {};
      const rRe = /<(?:\w+:)?(colorgroup|basematerials)\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?\1>/g;
      let r;
      while ((r = rRe.exec(xml))) {
        const id = attrs(r[2]).id;
        const list = [];
        const cRe = /<(?:\w+:)?(?:color|base)\b([^>]*?)\/?>/g;
        let c;
        while ((c = cRe.exec(r[3]))) {
          const ca = attrs(c[1]);
          const col = ca.color || ca.displaycolor;
          if (col) list.push(col.slice(0, 7).toUpperCase());
        }
        res[id] = list;
      }
      const objects = {};
      const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
      let m;
      while ((m = objRe.exec(xml))) {
        const a = attrs(m[1]);
        const body = m[2];
        const o = { id: a.id, type: a.type || 'model', pid: a.pid, pindex: a.pindex };
        const meshM = /<mesh>([\s\S]*?)<\/mesh>/.exec(body);
        if (meshM) o.mesh = meshM[1];
        const comps = [];
        const cRe = /<component\b([^>]*)\/?>/g;
        let c;
        while ((c = cRe.exec(body))) {
          const ca = attrs(c[1]);
          comps.push({ path: ca['p:path'] ? ca['p:path'].replace(/^\//, '') : path, id: ca.objectid, transform: parseMatrix(ca.transform) });
        }
        o.components = comps;
        objects[a.id] = o;
      }
      const items = [];
      const buildM = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml);
      if (buildM) {
        const iRe = /<item\b([^>]*)\/?>/g;
        let it;
        while ((it = iRe.exec(buildM[1]))) {
          const ia = attrs(it[1]);
          if (ia.printable === '0') continue;
          items.push({ id: ia.objectid, transform: parseMatrix(ia.transform) });
        }
      }
      return (cache[path] = { objects, items, res });
    }
    const pos = [], paint = [], triColors = [];
    let painted = false, simplified = false, colored = false, skipped = 0;
    function emit(o, file, M, defSlot) {
      const meshXml = o.mesh;
      const vx = [];
      const vRe = /<vertex\b([^>]*)\/?>/g;
      let v;
      while ((v = vRe.exec(meshXml))) {
        const a = attrs(v[1]);
        let x = +a.x, y = +a.y, z = +a.z;
        if (M) {
          const nx = x * M[0] + y * M[3] + z * M[6] + M[9];
          const ny = x * M[1] + y * M[4] + z * M[7] + M[10];
          const nz = x * M[2] + y * M[5] + z * M[8] + M[11];
          x = nx; y = ny; z = nz;
        }
        vx.push(x, y, z);
      }
      const tRe = /<triangle\b([^>]*)\/?>/g;
      let t;
      while ((t = tRe.exec(meshXml))) {
        const a = attrs(t[1]);
        const i1 = +a.v1 * 3, i2 = +a.v2 * 3, i3 = +a.v3 * 3;
        pos.push(vx[i1], vx[i1 + 1], vx[i1 + 2], vx[i2], vx[i2 + 1], vx[i2 + 2], vx[i3], vx[i3 + 1], vx[i3 + 2]);
        const pc = a.paint_color || a['slic3rpe:mmu_segmentation'] || '';
        if (pc) { painted = true; if (pc.length > 2) simplified = true; }
        const st = decodePaint(pc);
        paint.push(st || defSlot || 0);
        const pid = a.pid || o.pid, pi = a.p1 != null ? a.p1 : o.pindex;
        const list = pid != null ? file.res[pid] : null;
        const col = list ? list[+pi || 0] : null;
        if (col) colored = true;
        triColors.push(col || null);
      }
    }
    function walk(path, id, M, depth, defSlot, rootId) {
      if (depth > 16) return;
      const f = modelFile(path);
      const o = f.objects[id];
      if (!o) return;
      if (o.type && !/^(model|solidsupport|other)$/.test(o.type)) { skipped++; return; }
      if (o.mesh) emit(o, f, M, defSlot);
      for (const c of o.components) {
        let slot = defSlot;
        if (depth === 0 && rootId != null) {
          const kind = partType[rootId] && partType[rootId][c.id];
          if (kind && kind !== 'normal_part') { skipped++; continue; }
          if (partExtr[rootId] && partExtr[rootId][c.id]) slot = partExtr[rootId][c.id];
        }
        walk(c.path, c.id, mulMatrix(c.transform, M), depth + 1, slot, rootId);
      }
    }
    const rootFile = modelFile(rootPath);
    for (const it of rootFile.items) walk(rootPath, it.id, it.transform, 0, objExtr[it.id] || 0, it.id);
    let settings = null;
    if (typeof files['Metadata/project_settings.config'] === 'string') {
      try { settings = JSON.parse(files['Metadata/project_settings.config']); } catch (e) { settings = null; }
    }
    const hasSlots = painted || Object.keys(objExtr).length > 0;
    return {
      positions: new Float32Array(pos),
      paint: hasSlots ? Uint8Array.from(paint) : null,
      triColors: colored && !painted ? triColors : null,
      settings, simplified, skippedParts: skipped
    };
  }

  // ---------- palette ----------
  const NAMED = [
    ['Cyan', '#00A0E0'], ['Magenta', '#E0458A'], ['Yellow', '#FCE300'], ['Black', '#000000'], ['White', '#FFFFFF'],
    ['Red', '#C8102E'], ['Orange', '#FF7A00'], ['Coral', '#F26B5B'], ['Peach', '#F7B58C'], ['Salmon', '#E9967A'],
    ['Green', '#00A651'], ['Lime', '#9ACD32'], ['Olive', '#6B6B2A'], ['Mint', '#A8E6CF'], ['Teal', '#007C80'],
    ['Turquoise', '#30C5C0'], ['Sky Blue', '#7EC8E3'], ['Blue', '#0047AB'], ['Navy', '#1B2A4A'], ['Purple', '#6A2C91'],
    ['Lavender', '#B9A7D9'], ['Pink', '#F4A6C6'], ['Hot Pink', '#FF4FA3'], ['Maroon', '#6D1A2C'], ['Brown', '#6F4E37'],
    ['Tan', '#D2B48C'], ['Beige', '#E8DCC2'], ['Cream', '#F6EFD9'], ['Gold', '#C9A227'], ['Bronze', '#A0713B'],
    ['Silver', '#C0C3C7'], ['Light Gray', '#BDBDBD'], ['Gray', '#8A8D8F'], ['Dark Gray', '#4A4A4A'], ['Charcoal', '#2E2F33']
  ];
  function hexToRgb(h) {
    h = (h || '#888888').replace('#', '');
    if (h.length >= 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    return [136, 136, 136];
  }
  function hexToLab(h) {
    const c = hexToRgb(h).map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    let x = (c[0] * 0.4124 + c[1] * 0.3576 + c[2] * 0.1805) / 0.95047;
    let y = (c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722);
    let z = (c[0] * 0.0193 + c[1] * 0.1192 + c[2] * 0.9505) / 1.08883;
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    x = f(x); y = f(y); z = f(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  function labDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
  const NAMED_LAB = NAMED.map(([n, h]) => [n, hexToLab(h)]);
  function colorName(hex) {
    const c = hexToLab(hex);
    let best = NAMED[0][0], bd = 1e9;
    for (const [n, l] of NAMED_LAB) { const d = labDist(c, l); if (d < bd) { bd = d; best = n; } }
    return best;
  }
  // Closest palette slot (1-based) to a color, by perceived difference.
  function nearestSlot(hex, palette, physicalOnly) {
    const c = hexToLab(hex);
    let best = 1, bd = 1e9;
    for (const p of palette) {
      if (physicalOnly && p.mixed) continue;
      const d = labDist(c, hexToLab(p.color));
      if (d < bd) { bd = d; best = p.slot; }
    }
    return best;
  }
  /**
   * Turn project settings into CthulHue's palette list (one entry per filament slot).
   *
   * Bambu mixes live in the same filament arrays as real spools, flagged by `filament_is_mixed`;
   * `filament_mixed_components` lists 1-based slots and `filament_mixed_sublayer_ratios` their shares.
   *
   * @param {Object} settings Parsed project_settings.config.
   * @returns {Array<{slot: number, color: string, type: string, mixed: boolean, gradient: boolean,
   *   gradRange: string, name: string, components?: number[], ratios?: number[]}>}
   */
  function parsePalette(settings) {
    const cols = (settings && settings.filament_colour) || ['#FFFFFF'];
    const isMixed = settings.filament_is_mixed || [];
    const comps = settings.filament_mixed_components || [];
    const ratios = settings.filament_mixed_sublayer_ratios || [];
    const grad = settings.filament_mixed_gradient || [];
    const types = settings.filament_type || [];
    return cols.map((c, i) => {
      const mixed = isMixed[i] === '1';
      const e = { slot: i + 1, color: (c || '#888888').slice(0, 7).toUpperCase(), type: types[i] || '', mixed, gradient: grad[i] === '1', gradRange: (settings.filament_mixed_gradient_range || [])[i] || '' };
      if (mixed) {
        e.components = (comps[i] || '').split(',').filter(Boolean).map(Number);
        e.ratios = (ratios[i] || '').split(',').filter(Boolean).map(Number);
        e.name = 'Mix ' + e.components.map((s, k) => {
          const cc = cols[s - 1] ? colorName(cols[s - 1]) : '#' + s;
          const r = e.ratios[k] != null ? ' ' + Math.round(e.ratios[k] * 100) + '%' : '';
          return cc + r;
        }).join(' + ');
      } else e.name = colorName(e.color);
      return e;
    });
  }

  // ---------- mesh topology ----------
  /**
   * Merge vertices closer than `eps` and drop triangles that collapse.
   * @param {Float32Array} positions 9 floats per triangle (from parseSTL / parse3MF).
   * @param {number} [eps=1e-5] Merge distance in mm.
   * @returns {{verts: Float32Array, tris: Uint32Array, kept: ?number[]}} `kept` lists the original
   *   indices of the triangles that survived, or null if none were dropped (use it to keep paint aligned).
   */
  function weld(positions, eps) {
    eps = eps || 1e-5;
    const n = positions.length / 9;
    const map = new Map();
    const verts = [];
    const tris = new Uint32Array(n * 3);
    const inv = 1 / eps;
    for (let i = 0; i < n * 3; i++) {
      const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
      let idx = map.get(key);
      if (idx === undefined) { idx = verts.length / 3; verts.push(x, y, z); map.set(key, idx); }
      tris[i] = idx;
    }
    // drop degenerate triangles
    const keep = [];
    for (let t = 0; t < n; t++) {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      if (a !== b && b !== c && a !== c) keep.push(t);
    }
    let outTris = tris;
    if (keep.length !== n) {
      outTris = new Uint32Array(keep.length * 3);
      keep.forEach((t, k) => { outTris[k * 3] = tris[t * 3]; outTris[k * 3 + 1] = tris[t * 3 + 1]; outTris[k * 3 + 2] = tris[t * 3 + 2]; });
    }
    return { verts: new Float32Array(verts), tris: outTris, kept: keep.length === n ? null : keep };
  }

  /**
   * Edge neighbours of every triangle (see the file header for the layout).
   * Edges shared by more than two triangles (non-manifold) keep only the first pair.
   * @param {Uint32Array} tris
   * @param {number} nVerts
   * @returns {Int32Array} 3 entries per triangle, -1 for an open edge.
   */
  function adjacency(tris, nVerts) {
    const nT = tris.length / 3;
    const adj = new Int32Array(nT * 3).fill(-1);
    const edges = new Map();
    for (let t = 0; t < nT; t++) {
      for (let e = 0; e < 3; e++) {
        const a = tris[t * 3 + e], b = tris[t * 3 + ((e + 1) % 3)];
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * nVerts + hi;
        const other = edges.get(key);
        if (other === undefined) edges.set(key, t * 3 + e);
        else if (other >= 0) {
          const ot = (other / 3) | 0, oe = other % 3;
          adj[t * 3 + e] = ot; adj[ot * 3 + oe] = t;
          edges.set(key, -1); // non-manifold beyond 2: ignore further
        }
      }
    }
    return adj;
  }

  /**
   * Per-triangle unit normals, centroids and areas.
   * @param {Float32Array} verts
   * @param {Uint32Array} tris
   * @returns {{normals: Float32Array, cent: Float32Array, area: Float32Array}}
   */
  function faceData(verts, tris) {
    const nT = tris.length / 3;
    const normals = new Float32Array(nT * 3), cent = new Float32Array(nT * 3), area = new Float32Array(nT);
    for (let t = 0; t < nT; t++) {
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
      const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
      const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      area[t] = l / 2;
      normals[t * 3] = nx / l; normals[t * 3 + 1] = ny / l; normals[t * 3 + 2] = nz / l;
      cent[t * 3] = (verts[a] + verts[b] + verts[c]) / 3;
      cent[t * 3 + 1] = (verts[a + 1] + verts[b + 1] + verts[c + 1]) / 3;
      cent[t * 3 + 2] = (verts[a + 2] + verts[b + 2] + verts[c + 2]) / 3;
    }
    return { normals, cent, area };
  }

  // Flood across edges whose dihedral angle is below the threshold (like Bambu's smart fill).
  // wall (optional): Int32Array, >=0 marks triangles on a drawn outline; floods never enter them.
  function smartFill(seed, angleDeg, adj, normals, mark, wall) {
    const cosT = angleDeg >= 180 ? -2 : Math.cos(angleDeg * Math.PI / 180);
    const out = [];
    const stack = [seed];
    mark.fill(0);
    mark[seed] = 1;
    while (stack.length) {
      const t = stack.pop();
      out.push(t);
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || mark[n] || (wall && wall[n] >= 0)) continue;
        const d = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
        if (d >= cosT - 1e-6) { mark[n] = 1; stack.push(n); }
      }
    }
    return out;
  }

  // Flood over connected triangles that share the seed's color.
  function sameColorFill(seed, adj, paint, mark, wall) {
    const col = paint[seed];
    const out = [];
    const stack = [seed];
    mark.fill(0);
    mark[seed] = 1;
    while (stack.length) {
      const t = stack.pop();
      out.push(t);
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || mark[n] || paint[n] !== col || (wall && wall[n] >= 0)) continue;
        mark[n] = 1; stack.push(n);
      }
    }
    return out;
  }

  // Nearest triangle (by hops) that is not on an outline.
  function nearestNonWall(seed, adj, wall, limit) {
    if (wall[seed] < 0) return seed;
    const seen = new Set([seed]);
    const q = [seed];
    for (let i = 0; i < q.length && i < (limit || 5000); i++) {
      const t = q[i];
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || seen.has(n)) continue;
        if (wall[n] < 0) return n;
        seen.add(n); q.push(n);
      }
    }
    return -1;
  }

  // Which side of outline segment s a triangle's centroid lies on (signed, along the surface).
  function segSide(t, s, segs, normals, cent) {
    const o = s * 6;
    const dx = segs[o + 3] - segs[o], dy = segs[o + 4] - segs[o + 1], dz = segs[o + 5] - segs[o + 2];
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const px = dy * nz - dz * ny, py = dz * nx - dx * nz, pz = dx * ny - dy * nx;
    return px * (cent[t * 3] - segs[o]) + py * (cent[t * 3 + 1] - segs[o + 1]) + pz * (cent[t * 3 + 2] - segs[o + 2]);
  }

  // Which side of a drawn line a triangle lies on: +1 left, -1 right of the line's direction. Uses the nearest
  // of its outline segment and that segment's neighbours, with the bisector at joints, so it is consistent along curves.
  function lineSide(t, s, segs, normals, cent) {
    const nS = segs.length / 6;
    const cx = cent[t * 3], cy = cent[t * 3 + 1], cz = cent[t * 3 + 2];
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    const joined = (i, j) => i >= 0 && j < nS && Math.abs(segs[i * 6 + 3] - segs[j * 6]) + Math.abs(segs[i * 6 + 4] - segs[j * 6 + 1]) + Math.abs(segs[i * 6 + 5] - segs[j * 6 + 2]) < 1e-6;
    let best = s, bd = Infinity;
    for (const k of [s - 1, s, s + 1]) {
      if (k < 0 || k >= nS || (k !== s && !(k < s ? joined(k, s) : joined(s, k)))) continue;
      const o = k * 6, d = segDist2(cx, cy, cz, segs[o], segs[o + 1], segs[o + 2], segs[o + 3], segs[o + 4], segs[o + 5]);
      if (d < bd) { bd = d; best = k; }
    }
    const left = k => {
      const o = k * 6, dx = segs[o + 3] - segs[o], dy = segs[o + 4] - segs[o + 1], dz = segs[o + 5] - segs[o + 2], l = Math.hypot(dx, dy, dz) || 1;
      return [(ny * dz - nz * dy) / l, (nz * dx - nx * dz) / l, (nx * dy - ny * dx) / l];
    };
    const o = best * 6;
    const dx = segs[o + 3] - segs[o], dy = segs[o + 4] - segs[o + 1], dz = segs[o + 5] - segs[o + 2], l2 = dx * dx + dy * dy + dz * dz || 1;
    const u = ((cx - segs[o]) * dx + (cy - segs[o + 1]) * dy + (cz - segs[o + 2]) * dz) / l2;
    let L = left(best), ox = segs[o], oy = segs[o + 1], oz = segs[o + 2];
    if (u < 0 && joined(best - 1, best)) { const q = left(best - 1); L = [L[0] + q[0], L[1] + q[1], L[2] + q[2]]; }
    else if (u > 1) { ox = segs[o + 3]; oy = segs[o + 4]; oz = segs[o + 5]; if (joined(best, best + 1)) { const q = left(best + 1); L = [L[0] + q[0], L[1] + q[1], L[2] + q[2]]; } }
    return L[0] * (cx - ox) + L[1] * (cy - oy) + L[2] * (cz - oz) >= 0 ? 1 : -1;
  }
  // After a fill, claim the outline triangles on the filled side of the line, so the colour edge sits on the
  // drawn line. The filled side is decided once (by the region's triangles along the line) and every line
  // triangle is judged the same way by any fill, so fills on the two sides split the line exactly.
  function absorbWalls(region, adj, wall, segs, normals, cent, paint, colorOnly) {
    const nT = wall.length;
    const inR = new Uint8Array(nT); for (const t of region) inR[t] = 1;
    // which side is ours, per outline segment group (vote by region triangles touching the line)
    let vote = 0;
    const front = [];
    for (const t of region) for (let e = 0; e < 3; e++) {
      const w = adj[t * 3 + e];
      if (w < 0 || wall[w] < 0 || inR[w]) continue;
      vote += lineSide(t, wall[w], segs, normals, cent);
      front.push(w);
    }
    if (!front.length) return [];
    const ours = vote >= 0 ? 1 : -1;
    const done = new Uint8Array(nT), out = [];
    const q = front.slice();
    while (q.length) {
      const w = q.pop();
      if (done[w] || inR[w]) continue;
      done[w] = 1;
      if (colorOnly != null && paint[w] !== colorOnly) continue;
      if (lineSide(w, wall[w], segs, normals, cent) !== ours) continue;
      out.push(w);
      for (let e = 0; e < 3; e++) { const n = adj[w * 3 + e]; if (n >= 0 && wall[n] >= 0 && !done[n] && !inR[n]) q.push(n); }
    }
    return out;
  }

  // Shortest edge-connected path of triangles between two triangles (for watertight outlines).
  function linkPath(adj, from, to, limit) {
    if (from === to) return [from];
    const prev = new Map([[from, -1]]);
    const q = [from];
    for (let i = 0; i < q.length && i < (limit || 4000); i++) {
      const t = q[i];
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || prev.has(n)) continue;
        prev.set(n, t);
        if (n === to) {
          const path = [n];
          let c = t;
          while (c !== -1) { path.push(c); c = prev.get(c); }
          return path.reverse();
        }
        q.push(n);
      }
    }
    return null;
  }

  // Connected-surface brush: triangles reachable from the seed whose centroid is within radius.
  function brushSelect(seed, point, radius, adj, cent, mark, stamp) {
    const r2 = radius * radius;
    const out = [seed];
    const stack = [seed];
    mark[seed] = stamp;
    while (stack.length) {
      const t = stack.pop();
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || mark[n] === stamp) continue;
        mark[n] = stamp;
        const dx = cent[n * 3] - point[0], dy = cent[n * 3 + 1] - point[1], dz = cent[n * 3 + 2] - point[2];
        if (dx * dx + dy * dy + dz * dz <= r2) { out.push(n); stack.push(n); }
      }
    }
    return out;
  }

  // Small same-color islands (area below minArea) — wasteful color swaps, often unprintable.
  function findIslands(adj, paint, area, minArea) {
    const nT = paint.length;
    const region = new Int32Array(nT).fill(-1);
    const islands = [];
    let rid = 0;
    const stack = [];
    for (let s = 0; s < nT; s++) {
      if (region[s] >= 0) continue;
      const col = paint[s];
      const tris = [];
      let a = 0;
      region[s] = rid; stack.push(s);
      while (stack.length) {
        const t = stack.pop();
        tris.push(t); a += area[t];
        for (let e = 0; e < 3; e++) {
          const n = adj[t * 3 + e];
          if (n < 0 || region[n] >= 0 || paint[n] !== col) continue;
          region[n] = rid; stack.push(n);
        }
      }
      if (a < minArea) {
        // only count as an island if it touches another color (not a whole tiny separate part)
        const border = {};
        let touches = false;
        for (const t of tris) for (let e = 0; e < 3; e++) {
          const n = adj[t * 3 + e];
          if (n >= 0 && paint[n] !== col) { touches = true; border[paint[n]] = (border[paint[n]] || 0) + 1; }
        }
        if (touches) {
          let best = -1, bn = -1;
          for (const k in border) if (border[k] > bn) { bn = border[k]; best = +k; }
          islands.push({ tris, area: a, color: col, surround: best });
        }
      }
      rid++;
    }
    return islands;
  }

  /**
   * Red-green refinement: split marked triangles 1→4, and split neighbours 1→2 (or 1→4 when two of
   * their edges are split) so no T-junctions appear and the mesh stays watertight for the slicer.
   * Used everywhere paint needs finer triangles: brush edges, shading patterns, image projection.
   *
   * @param {Float32Array} verts
   * @param {Uint32Array} tris
   * @param {ArrayLike<number>} marked Non-zero for triangles to split 1→4.
   * @param {TypedArray[]} [carry] Per-triangle arrays (paint, masks…) copied to each child triangle.
   * @param {Int32Array} [adj] Precomputed adjacency, if available.
   * @returns {{verts: Float32Array, tris: Uint32Array, carry: TypedArray[]}}
   */
  function refineMarked(verts, tris, marked, carry, adj) {
    const nT = tris.length / 3, nV = verts.length / 3;
    adj = adj || adjacency(tris, nV);
    const red = new Uint8Array(nT);
    const split = new Map();
    const key = (a, b) => (a < b ? a * nV + b : b * nV + a);
    const stack = [];
    for (let t = 0; t < nT; t++) if (marked[t]) { red[t] = 1; stack.push(t); }
    const countSplit = t => {
      let c = 0;
      for (let e = 0; e < 3; e++) if (split.has(key(tris[t * 3 + e], tris[t * 3 + (e + 1) % 3]))) c++;
      return c;
    };
    while (stack.length) {
      const t = stack.pop();
      for (let e = 0; e < 3; e++) {
        const k = key(tris[t * 3 + e], tris[t * 3 + (e + 1) % 3]);
        if (split.has(k)) continue;
        split.set(k, -1);
        const n = adj[t * 3 + e];
        if (n >= 0 && !red[n] && countSplit(n) >= 2) { red[n] = 1; stack.push(n); }
      }
    }
    const v = Array.from(verts);
    for (const [k, _] of split) {
      const a = Math.floor(k / nV), b = k - a * nV;
      split.set(k, v.length / 3);
      v.push((verts[a * 3] + verts[b * 3]) / 2, (verts[a * 3 + 1] + verts[b * 3 + 1]) / 2, (verts[a * 3 + 2] + verts[b * 3 + 2]) / 2);
    }
    const nt = [];
    const src = [];
    for (let t = 0; t < nT; t++) {
      const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
      const mab = split.get(key(a, b)), mbc = split.get(key(b, c)), mca = split.get(key(c, a));
      const has = (mab !== undefined) + (mbc !== undefined) + (mca !== undefined);
      if (has === 0) { nt.push(a, b, c); src.push(t); }
      else if (has === 3) { nt.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca); src.push(t, t, t, t); }
      else if (mab !== undefined) { nt.push(a, mab, c, mab, b, c); src.push(t, t); }
      else if (mbc !== undefined) { nt.push(a, b, mbc, a, mbc, c); src.push(t, t); }
      else { nt.push(a, b, mca, mca, b, c); src.push(t, t); }
    }
    const outCarry = (carry || []).map(arr => {
      const o = new arr.constructor(src.length);
      for (let i = 0; i < src.length; i++) o[i] = arr[src[i]];
      return o;
    });
    return { verts: new Float32Array(v), tris: Uint32Array.from(nt), carry: outCarry };
  }

  // Uniform 1->4 subdivision of the whole mesh. Paint carries to children.
  function subdivide(verts, tris, paint, extra) {
    const r = refineMarked(verts, tris, new Uint8Array(tris.length / 3).fill(1), [paint].concat(extra || []));
    return { verts: r.verts, tris: r.tris, paint: r.carry[0], extra: r.carry.slice(1) };
  }

  // Squared distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5).
  function pointTriDist2(px, py, pz, v, ia, ib, ic) {
    const ax = v[ia], ay = v[ia + 1], az = v[ia + 2];
    const abx = v[ib] - ax, aby = v[ib + 1] - ay, abz = v[ib + 2] - az;
    const acx = v[ic] - ax, acy = v[ic + 1] - ay, acz = v[ic + 2] - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    let qx, qy, qz;
    if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
    else {
      const bpx = px - v[ib], bpy = py - v[ib + 1], bpz = pz - v[ib + 2];
      const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      const cpx = px - v[ic], cpy = py - v[ic + 1], cpz = pz - v[ic + 2];
      const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
      const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
      if (d3 >= 0 && d4 <= d3) { qx = v[ib]; qy = v[ib + 1]; qz = v[ib + 2]; }
      else if (d6 >= 0 && d5 <= d6) { qx = v[ic]; qy = v[ic + 1]; qz = v[ic + 2]; }
      else if (vc <= 0 && d1 >= 0 && d3 <= 0) { const w = d1 / (d1 - d3); qx = ax + w * abx; qy = ay + w * aby; qz = az + w * abz; }
      else if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; }
      else if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        qx = v[ib] + w * (v[ic] - v[ib]); qy = v[ib + 1] + w * (v[ic + 1] - v[ib + 1]); qz = v[ib + 2] + w * (v[ic + 2] - v[ib + 2]);
      } else {
        const den = 1 / (va + vb + vc), w1 = vb * den, w2 = vc * den;
        qx = ax + abx * w1 + acx * w2; qy = ay + aby * w1 + acy * w2; qz = az + abz * w1 + acz * w2;
      }
    }
    return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  }

  // Refine only where a drawn line passes, until triangles there are no longer than `target` mm.
  // pts: flat [x,y,z,...] along the line. Returns {verts, tris, carry, limited}.
  function refineNear(verts, tris, carry, pts, target, maxTris) {
    let V = verts, T = tris, Cr = carry;
    let limited = false;
    const nP = pts.length / 3;
    let bx0 = 1e9, by0 = 1e9, bz0 = 1e9, bx1 = -1e9, by1 = -1e9, bz1 = -1e9;
    for (let i = 0; i < nP; i++) {
      bx0 = Math.min(bx0, pts[i * 3]); bx1 = Math.max(bx1, pts[i * 3]);
      by0 = Math.min(by0, pts[i * 3 + 1]); by1 = Math.max(by1, pts[i * 3 + 1]);
      bz0 = Math.min(bz0, pts[i * 3 + 2]); bz1 = Math.max(bz1, pts[i * 3 + 2]);
    }
    const r = target, r2 = r * r, t2 = target * target * 1.0001;
    for (let level = 0; level < 14; level++) {
      const nT = T.length / 3;
      const marked = new Uint8Array(nT);
      let any = 0;
      for (let t = 0; t < nT; t++) {
        const ia = T[t * 3] * 3, ib = T[t * 3 + 1] * 3, ic = T[t * 3 + 2] * 3;
        const tx0 = Math.min(V[ia], V[ib], V[ic]) - r, tx1 = Math.max(V[ia], V[ib], V[ic]) + r;
        if (tx1 < bx0 || tx0 > bx1) continue;
        const ty0 = Math.min(V[ia + 1], V[ib + 1], V[ic + 1]) - r, ty1 = Math.max(V[ia + 1], V[ib + 1], V[ic + 1]) + r;
        if (ty1 < by0 || ty0 > by1) continue;
        const tz0 = Math.min(V[ia + 2], V[ib + 2], V[ic + 2]) - r, tz1 = Math.max(V[ia + 2], V[ib + 2], V[ic + 2]) + r;
        if (tz1 < bz0 || tz0 > bz1) continue;
        const e1 = (V[ia] - V[ib]) ** 2 + (V[ia + 1] - V[ib + 1]) ** 2 + (V[ia + 2] - V[ib + 2]) ** 2;
        const e2 = (V[ib] - V[ic]) ** 2 + (V[ib + 1] - V[ic + 1]) ** 2 + (V[ib + 2] - V[ic + 2]) ** 2;
        const e3 = (V[ic] - V[ia]) ** 2 + (V[ic + 1] - V[ia + 1]) ** 2 + (V[ic + 2] - V[ia + 2]) ** 2;
        if (Math.max(e1, e2, e3) <= t2) continue;
        for (let i = 0; i < nP; i++) {
          const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
          if (x < tx0 || x > tx1 || y < ty0 || y > ty1 || z < tz0 || z > tz1) continue;
          if (pointTriDist2(x, y, z, V, ia, ib, ic) <= r2) { marked[t] = 1; any++; break; }
        }
      }
      if (!any) break;
      if (maxTris && nT + any * 6 > maxTris) { limited = true; break; }
      const res = refineMarked(V, T, marked, Cr);
      V = res.verts; T = res.tris; Cr = res.carry;
    }
    return { verts: V, tris: T, carry: Cr, limited };
  }

  // ---------- mixed filaments in a Bambu project ----------
  // Names of settings that hold one value (or one block of values) per filament, from Bambu Studio's
  // preset definitions, plus the per-filament project lists. Anything else is a print/printer setting.
  const FILAMENT_KEYS = new Set(["activate_air_filtration", "additional_cooling_fan_speed", "additional_fan_full_speed_layer", "bed_type", "chamber_temperatures", "circle_compensation_speed", "close_additional_fan_first_x_layers", "close_fan_the_first_x_layers", "close_optional_fan_first_x_layers", "compatible_printers", "compatible_printers_condition", "compatible_prints", "compatible_prints_condition", "complete_print_exhaust_fan_speed", "cool_plate_temp", "cool_plate_temp_initial_layer", "cooling_perimeter_transition_distance", "cooling_slowdown_logic", "counter_coef_1", "counter_coef_2", "counter_coef_3", "counter_limit_max", "counter_limit_min", "default_filament_colour", "diameter_limit", "during_print_exhaust_fan_speed", "enable_overhang_bridge_fan", "enable_pressure_advance", "eng_plate_temp", "eng_plate_temp_initial_layer", "fan_cooling_layer_time", "fan_max_speed", "fan_min_speed", "filament_adaptive_volumetric_speed", "filament_adhesiveness_category", "filament_bridge_speed", "filament_change_length", "filament_change_length_nc", "filament_colour", "filament_colour_type", "filament_cooling_before_tower", "filament_cost", "filament_density", "filament_deretraction_speed", "filament_dev_ams_drying_ams_limitations", "filament_dev_ams_drying_heat_distortion_temperature", "filament_dev_ams_drying_temperature", "filament_dev_ams_drying_time", "filament_dev_chamber_drying_bed_temperature", "filament_dev_chamber_drying_time", "filament_dev_drying_cooling_temperature", "filament_dev_drying_softening_temperature", "filament_diameter", "filament_diameter_map", "filament_enable_overhang_speed", "filament_end_gcode", "filament_extruder_compatibility", "filament_extruder_variant", "filament_flow_ratio", "filament_flush_temp", "filament_flush_temp_fast", "filament_flush_volumetric_speed", "filament_idle_travel_cooling_enabled", "filament_ids", "filament_is_mixed", "filament_is_support", "filament_long_retractions_when_cut", "filament_map", "filament_max_volumetric_speed", "filament_metal_stickiness", "filament_minimal_purge_on_wipe_tower", "filament_mixed_components", "filament_mixed_gradient", "filament_mixed_gradient_curve", "filament_mixed_gradient_per_part", "filament_mixed_gradient_range", "filament_mixed_sublayer_ratios", "filament_multi_colour", "filament_notes", "filament_nozzle_map", "filament_overhang_1_4_speed", "filament_overhang_2_4_speed", "filament_overhang_3_4_speed", "filament_overhang_4_4_speed", "filament_overhang_totally_speed", "filament_pre_cooling_temperature", "filament_pre_cooling_temperature_nc", "filament_pre_heating_enabled", "filament_preheat_temperature_delta", "filament_prime_tower_speed_factor_curve", "filament_prime_volume", "filament_prime_volume_nc", "filament_printable", "filament_ramming_travel_time", "filament_ramming_travel_time_nc", "filament_ramming_volumetric_speed", "filament_ramming_volumetric_speed_nc", "filament_retract_before_wipe", "filament_retract_length_nc", "filament_retract_length_toolchange", "filament_retract_restart_extra", "filament_retract_restart_extra_toolchange", "filament_retract_when_changing_layer", "filament_retraction_distances_when_cut", "filament_retraction_length", "filament_retraction_minimum_travel", "filament_retraction_speed", "filament_scarf_gap", "filament_scarf_height", "filament_scarf_length", "filament_scarf_seam_type", "filament_settings_id", "filament_shrink", "filament_soluble", "filament_start_gcode", "filament_tower_interface_pre_extrusion_dist", "filament_tower_interface_pre_extrusion_length", "filament_tower_interface_print_temp", "filament_tower_interface_purge_volume", "filament_tower_ironing_area", "filament_type", "filament_velocity_adaptation_factor", "filament_vendor", "filament_volume_map", "filament_wipe", "filament_wipe_distance", "filament_z_hop", "filament_z_hop_types", "fins_extrude_safe_temp", "first_x_layer_fan_speed", "first_x_layer_optional_fan_speed", "first_x_layer_part_fan_speed", "flush_volumes_vector", "full_fan_speed_layer", "hole_coef_1", "hole_coef_2", "hole_coef_3", "hole_limit_max", "hole_limit_min", "hot_plate_temp", "hot_plate_temp_initial_layer", "impact_strength_z", "inherits", "ironing_fan_speed", "long_retractions_when_ec", "min_temperature_when_ec", "no_slow_down_for_cooling_on_outwalls", "nozzle_temperature", "nozzle_temperature_initial_layer", "nozzle_temperature_range_high", "nozzle_temperature_range_low", "optional_cooling_fan_speed", "optional_fan_full_speed_layer", "overhang_fan_speed", "overhang_fan_threshold", "overhang_threshold_participating_cooling", "override_process_overhang_speed", "pre_start_fan_time", "pressure_advance", "reduce_fan_stop_start_freq", "required_nozzle_HRC", "retraction_distances_when_ec", "slow_down_for_layer_cooling", "slow_down_layer_time", "slow_down_min_speed", "supertack_plate_temp", "supertack_plate_temp_initial_layer", "temperature_vitrification", "textured_plate_temp", "textured_plate_temp_initial_layer", "volumetric_speed_coefficients"]);
  const MIX_DEFAULTS = { filament_is_mixed: '0', filament_mixed_components: '', filament_mixed_sublayer_ratios: '',
    filament_mixed_gradient: '0', filament_mixed_gradient_range: '', filament_mixed_gradient_curve: '', filament_mixed_gradient_per_part: '0' };
  function filamentCount(st) { return (st.filament_colour || []).length; }
  function ratioString(weights) {
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    return weights.map(w => (w / sum).toFixed(4)).join(',');
  }
  /**
   * Append a Bambu mixed filament to the project settings.
   *
   * Every per-filament setting (see FILAMENT_KEYS) gets a copy of the first component's values, the
   * way Bambu Studio creates a mix; the N×N flush matrix grows to (N+1)×(N+1) using the purge value
   * Bambu used for an existing mix (280 if none). Bambu only treats it as a mix when
   * `enable_mixed_color_sublayer` is '1', so that is switched on too.
   *
   * @param {Object} settings Project settings; not modified.
   * @param {number[]} components 1-based physical slots (2 or 3).
   * @param {number[]} weights Relative amounts, same order (normalised to 4-decimal shares).
   * @param {string} color Preview colour '#RRGGBB' shown in the slicer.
   * @returns {Object} New settings; the mix is the last slot.
   */
  function addMix(settings, components, weights, color) {
    const st = JSON.parse(JSON.stringify(settings));
    const N = filamentCount(st);
    const src = components[0] - 1;
    for (const k in MIX_DEFAULTS) if (!Array.isArray(st[k]) || st[k].length !== N) st[k] = new Array(N).fill(MIX_DEFAULTS[k]);
    for (const k of Object.keys(st)) {
      const v = st[k];
      if (!Array.isArray(v) || !v.length) continue;
      if (k === 'flush_volumes_matrix') {
        const blocks = v.length / (N * N);
        if (!Number.isInteger(blocks)) continue;
        // value Bambu used for an existing mix row, else its default for mixes
        let fv = '280';
        const mixedIdx = (st.filament_is_mixed || []).findIndex(x => x === '1' || x === 1 || x === true);
        const out = [];
        for (let b = 0; b < blocks; b++) {
          const M = v.slice(b * N * N, (b + 1) * N * N);
          if (mixedIdx >= 0) fv = M[mixedIdx * N + (mixedIdx === 0 ? 1 : 0)];
          for (let r = 0; r <= N; r++) for (let c = 0; c <= N; c++) {
            if (r === c) out.push('0');
            else if (r < N && c < N) out.push(M[r * N + c]);
            else out.push(fv);
          }
        }
        st[k] = out; continue;
      }
      if (k === 'filament_self_index') {
        const per = v.length / N; if (!Number.isInteger(per)) continue;
        for (let i = 0; i < per; i++) v.push(String(N + 1));
        continue;
      }
      if (k === 'different_settings_to_system') {
        if (v.length === N + 2) v.splice(N + 1, 0, '');
        continue;
      }
      if (!FILAMENT_KEYS.has(k)) continue;
      const per = v.length / N;
      if (!Number.isInteger(per) || per < 1) continue;
      for (let i = 0; i < per; i++) v.push(v[src * per + i]);
    }
    const n = N; // new 0-based index
    st.filament_colour[n] = color;
    if (Array.isArray(st.filament_multi_colour) && st.filament_multi_colour.length === N + 1) st.filament_multi_colour[n] = color;
    st.filament_is_mixed[n] = '1';
    st.filament_mixed_components[n] = components.join(',');
    st.filament_mixed_sublayer_ratios[n] = ratioString(weights);
    st.filament_mixed_gradient[n] = '0';
    st.filament_mixed_gradient_range[n] = '';
    st.filament_mixed_gradient_curve[n] = '';
    st.filament_mixed_gradient_per_part[n] = '0';
    st.enable_mixed_color_sublayer = '1';
    return st;
  }
  /**
   * Change an existing mix's recipe and preview colour in place (slot numbers stay the same).
   * @param {Object} settings Not modified.
   * @param {number} slot 1-based slot of the mix.
   * @param {number[]} components 1-based physical slots.
   * @param {number[]} weights Relative amounts.
   * @param {string} color '#RRGGBB'.
   * @returns {Object} New settings.
   */
  function editMix(settings, slot, components, weights, color) {
    const st = JSON.parse(JSON.stringify(settings));
    const i = slot - 1;
    st.filament_mixed_components[i] = components.join(',');
    st.filament_mixed_sublayer_ratios[i] = ratioString(weights);
    st.filament_colour[i] = color;
    if (Array.isArray(st.filament_multi_colour)) st.filament_multi_colour[i] = color;
    return st;
  }
  /**
   * Remove a filament slot from every per-filament setting. Later slots move down by one, and mix
   * component lists are renumbered to match. Callers must remap triangle paint themselves.
   * @param {Object} settings Not modified.
   * @param {number} slot 1-based slot.
   * @returns {Object} New settings.
   */
  function deleteSlot(settings, slot) {
    const st = JSON.parse(JSON.stringify(settings));
    const N = filamentCount(st), j = slot - 1;
    for (const k of Object.keys(st)) {
      const v = st[k];
      if (!Array.isArray(v) || !v.length) continue;
      if (k === 'flush_volumes_matrix') {
        const blocks = v.length / (N * N);
        if (!Number.isInteger(blocks)) continue;
        const out = [];
        for (let b = 0; b < blocks; b++) for (let r = 0; r < N; r++) for (let c = 0; c < N; c++)
          if (r !== j && c !== j) out.push(v[b * N * N + r * N + c]);
        st[k] = out; continue;
      }
      if (k === 'filament_self_index') {
        const per = v.length / N; if (!Number.isInteger(per)) continue;
        v.splice(j * per, per);
        for (let i = 0; i < v.length; i++) if (+v[i] > slot) v[i] = String(+v[i] - 1);
        continue;
      }
      if (k === 'different_settings_to_system') { if (v.length === N + 2) v.splice(j + 1, 1); continue; }
      if (!FILAMENT_KEYS.has(k)) continue;
      const per = v.length / N;
      if (!Number.isInteger(per) || per < 1) continue;
      v.splice(j * per, per);
    }
    if (Array.isArray(st.filament_mixed_components)) st.filament_mixed_components = st.filament_mixed_components.map(c =>
      c ? c.split(',').map(x => (+x > slot ? +x - 1 : +x)).join(',') : c);
    return st;
  }
  // ---------- regular (physical) filaments ----------
  /**
   * Reorder (and optionally drop) filament slots in every per-filament setting, renumbering mix
   * components to follow.
   * @param {Object} settings Not modified.
   * @param {number[]} order `order[newIndex] = oldIndex`, 0-based. Slots not listed are dropped.
   * @returns {Object} New settings.
   */
  function permuteFilaments(settings, order) {
    const st = JSON.parse(JSON.stringify(settings));
    const N = filamentCount(st), M = order.length;
    const newOf = new Int32Array(N).fill(-1); order.forEach((o, i) => { newOf[o] = i; });
    for (const k of Object.keys(st)) {
      const v = st[k];
      if (!Array.isArray(v) || !v.length) continue;
      if (k === 'flush_volumes_matrix') {
        const blocks = v.length / (N * N); if (!Number.isInteger(blocks)) continue;
        const out = [];
        for (let b = 0; b < blocks; b++) for (let r = 0; r < M; r++) for (let c = 0; c < M; c++) out.push(v[b * N * N + order[r] * N + order[c]]);
        st[k] = out; continue;
      }
      if (k === 'filament_self_index') {
        const per = v.length / N; if (!Number.isInteger(per)) continue;
        const out = []; for (let i = 0; i < M; i++) for (let j = 0; j < per; j++) out.push(String(i + 1));
        st[k] = out; continue;
      }
      if (k === 'different_settings_to_system') {
        if (v.length === N + 2) st[k] = [v[0]].concat(order.map(o => v[o + 1])).concat([v[N + 1]]);
        continue;
      }
      if (!FILAMENT_KEYS.has(k)) continue;
      const per = v.length / N;
      if (!Number.isInteger(per) || per < 1) continue;
      const out = []; for (const o of order) for (let j = 0; j < per; j++) out.push(v[o * per + j]);
      st[k] = out;
    }
    if (Array.isArray(st.filament_mixed_components)) st.filament_mixed_components = st.filament_mixed_components.map(c =>
      c ? c.split(',').map(x => newOf[+x - 1] + 1).join(',') : c);
    return st;
  }
  function physicalCount(st) {
    const m = st.filament_is_mixed || [];
    let p = 0; for (let i = 0; i < filamentCount(st); i++) if (!(m[i] === '1' || m[i] === 1 || m[i] === true)) p++;
    return p;
  }
  /**
   * Add a real spool the way Bambu Studio does: after the last regular filament, before the mixes.
   *
   * Bambu requires all physical filaments to come before all mixes, so mixes shift up by one and
   * callers must remap paint for slots above the returned one.
   *
   * @param {Object} settings Not modified.
   * @param {string} color '#RRGGBB'.
   * @param {number} [copyFrom=1] 1-based slot whose print settings (and purge volumes) are copied.
   * @returns {{settings: Object, slot: number}} New settings and the new filament's 1-based slot.
   */
  function addPhysical(settings, color, copyFrom) {
    const N = filamentCount(settings), P = physicalCount(settings);
    // append a copy at the end (reuse the mix routine's array handling), then clear its mix fields
    let st = addMix(settings, [copyFrom || 1, copyFrom || 1], [1, 1], color);
    st.filament_is_mixed[N] = '0';
    st.filament_mixed_components[N] = ''; st.filament_mixed_sublayer_ratios[N] = '';
    st.filament_mixed_gradient[N] = '0'; st.filament_mixed_gradient_range[N] = ''; st.filament_mixed_gradient_curve[N] = ''; st.filament_mixed_gradient_per_part[N] = '0';
    if (Array.isArray(st.filament_colour_type) && st.filament_colour_type.length === N + 1) st.filament_colour_type[N] = '1';
    // its purge volumes: same as the filament it was copied from
    const src = (copyFrom || 1) - 1, M = N + 1;
    const fm = st.flush_volumes_matrix;
    if (Array.isArray(fm) && fm.length % (M * M) === 0) {
      for (let b = 0; b < fm.length / (M * M); b++) {
        const o = b * M * M;
        let hi = 0; for (let i = 0; i < N; i++) if (i !== src) hi = Math.max(hi, +fm[o + src * M + i] || 0, +fm[o + i * M + src] || 0);
        for (let i = 0; i < M; i++) {
          if (i === N) continue;
          fm[o + N * M + i] = i === src ? String(hi) : fm[o + src * M + i];
          fm[o + i * M + N] = i === src ? String(hi) : fm[o + i * M + src];
        }
      }
    }
    const order = []; for (let i = 0; i < P; i++) order.push(i); order.push(N); for (let i = P; i < N; i++) order.push(i);
    st = permuteFilaments(st, order);
    if (settings.enable_mixed_color_sublayer !== undefined) st.enable_mixed_color_sublayer = settings.enable_mixed_color_sublayer; else delete st.enable_mixed_color_sublayer;
    return { settings: st, slot: P + 1 };
  }

  /**
   * Order-independent key for a mix recipe, e.g. '#0090DA:70|#FCE300:30'. Used to look up colours
   * Bambu Studio reported for a recipe in a loaded project, and the swatch tile numbers.
   * @param {string[]} hexes Component colours.
   * @param {number[]} ratios Relative amounts (rounded to whole percent).
   * @returns {string}
   */
  function mixKey(hexes, ratios) {
    const sum = ratios.reduce((a, b) => a + b, 0) || 1;
    return hexes.map((h, i) => h.toUpperCase() + ':' + Math.round(100 * ratios[i] / sum)).sort().join('|');
  }

  // ---------- small binary min-heap (number keys, int payloads) ----------
  function Heap() { this.k = []; this.v = []; }
  Heap.prototype.push = function (key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  };
  Heap.prototype.pop = function () {
    const k = this.k, v = this.v, topK = k[0], topV = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    this.topKey = topK; return topV;
  };
  Heap.prototype.size = function () { return this.k.length; };

  // ---------- lasso shapes ----------
  // A closed line (walls = triangles it crosses, indexed into segs) splits the surface in two. The inside is the
  // smaller side; line triangles go to whichever side they lie on. Returns triangle list, or null if not closed.
  function lassoRegion(adj, wall, segs, normals, cent, area) {
    const nT = wall.length;
    // areas separated by the line, then each area votes on which side of the line it lies
    const comp = new Int32Array(nT).fill(-1), compA = [], vote = [];
    const flood = (start, id) => {
      const st = [start]; comp[start] = id; let a = 0;
      while (st.length) { const t = st.pop(); a += area[t]; for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && wall[n] < 0 && comp[n] < 0) { comp[n] = id; st.push(n); } } }
      return a;
    };
    for (let w = 0; w < nT; w++) {
      if (wall[w] < 0) continue;
      for (let e = 0; e < 3; e++) {
        const t = adj[w * 3 + e];
        if (t < 0 || wall[t] >= 0) continue;
        if (comp[t] < 0) { compA.push(flood(t, compA.length)); vote.push(0); }
        vote[comp[t]] += lineSide(t, wall[w], segs, normals, cent);
      }
    }
    if (compA.length < 2) return null; // the line does not close: one area touches both sides
    let aP = 0, aN = 0;
    const sign = vote.map((v, i) => { const sg = v >= 0 ? 1 : -1; if (sg > 0) aP += compA[i]; else aN += compA[i]; return sg; });
    let insideSign;
    if (aP === 0 || aN === 0) { // all areas voted alike: everything but the biggest area is inside
      let big = 0; for (let i = 1; i < compA.length; i++) if (compA[i] > compA[big]) big = i;
      for (let i = 0; i < sign.length; i++) sign[i] = i === big ? -1 : 1;
      insideSign = 1; aP = 1; aN = 2;
    } else insideSign = aP <= aN ? 1 : -1;
    const out = [];
    for (let t = 0; t < nT; t++) {
      if (wall[t] >= 0) { if (lineSide(t, wall[t], segs, normals, cent) === insideSign) out.push(t); }
      else if (sign[comp[t]] === insideSign) out.push(t);
    }
    return out;
  }

  // ---------- brush strokes as shapes ----------
  // caps: flat list of capsules [x0,y0,z0,r0, x1,y1,z1,r1, ...] (a stroke is a chain of these).
  function capsInfo(caps) {
    const n = caps.length / 8, box = new Float64Array(n * 6);
    let gx0 = 1e18, gy0 = 1e18, gz0 = 1e18, gx1 = -1e18, gy1 = -1e18, gz1 = -1e18;
    for (let i = 0; i < n; i++) {
      const o = i * 8, r = Math.max(caps[o + 3], caps[o + 7]);
      const x0 = Math.min(caps[o], caps[o + 4]) - r, x1 = Math.max(caps[o], caps[o + 4]) + r;
      const y0 = Math.min(caps[o + 1], caps[o + 5]) - r, y1 = Math.max(caps[o + 1], caps[o + 5]) + r;
      const z0 = Math.min(caps[o + 2], caps[o + 6]) - r, z1 = Math.max(caps[o + 2], caps[o + 6]) + r;
      box[i * 6] = x0; box[i * 6 + 1] = y0; box[i * 6 + 2] = z0; box[i * 6 + 3] = x1; box[i * 6 + 4] = y1; box[i * 6 + 5] = z1;
      gx0 = Math.min(gx0, x0); gy0 = Math.min(gy0, y0); gz0 = Math.min(gz0, z0); gx1 = Math.max(gx1, x1); gy1 = Math.max(gy1, y1); gz1 = Math.max(gz1, z1);
    }
    return { n, box, all: [gx0, gy0, gz0, gx1, gy1, gz1] };
  }
  function insideCaps(caps, info, x, y, z) {
    const a = info.all;
    if (x < a[0] || x > a[3] || y < a[1] || y > a[4] || z < a[2] || z > a[5]) return false;
    const B = info.box;
    for (let i = 0; i < info.n; i++) {
      const b = i * 6;
      if (x < B[b] || x > B[b + 3] || y < B[b + 1] || y > B[b + 4] || z < B[b + 2] || z > B[b + 5]) continue;
      const o = i * 8, ax = caps[o], ay = caps[o + 1], az = caps[o + 2];
      const dx = caps[o + 4] - ax, dy = caps[o + 5] - ay, dz = caps[o + 6] - az;
      const L2 = dx * dx + dy * dy + dz * dz;
      let u = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const r = caps[o + 3] + (caps[o + 7] - caps[o + 3]) * u;
      const ex = x - ax - dx * u, ey = y - ay - dy * u, ez = z - az - dz * u;
      if (ex * ex + ey * ey + ez * ez <= r * r) return true;
    }
    return false;
  }
  // Refine the mesh where the stroke's outline crosses triangles, so the painted edge can follow
  // the round brush shape instead of whole triangles. Returns { verts, tris, carry, limited }.
  function refineAlongCaps(verts, tris, carry, caps, target, maxTris) {
    let V = verts, T = tris, Cr = carry, limited = false;
    if (!caps.length) return { verts: V, tris: T, carry: Cr, limited };
    const info = capsInfo(caps), t2 = target * target, a = info.all;
    for (let level = 0; level < 10; level++) {
      const nV = V.length / 3, nT = T.length / 3;
      const ins = new Int8Array(nV); // 0 = not tested, 1 = inside, 2 = outside
      const test = v => {
        if (ins[v]) return ins[v] === 1;
        const r = insideCaps(caps, info, V[v * 3], V[v * 3 + 1], V[v * 3 + 2]); ins[v] = r ? 1 : 2; return r;
      };
      const marked = new Uint8Array(nT); let any = 0;
      for (let t = 0; t < nT; t++) {
        const ia = T[t * 3], ib = T[t * 3 + 1], ic = T[t * 3 + 2];
        const ax = V[ia * 3], ay = V[ia * 3 + 1], az = V[ia * 3 + 2];
        const bx = V[ib * 3], by = V[ib * 3 + 1], bz = V[ib * 3 + 2], cx = V[ic * 3], cy = V[ic * 3 + 1], cz = V[ic * 3 + 2];
        if (Math.max(ax, bx, cx) < a[0] || Math.min(ax, bx, cx) > a[3] || Math.max(ay, by, cy) < a[1] || Math.min(ay, by, cy) > a[4] || Math.max(az, bz, cz) < a[2] || Math.min(az, bz, cz) > a[5]) continue;
        const e1 = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2, e2 = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2, e3 = (cx - ax) ** 2 + (cy - ay) ** 2 + (cz - az) ** 2;
        if (Math.max(e1, e2, e3) <= t2) continue;
        const A = test(ia);
        let cross = A !== test(ib) || A !== test(ic);
        if (!cross) // an edge can still dip into a thin stroke: check edge midpoints and the centre
          cross = insideCaps(caps, info, (ax + bx) / 2, (ay + by) / 2, (az + bz) / 2) !== A || insideCaps(caps, info, (bx + cx) / 2, (by + cy) / 2, (bz + cz) / 2) !== A ||
            insideCaps(caps, info, (cx + ax) / 2, (cy + ay) / 2, (cz + az) / 2) !== A || insideCaps(caps, info, (ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3) !== A;
        if (cross) { marked[t] = 1; any++; }
      }
      if (!any) break;
      if (maxTris && nT + any * 6 > maxTris) { limited = true; break; }
      const res = refineMarked(V, T, marked, Cr);
      V = res.verts; T = res.tris; Cr = res.carry;
    }
    return { verts: V, tris: T, carry: Cr, limited };
  }
  /**
   * Stable dither threshold in [0,1) for a point: 80% ordered 4×4 Bayer + 20% hash noise.
   * Points in the same `cell` share a value, so printed specks are at least a nozzle wide.
   * The original 0.6 mm speck pattern, superseded by {@link shadeThreshold}. Only used when
   * app.js has `S.ditherMode === 'dots'`, which the UI never sets (kept for comparison).
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {number} cell Cell size in mm.
   * @returns {number}
   */
  function ditherValue(x, y, z, cell) {
    const i = Math.floor(x / cell), j = Math.floor(y / cell), k = Math.floor(z / cell);
    const u = ((i + k * 2) % 4 + 4) % 4, v = ((j + k * 3) % 4 + 4) % 4;
    let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177); h = (h ^ (h >>> 16)) >>> 0;
    return (BAYER4[u * 4 + v] + 0.5) / 16 * 0.8 + (h / 4294967296) * 0.2;
  }
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const BAYER8_1D = [0, 4, 2, 6, 1, 5, 3, 7];
  /**
   * Dither threshold in [0,1) that decides which shading step a triangle gets.
   *
   * Why two patterns: a print of 0.6 mm specks came out bumpy and noisy. On sides (|nz| < 0.7) the
   * steps alternate in horizontal stripes `band` mm tall that follow the layers, so each layer prints
   * one continuous colour patch; the 4-stripe order (0,2,1,3) repeats every 4 × band. On flat-ish
   * faces stripes can't show, so a 4×4 ordered dot pattern of `cell` mm (several nozzle widths) is used.
   *
   * @param {number} x Triangle centroid, mm.
   * @param {number} y
   * @param {number} z
   * @param {number} nz Z component of the triangle's unit normal.
   * @param {number} [band=0.4] Stripe height on sides, mm.
   * @param {number} [cell=1.2] Dot cell size on flat faces, mm.
   * @returns {number} Compare with the shading level: level > threshold → darker step.
   */
  function shadeThreshold(x, y, z, nz, band, cell) {
    band = band || 0.4; cell = cell || 1.2;
    if (Math.abs(nz) < 0.7) { const b = Math.floor(z / band); return ([0, 2, 1, 3][((b % 4) + 4) % 4] + 0.5) / 4; } // repeats every 4 stripes
    const i = Math.floor(x / cell), j = Math.floor(y / cell);
    return (BAYER4[(((i % 4) + 4) % 4) * 4 + (((j % 4) + 4) % 4)] + 0.5) / 16;
  }


  // ---------- surface shading helpers ----------
  // Per-triangle brightness that darkens hollows and creases a little (for seeing the shape while painting).
  function cavityShade(adj, normals, cent, nT, strength) {
    let c = new Float32Array(nT);
    for (let t = 0; t < nT; t++) {
      let s = 0;
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e]; if (n < 0) continue;
        const d = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
        const dx = cent[n * 3] - cent[t * 3], dy = cent[n * 3 + 1] - cent[t * 3 + 1], dz = cent[n * 3 + 2] - cent[t * 3 + 2];
        const cc = (normals[t * 3] - normals[n * 3]) * dx + (normals[t * 3 + 1] - normals[n * 3 + 1]) * dy + (normals[t * 3 + 2] - normals[n * 3 + 2]) * dz;
        s += (cc > 0 ? -1 : 0.35) * (1 - d);
      }
      c[t] = s;
    }
    for (let it = 0; it < 3; it++) { // soften so it reads as shading, not noise
      const nc = new Float32Array(nT);
      for (let t = 0; t < nT; t++) { let s = c[t] * 2, k = 2; for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0) { s += c[n]; k++; } } nc[t] = s / k; }
      c = nc;
    }
    const k = strength || 3, out = new Float32Array(nT);
    for (let t = 0; t < nT; t++) out[t] = Math.max(0.35, Math.min(1.12, 1 + k * c[t]));
    return out;
  }
  // Edges where the surface bends more than angle degrees (for drawing crease lines).
  function creaseEdges(tris, adj, normals, angleDeg) {
    const cosA = Math.cos(angleDeg * Math.PI / 180), out = [];
    const nT = tris.length / 3;
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e]; if (n <= t) continue;
      const d = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
      if (d < cosA) out.push(t, e, n);
    }
    return out;
  }

  // ---------- parts: automatic segmentation ----------
  // Edges between faces get a weight from how sharply they bend; concave creases (valleys, where parts meet)
  // count far more than convex ones. Faces are grouped along low-weight edges (graph segmentation),
  // then neighbouring groups are merged cheapest-first, recording the order so any part count can be shown instantly.
  function segmentParts(verts, tris, adj, normals, cent, area, opts) {
    opts = opts || {};
    const nT = tris.length / 3;
    let total = 0;
    for (let t = 0; t < nT; t++) total += area[t];
    // 1. patches: triangles in the same grid cell that are connected to each other
    const h = Math.sqrt(total / (opts.patches || 30000));
    const cellOf = t => Math.floor(cent[t * 3] / h) * 73856093 ^ Math.floor(cent[t * 3 + 1] / h) * 19349663 ^ Math.floor(cent[t * 3 + 2] / h) * 83492791;
    const cell = new Int32Array(nT);
    for (let t = 0; t < nT; t++) cell[t] = cellOf(t);
    const base = new Int32Array(nT).fill(-1);
    let nBase = 0;
    const stack = [];
    for (let s0 = 0; s0 < nT; s0++) {
      if (base[s0] >= 0) continue;
      base[s0] = nBase; stack.push(s0);
      while (stack.length) {
        const t = stack.pop();
        for (let e = 0; e < 3; e++) {
          const n = adj[t * 3 + e];
          if (n < 0 || base[n] >= 0 || cell[n] !== cell[t]) continue;
          base[n] = nBase; stack.push(n);
        }
      }
      nBase++;
    }
    // patch area, normal, centre
    const pA = new Float64Array(nBase), pN = new Float64Array(nBase * 3), pC = new Float64Array(nBase * 3);
    for (let t = 0; t < nT; t++) {
      const p = base[t], a = area[t];
      pA[p] += a;
      for (let c = 0; c < 3; c++) { pN[p * 3 + c] += normals[t * 3 + c] * a; pC[p * 3 + c] += cent[t * 3 + c] * a; }
    }
    for (let p = 0; p < nBase; p++) {
      const l = Math.hypot(pN[p * 3], pN[p * 3 + 1], pN[p * 3 + 2]) || 1;
      for (let c = 0; c < 3; c++) { pN[p * 3 + c] /= l; pC[p * 3 + c] /= (pA[p] || 1); }
    }
    // 2. patch graph: shared border length and how sharply / which way the surface bends there
    const nb = []; for (let p = 0; p < nBase; p++) nb.push(new Map());
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e]; if (n <= t) continue;
      const a = base[t], b = base[n]; if (a === b) continue;
      const va = tris[t * 3 + e] * 3, vb = tris[t * 3 + (e + 1) % 3] * 3;
      const len = Math.hypot(verts[va] - verts[vb], verts[va + 1] - verts[vb + 1], verts[va + 2] - verts[vb + 2]);
      let v = nb[a].get(b); if (!v) { nb[a].set(b, v = [0, 0]); nb[b].set(a, v); }
      v[0] += len;
    }
    const bendW = (a, b) => {
      const d = pN[a * 3] * pN[b * 3] + pN[a * 3 + 1] * pN[b * 3 + 1] + pN[a * 3 + 2] * pN[b * 3 + 2];
      const dx = pC[b * 3] - pC[a * 3], dy = pC[b * 3 + 1] - pC[a * 3 + 1], dz = pC[b * 3 + 2] - pC[a * 3 + 2];
      const s = (pN[a * 3] - pN[b * 3]) * dx + (pN[a * 3 + 1] - pN[b * 3 + 1]) * dy + (pN[a * 3 + 2] - pN[b * 3 + 2]) * dz;
      const bend = Math.max(0, 1 - Math.max(-1, Math.min(1, d)));
      return 0.002 + (s > 0 ? bend : bend * 0.12);
    };
    for (let a = 0; a < nBase; a++) for (const [b, v] of nb[a]) if (a < b) v[1] = v[0] * bendW(a, b);
    // copy shared records so each side owns its own
    for (let a = 0; a < nBase; a++) for (const [b, v] of nb[a]) if (a < b) nb[b].set(a, v.slice());
    // 3. merge cheapest neighbours first; small patches and gentle/convex borders go first
    const rArea = Float64Array.from(pA);
    const cost = (a, b, v) => (v[1] / Math.max(v[0], 1e-12)) * Math.sqrt(Math.min(rArea[a], rArea[b]) / total);
    const ver = new Int32Array(nBase), alive = new Uint8Array(nBase).fill(1);
    const heap = new Heap();
    const pairs = [];
    const pushPair = (a, b) => { const v = nb[a].get(b); pairs.push([a, b, ver[a], ver[b]]); heap.push(cost(a, b, v), pairs.length - 1); };
    for (let a = 0; a < nBase; a++) for (const b of nb[a].keys()) if (a < b) pushPair(a, b);
    const merges = [], costs = [];
    while (heap.size()) {
      const pi = heap.pop(), c = heap.topKey;
      const [a0, b0, va, vb] = pairs[pi];
      if (!alive[a0] || !alive[b0] || ver[a0] !== va || ver[b0] !== vb) continue;
      let a = a0, b = b0;
      if (nb[a].size < nb[b].size) { a = b0; b = a0; }
      merges.push(a, b); costs.push(c);
      alive[b] = 0; rArea[a] += rArea[b]; ver[a]++;
      nb[a].delete(b);
      for (const [n, v] of nb[b]) {
        if (n === a) continue;
        let w = nb[a].get(n); if (!w) nb[a].set(n, w = [0, 0]);
        w[0] += v[0]; w[1] += v[1];
        nb[n].delete(b); nb[n].set(a, w.slice());
      }
      nb[b] = new Map();
      for (const [n, v] of nb[a]) { nb[n].set(a, v.slice()); pushPair(a, n); }
    }
    return { base, nBase, merges: Int32Array.from(merges), costs: Float32Array.from(costs) };
  }
  // ---------- parts by sculpted lines ----------
  // Regions are the areas enclosed by sharp lines in the sculpt (outlines around eyes, spots, panels),
  // the way people usually paint. Small gaps in a line are bridged; weak lines merge away first.
  function segmentLines(verts, tris, adj, normals, cent, area, opts) {
    opts = opts || {};
    const nT = tris.length / 3, cosF = Math.cos((opts.angle || 30) * Math.PI / 180);
    let total = 0; for (let t = 0; t < nT; t++) total += area[t];
    // per-edge bend angle (cosine) and feature flag
    const ecos = new Float32Array(nT * 3).fill(1);
    const feat = new Uint8Array(nT * 3);
    const sharp = new Float32Array(nT); // strongest bend at each face (1 - cos)
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e]; if (n < 0) continue;
      const d = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
      ecos[t * 3 + e] = d;
      if (d < cosF) feat[t * 3 + e] = 1;
      sharp[t] = Math.max(sharp[t], 1 - d);
    }
    // carry lines on through gentler bends where an outline fades (hysteresis, like edge detection in images)
    if (opts.extend !== 0) {
      const cosL = Math.cos((opts.low || 15) * Math.PI / 180), steps = opts.extend || 20;
      const vOn = new Uint8Array(verts.length / 3);
      const mark = (t, e) => { vOn[tris[t * 3 + e]] = 1; vOn[tris[t * 3 + (e + 1) % 3]] = 1; };
      for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) if (feat[t * 3 + e]) mark(t, e);
      for (let it = 0; it < steps; it++) {
        const add = [];
        for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
          if (feat[t * 3 + e] || adj[t * 3 + e] < 0 || ecos[t * 3 + e] >= cosL) continue;
          if (vOn[tris[t * 3 + e]] || vOn[tris[t * 3 + (e + 1) % 3]]) add.push(t * 3 + e);
        }
        if (!add.length) break;
        for (const k of add) {
          const t = (k / 3) | 0, e = k % 3, n = adj[k];
          feat[k] = 1; mark(t, e);
          for (let f = 0; f < 3; f++) if (adj[n * 3 + f] === t) feat[n * 3 + f] = 1;
        }
      }
    }
    // 1. band around the lines (bridges small gaps), flood the rest into regions
    const band = new Uint8Array(nT);
    let ring = [];
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) if (feat[t * 3 + e]) { band[t] = 1; ring.push(t); break; }
    for (let r = 0; r < (opts.gap != null ? opts.gap : 1); r++) {
      const next = [];
      for (const t of ring) for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && !band[n]) { band[n] = 1; next.push(n); } }
      ring = next;
    }
    const base = new Int32Array(nT).fill(-1);
    let nBase = 0;
    const stack = [];
    for (let s = 0; s < nT; s++) {
      if (band[s] || base[s] >= 0) continue;
      base[s] = nBase; stack.push(s);
      while (stack.length) {
        const t = stack.pop();
        for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && !band[n] && base[n] < 0) { base[n] = nBase; stack.push(n); } }
      }
      nBase++;
    }
    // 2. grow regions into the band without crossing a line
    let front = [];
    for (let t = 0; t < nT; t++) if (base[t] >= 0) front.push(t);
    while (front.length) {
      const next = [];
      for (const t of front) for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || base[n] >= 0 || feat[t * 3 + e]) continue;
        base[n] = base[t]; next.push(n);
      }
      front = next;
    }
    // 3. what is left lies between two lines (the walls of raised or recessed details): own regions
    for (let s = 0; s < nT; s++) {
      if (base[s] >= 0) continue;
      base[s] = nBase; stack.push(s);
      while (stack.length) {
        const t = stack.pop();
        for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && base[n] < 0 && !feat[t * 3 + e]) { base[n] = nBase; stack.push(n); } }
      }
      nBase++;
    }
    // 4. region graph: border length and how sharp the border is (strongest bend on either side, convex counted fully)
    const rArea = new Float64Array(nBase);
    for (let t = 0; t < nT; t++) rArea[base[t]] += area[t];
    const nb = []; for (let r = 0; r < nBase; r++) nb.push(new Map());
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e]; if (n <= t) continue;
      const a = base[t], b = base[n]; if (a === b) continue;
      const va = tris[t * 3 + e] * 3, vb = tris[t * 3 + (e + 1) % 3] * 3;
      const len = Math.hypot(verts[va] - verts[vb], verts[va + 1] - verts[vb + 1], verts[va + 2] - verts[vb + 2]);
      let v = nb[a].get(b); if (!v) { nb[a].set(b, v = [0, 0]); nb[b].set(a, v); }
      v[0] += len; if (feat[t * 3 + e]) v[1] += len;
    }
    for (let a = 0; a < nBase; a++) for (const [b, v] of nb[a]) if (a < b) nb[b].set(a, v.slice());
    // 5. merge: tiny bits first (whatever their border), then the weakest lines
    const tiny = (opts.tiny != null ? opts.tiny : 0.00003) * total;
    const cost = (a, b, v) => {
      const s = v[1] / Math.max(v[0], 1e-12);
      const m = Math.min(rArea[a], rArea[b]);
      return m < tiny ? -1 + m / tiny - 0.001 * s : s;
    };
    const ver = new Int32Array(nBase), alive = new Uint8Array(nBase).fill(1);
    const heap = new Heap(), pairs = [];
    const pushPair = (a, b) => { const v = nb[a].get(b); pairs.push([a, b, ver[a], ver[b]]); heap.push(cost(a, b, v), pairs.length - 1); };
    for (let a = 0; a < nBase; a++) for (const b of nb[a].keys()) if (a < b) pushPair(a, b);
    const merges = [], costs = [];
    while (heap.size()) {
      const pi = heap.pop(), c = heap.topKey;
      const [a0, b0, va, vb] = pairs[pi];
      if (!alive[a0] || !alive[b0] || ver[a0] !== va || ver[b0] !== vb) continue;
      let a = a0, b = b0;
      if (nb[a].size < nb[b].size) { a = b0; b = a0; }
      merges.push(a, b); costs.push(c);
      alive[b] = 0; rArea[a] += rArea[b]; ver[a]++;
      nb[a].delete(b);
      for (const [n, v] of nb[b]) {
        if (n === a) continue;
        let w = nb[a].get(n); if (!w) nb[a].set(n, w = [0, 0]);
        w[0] += v[0]; w[1] += v[1];
        nb[n].delete(b); nb[n].set(a, w.slice());
      }
      nb[b] = new Map();
      for (const [n, v] of nb[a]) { nb[n].set(a, v.slice()); pushPair(a, n); }
    }
    return { base, nBase, merges: Int32Array.from(merges), costs: Float32Array.from(costs), method: 'lines' };
  }
  // Suggested count for line-based parts: keep every region whose borders are clearly sharp lines.
  function suggestLineParts(nBase, costs, minStrength) {
    const lim = minStrength != null ? minStrength : 0.5; // keep borders that run mostly along sculpted lines
    let applied = 0;
    while (applied < costs.length && costs[applied] < lim) applied++;
    return Math.max(nBase - costs.length, Math.min(nBase, nBase - applied));
  }

  // ---------- parts by sculpted lines + folds (default) ----------
  // Like a person colouring a figure: areas enclosed by sculpted lines, where raised details keep their sides,
  // recesses give their walls to the surface around them, engraved lines stay as their own strip,
  // and separate pieces (arms, legs, head) split where they fold into each other.
  function segmentCombined(verts, tris, adj, normals, cent, area, opts) {
    opts = opts || {};
    const nT = tris.length / 3, cosF = Math.cos((opts.angle || 30) * Math.PI / 180);
    let total = 0; for (let t = 0; t < nT; t++) total += area[t];
    const ecos = new Float32Array(nT * 3).fill(1), feat = new Uint8Array(nT * 3), conc = new Uint8Array(nT * 3);
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e]; if (n < 0) continue;
      const d = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
      ecos[t * 3 + e] = d;
      if (d < cosF) feat[t * 3 + e] = 1;
      const dx = cent[n * 3] - cent[t * 3], dy = cent[n * 3 + 1] - cent[t * 3 + 1], dz = cent[n * 3 + 2] - cent[t * 3 + 2];
      if ((normals[t * 3] - normals[n * 3]) * dx + (normals[t * 3 + 1] - normals[n * 3 + 1]) * dy + (normals[t * 3 + 2] - normals[n * 3 + 2]) * dz > 0) conc[t * 3 + e] = 1;
    }
    { // continue lines through gentler bends where an outline fades
      const cosL = Math.cos((opts.low || 15) * Math.PI / 180), steps = opts.extend != null ? opts.extend : 20;
      const vOn = new Uint8Array(verts.length / 3);
      const mark = (t, e) => { vOn[tris[t * 3 + e]] = 1; vOn[tris[t * 3 + (e + 1) % 3]] = 1; };
      for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) if (feat[t * 3 + e]) mark(t, e);
      for (let it = 0; it < steps; it++) {
        const add = [];
        for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
          if (feat[t * 3 + e] || adj[t * 3 + e] < 0 || ecos[t * 3 + e] >= cosL) continue;
          if (vOn[tris[t * 3 + e]] || vOn[tris[t * 3 + (e + 1) % 3]]) add.push(t * 3 + e);
        }
        if (!add.length) break;
        for (const k of add) { const t = (k / 3) | 0, e = k % 3, n = adj[k]; feat[k] = 1; mark(t, e); for (let f = 0; f < 3; f++) if (adj[n * 3 + f] === t) feat[n * 3 + f] = 1; }
      }
    }
    // 1-3. line regions (as segmentLines)
    const band = new Uint8Array(nT); let ring = [];
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) if (feat[t * 3 + e]) { band[t] = 1; ring.push(t); break; }
    for (let r = 0; r < 1; r++) { const nx = []; for (const t of ring) for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && !band[n]) { band[n] = 1; nx.push(n); } } ring = nx; }
    const lr = new Int32Array(nT).fill(-1); let nL = 0; const stack = [];
    for (let s = 0; s < nT; s++) {
      if (band[s] || lr[s] >= 0) continue;
      lr[s] = nL; stack.push(s);
      while (stack.length) { const t = stack.pop(); for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && !band[n] && lr[n] < 0) { lr[n] = nL; stack.push(n); } } }
      nL++;
    }
    const nOpen = nL;
    let front = []; for (let t = 0; t < nT; t++) if (lr[t] >= 0) front.push(t);
    while (front.length) { const nx = []; for (const t of front) for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n < 0 || lr[n] >= 0 || feat[t * 3 + e]) continue; lr[n] = lr[t]; nx.push(n); } front = nx; }
    for (let s = 0; s < nT; s++) {
      if (lr[s] >= 0) continue;
      lr[s] = nL; stack.push(s);
      while (stack.length) { const t = stack.pop(); for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && lr[n] < 0 && !feat[t * 3 + e]) { lr[n] = nL; stack.push(n); } } }
      nL++;
    }
    // 4. walls (regions squeezed between two lines): grooves stay together, other walls join the side across their convex edge
    const lA = new Float64Array(nL); for (let t = 0; t < nT; t++) lA[lr[t]] += area[t];
    const isWall = r => r >= nOpen;
    const cvx = [], ccv = []; for (let r = 0; r < nL; r++) { cvx.push(null); ccv.push(null); }
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e]; if (n < 0) continue;
      const a = lr[t], b = lr[n]; if (a === b || !isWall(a)) continue;
      const va = tris[t * 3 + e] * 3, vb = tris[t * 3 + (e + 1) % 3] * 3;
      const len = Math.hypot(verts[va] - verts[vb], verts[va + 1] - verts[vb + 1], verts[va + 2] - verts[vb + 2]);
      const m = conc[t * 3 + e] ? (ccv[a] || (ccv[a] = new Map())) : (cvx[a] || (cvx[a] = new Map()));
      m.set(b, (m.get(b) || 0) + len);
    }
    const up = new Int32Array(nL); for (let i = 0; i < nL; i++) up[i] = i;
    const find = x => { while (up[x] !== x) { up[x] = up[up[x]]; x = up[x]; } return x; };
    const join = (a, b) => { a = find(a); b = find(b); if (a !== b) up[a] = b; };
    const big = (opts.wallMax != null ? opts.wallMax : 0.004) * total;
    // group touching wall pieces (a stepped wall is often split into several thin pieces)
    for (let r = nOpen; r < nL; r++) {
      if (lA[r] >= big) continue;
      for (const m of [ccv[r], cvx[r]]) if (m) for (const [b] of m) if (isWall(b) && lA[b] < big) join(r, b);
    }
    // per group: border with open areas across convex edges (a lip or the top of a raised detail)
    // and across concave edges (the floor of a recess or the surface a raised detail stands on)
    const gCv = new Map(), gCc = new Map();
    const add = (M, g, b, l) => { let m = M.get(g); if (!m) M.set(g, m = new Map()); m.set(b, (m.get(b) || 0) + l); };
    for (let r = nOpen; r < nL; r++) {
      if (lA[r] >= big) continue;
      const g = find(r);
      if (cvx[r]) for (const [b, l] of cvx[r]) if (!isWall(b) || lA[b] >= big) add(gCv, g, b, l);
      if (ccv[r]) for (const [b, l] of ccv[r]) if (!isWall(b) || lA[b] >= big) add(gCc, g, b, l);
    }
    // a groove only meets open areas across its lips; any other wall joins the side across its convex edge
    for (const [g, m] of gCv) {
      let cv = 0, best = -1, bl = 0;
      for (const [b, l] of m) { cv += l; if (l > bl) { bl = l; best = b; } }
      let cc = 0; const mc = gCc.get(g); if (mc) for (const l of mc.values()) cc += l;
      if (cc > 0.25 * cv && best >= 0) join(g, best);
    }
    const lab = new Int32Array(nT); for (let t = 0; t < nT; t++) lab[t] = find(lr[t]);
    { // fragments too small to matter join the neighbouring area they share most border with
      const tinyA = (opts.tiny != null ? opts.tiny : 0.0001) * total;
      for (let pass = 0; pass < 3; pass++) {
        const A = new Map(); for (let t = 0; t < nT; t++) A.set(lab[t], (A.get(lab[t]) || 0) + area[t]);
        const bord = new Map();
        for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
          const n = adj[t * 3 + e]; if (n < 0 || lab[n] === lab[t] || A.get(lab[t]) >= tinyA) continue;
          let m = bord.get(lab[t]); if (!m) bord.set(lab[t], m = new Map());
          m.set(lab[n], (m.get(lab[n]) || 0) + 1);
        }
        if (!bord.size) break;
        const to = new Map();
        for (const [r, m] of bord) { let best = -1, bc = 0; for (const [b, c] of m) if (c > bc && (A.get(b) >= tinyA || b < r)) { bc = c; best = b; } if (best >= 0) to.set(r, best); }
        const res = r => { let k = 0; while (to.has(r) && k++ < 50) r = to.get(r); return r; };
        for (let t = 0; t < nT; t++) lab[t] = res(lab[t]);
      }
    }
    if (opts.debugLab) return { lab, lr, nOpen, nL };
    // 5. patches inside each line region, for measuring folds
    const h = Math.sqrt(total / (opts.patches || 20000));
    const cellOf = t => Math.floor(cent[t * 3] / h) * 73856093 ^ Math.floor(cent[t * 3 + 1] / h) * 19349663 ^ Math.floor(cent[t * 3 + 2] / h) * 83492791;
    const cell = new Int32Array(nT); for (let t = 0; t < nT; t++) cell[t] = cellOf(t);
    const base = new Int32Array(nT).fill(-1); let nBase = 0;
    for (let s = 0; s < nT; s++) {
      if (base[s] >= 0) continue;
      base[s] = nBase; stack.push(s);
      while (stack.length) { const t = stack.pop(); for (let e = 0; e < 3; e++) { const n = adj[t * 3 + e]; if (n >= 0 && base[n] < 0 && cell[n] === cell[t] && lab[n] === lab[t]) { base[n] = nBase; stack.push(n); } } }
      nBase++;
    }
    const pA = new Float64Array(nBase), pN = new Float64Array(nBase * 3), pC = new Float64Array(nBase * 3);
    for (let t = 0; t < nT; t++) { const p = base[t], a = area[t]; pA[p] += a; for (let c = 0; c < 3; c++) { pN[p * 3 + c] += normals[t * 3 + c] * a; pC[p * 3 + c] += cent[t * 3 + c] * a; } }
    for (let p = 0; p < nBase; p++) { const l = Math.hypot(pN[p * 3], pN[p * 3 + 1], pN[p * 3 + 2]) || 1; for (let c = 0; c < 3; c++) { pN[p * 3 + c] /= l; pC[p * 3 + c] /= (pA[p] || 1); } }
    // 6. patch graph: border length, length on a sculpted line between different line regions, and the fold
    const nb = []; for (let p = 0; p < nBase; p++) nb.push(new Map());
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e]; if (n <= t) continue;
      const a = base[t], b = base[n]; if (a === b) continue;
      const va = tris[t * 3 + e] * 3, vb = tris[t * 3 + (e + 1) % 3] * 3;
      const len = Math.hypot(verts[va] - verts[vb], verts[va + 1] - verts[vb + 1], verts[va + 2] - verts[vb + 2]);
      let v = nb[a].get(b); if (!v) { nb[a].set(b, v = [0, 0, 0]); nb[b].set(a, v); }
      v[0] += len; if (lab[t] !== lab[n]) v[1] += len;
    }
    const foldW = (a, b) => {
      const d = pN[a * 3] * pN[b * 3] + pN[a * 3 + 1] * pN[b * 3 + 1] + pN[a * 3 + 2] * pN[b * 3 + 2];
      const dx = pC[b * 3] - pC[a * 3], dy = pC[b * 3 + 1] - pC[a * 3 + 1], dz = pC[b * 3 + 2] - pC[a * 3 + 2];
      const s = (pN[a * 3] - pN[b * 3]) * dx + (pN[a * 3 + 1] - pN[b * 3 + 1]) * dy + (pN[a * 3 + 2] - pN[b * 3 + 2]) * dz;
      const bend = Math.max(0, 1 - Math.max(-1, Math.min(1, d)));
      return s > 0 ? bend : bend * 0.12;
    };
    for (let a = 0; a < nBase; a++) for (const [b, v] of nb[a]) if (a < b) v[2] = v[0] * foldW(a, b);
    for (let a = 0; a < nBase; a++) for (const [b, v] of nb[a]) if (a < b) nb[b].set(a, v.slice());
    // 7. merge: pieces of the same line region by fold strength (small ones first); across a sculpted line only at the end
    const rArea = Float64Array.from(pA);
    const tiny = 0.00003 * total;
    // one scale for both kinds of border: below 1 = merge by default
    const T = opts.T || 0.006, W = opts.W || 0.5;
    const cost = (a, b, v) => {
      const lineFrac = v[1] / Math.max(v[0], 1e-12);
      const m = Math.min(rArea[a], rArea[b]);
      if (lineFrac >= 0.5) return 0.5 + (m / Math.max(v[1], 1e-9)) / W; // thin slivers first, then small details
      return (v[2] / Math.max(v[0], 1e-12)) * Math.sqrt(m / total) / T;
    };
    const ver = new Int32Array(nBase), alive = new Uint8Array(nBase).fill(1);
    const heap = new Heap(), pairs = [];
    const pushPair = (a, b) => { const v = nb[a].get(b); pairs.push([a, b, ver[a], ver[b]]); heap.push(cost(a, b, v), pairs.length - 1); };
    for (let a = 0; a < nBase; a++) for (const b of nb[a].keys()) if (a < b) pushPair(a, b);
    const merges = [], costs = [];
    while (heap.size()) {
      const pi = heap.pop(), c = heap.topKey;
      const [a0, b0, va, vb] = pairs[pi];
      if (!alive[a0] || !alive[b0] || ver[a0] !== va || ver[b0] !== vb) continue;
      let a = a0, b = b0;
      if (nb[a].size < nb[b].size) { a = b0; b = a0; }
      merges.push(a, b); costs.push(c);
      alive[b] = 0; rArea[a] += rArea[b]; ver[a]++;
      nb[a].delete(b);
      for (const [n, v] of nb[b]) {
        if (n === a) continue;
        let x = nb[a].get(n); if (!x) nb[a].set(n, x = [0, 0, 0]);
        x[0] += v[0]; x[1] += v[1]; x[2] += v[2];
        nb[n].delete(b); nb[n].set(a, x.slice());
      }
      nb[b] = new Map();
      for (const [n, v] of nb[a]) { nb[n].set(a, v.slice()); pushPair(a, n); }
    }
    return { base, nBase, merges: Int32Array.from(merges), costs: Float32Array.from(costs), method: 'combined' };
  }
  // Suggested count: keep every sculpted-line border and every fold stronger than T.
  function suggestCombined(nBase, costs) {
    const lim = 1;
    let applied = 0;
    while (applied < costs.length && costs[applied] < lim) applied++;
    return Math.max(nBase - costs.length, nBase - applied);
  }

  // Map each base region to a part id for a given number of parts.
  function partLabels(nBase, merges, nParts) {
    const nM = merges.length / 2;
    const apply = Math.max(0, Math.min(nM, nBase - nParts));
    const par = new Int32Array(nBase); for (let i = 0; i < nBase; i++) par[i] = i;
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let i = 0; i < apply; i++) { const a = find(merges[i * 2]), b = find(merges[i * 2 + 1]); if (a !== b) par[b] = a; }
    const map = new Int32Array(nBase), lab = new Int32Array(nBase).fill(-1);
    let count = 0;
    for (let i = 0; i < nBase; i++) { const r = find(i); if (lab[r] < 0) lab[r] = count++; map[i] = lab[r]; }
    return { map, count };
  }
  // Suggested part count: stop before the first merge that is much more expensive than the ones before it.
  function suggestParts(nBase, costs) {
    const nM = costs.length, minParts = nBase - nM;
    let best = Math.min(nBase, 8), bestJump = 0;
    for (let i = Math.max(0, nM - 24); i < nM; i++) {
      const parts = nBase - i; // parts before applying merge i
      if (parts < 4 || parts > 24) continue;
      const prev = i > 0 ? costs[i - 1] : 0;
      const jump = (costs[i] + 1e-6) / (prev + 1e-3);
      if (jump > bestJump) { bestJump = jump; best = parts; }
    }
    return Math.max(minParts, Math.min(best, nBase));
  }

  // ---------- region editing: grow / shrink by distance along the surface ----------
  function growSel(adj, cent, selList, mask, step, wall) {
    const dist = new Map(), heap = new Heap(), out = [];
    const dd = (a, b) => Math.hypot(cent[a * 3] - cent[b * 3], cent[a * 3 + 1] - cent[b * 3 + 1], cent[a * 3 + 2] - cent[b * 3 + 2]);
    for (const t of selList) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e];
      if (n < 0 || mask[n] || (wall && wall[n] >= 0) || dist.has(n)) continue;
      dist.set(n, 0); heap.push(0, n);
    }
    while (heap.size()) {
      const t = heap.pop(), d = heap.topKey;
      if (d > dist.get(t)) continue;
      out.push(t);
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || mask[n] || (wall && wall[n] >= 0)) continue;
        const nd = d + dd(t, n);
        if (nd > step) continue;
        const od = dist.get(n);
        if (od === undefined || nd < od) { dist.set(n, nd); heap.push(nd, n); }
      }
    }
    return out;
  }
  // Inner band of the selection, each with the colour of the outside triangle nearest to it.
  function shrinkSel(adj, cent, selList, mask, paint, step) {
    const dist = new Map(), col = new Map(), heap = new Heap(), out = [];
    const dd = (a, b) => Math.hypot(cent[a * 3] - cent[b * 3], cent[a * 3 + 1] - cent[b * 3 + 1], cent[a * 3 + 2] - cent[b * 3 + 2]);
    for (const t of selList) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e];
      if (n < 0 || mask[n]) continue;
      if (!dist.has(t)) { dist.set(t, 0); col.set(t, paint[n]); heap.push(0, t); }
    }
    while (heap.size()) {
      const t = heap.pop(), d = heap.topKey;
      if (d > dist.get(t)) continue;
      out.push([t, col.get(t)]);
      for (let e = 0; e < 3; e++) {
        const n = adj[t * 3 + e];
        if (n < 0 || !mask[n]) continue;
        const nd = d + dd(t, n);
        if (nd > step) continue;
        const od = dist.get(n);
        if (od === undefined || nd < od) { dist.set(n, nd); col.set(n, col.get(t)); heap.push(nd, n); }
      }
    }
    return out;
  }

  // ---------- boundary cleanup ----------
  function segDist2(px, py, pz, ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz;
    let u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = ax + u * dx - px, qy = ay + u * dy - py, qz = az + u * dz - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  // Colour boundaries as chains of mesh vertices. Each directed edge has colour A (the lower slot) on its left.
  function boundaryChains(verts, tris, adj, normals, paint, mask, creaseDeg) {
    const nT = tris.length / 3, cosC = Math.cos((creaseDeg || 35) * Math.PI / 180);
    const out = new Map(); // start vertex -> list of edge records
    const edges = [];
    for (let t = 0; t < nT; t++) for (let e = 0; e < 3; e++) {
      const n = adj[t * 3 + e];
      if (n < 0 || paint[n] === paint[t]) continue;
      if (paint[t] > paint[n]) continue; // keep the record from the lower-colour side: directed as in t's winding
      if (mask && !mask[t] && !mask[n]) continue;
      const a = tris[t * 3 + e], b = tris[t * 3 + (e + 1) % 3];
      const d = normals[t * 3] * normals[n * 3] + normals[t * 3 + 1] * normals[n * 3 + 1] + normals[t * 3 + 2] * normals[n * 3 + 2];
      const rec = { a, b, tA: t, tB: n, A: paint[t], B: paint[n], crease: d < cosC, used: false };
      edges.push(rec);
      if (!out.has(a)) out.set(a, []);
      out.get(a).push(rec);
    }
    const inDeg = new Map();
    for (const r of edges) inDeg.set(r.b, (inDeg.get(r.b) || 0) + 1);
    const chains = [];
    const walk = start => {
      const list = [start]; start.used = true;
      let cur = start;
      for (;;) {
        const nx = out.get(cur.b);
        if (!nx || nx.length !== 1 || (inDeg.get(cur.b) || 0) !== 1) break;
        const r = nx[0];
        if (r.used || r.A !== start.A || r.B !== start.B) break;
        r.used = true; list.push(r); cur = r;
      }
      return list;
    };
    // open chains start at vertices that are not simple pass-throughs
    for (const r of edges) {
      if (r.used) continue;
      const deg = inDeg.get(r.a) || 0, ob = out.get(r.a).length;
      if (deg === 1 && ob === 1) continue;
      chains.push(walk(r));
    }
    for (const r of edges) if (!r.used) chains.push(walk(r)); // closed loops (and leftovers)
    return chains.map(list => {
      const closed = list.length > 2 && list[list.length - 1].b === list[0].a;
      const vs = list.map(r => r.a); if (!closed) vs.push(list[list.length - 1].b);
      return { edges: list, verts: vs, closed, A: list[0].A, B: list[0].B };
    });
  }

  /**
   * Smooth jagged colour edges ("Smooth edges"): smooth each colour boundary chain (keeping sharp
   * creases and real corners), refine the mesh along the smoothed line, then repaint the triangles
   * near it by which side of the line they fall on.
   *
   * @param {Float32Array} verts
   * @param {Uint32Array} tris
   * @param {Uint8Array} paint
   * @param {TypedArray[]} [extra] Other per-triangle arrays to carry through refinement.
   * @param {{smoothLen?: number, detail?: number, mask?: Uint8Array, creaseDeg?: number}} [opts]
   *   smoothLen: smoothing length (mm, default 1.5); detail: target triangle size (mm, default 0.5);
   *   mask: limit to a selection; creaseDeg: angle above which an edge counts as a crease.
   * @returns {?{verts, tris, paint, carry, changed: number, chains: number, limited: boolean}}
   *   null when nothing changed.
   */
  function cleanEdges(verts, tris, paint, extra, opts) {
    opts = opts || {};
    const smoothLen = opts.smoothLen || 1.5, target = opts.detail || 0.5;
    const nV = verts.length / 3;
    const adj = adjacency(tris, nV), fd = faceData(verts, tris);
    const chains = boundaryChains(verts, tris, adj, fd.normals, paint, opts.mask, opts.creaseDeg);
    const segs = []; // [ax,ay,az,bx,by,bz, r, nx,ny,nz, A, B, sign]
    const samples = [];
    let moved = 0;
    for (const ch of chains) {
      const n = ch.verts.length;
      if (n < 3) continue;
      const P = new Float64Array(n * 3);
      ch.verts.forEach((v, i) => { P[i * 3] = verts[v * 3]; P[i * 3 + 1] = verts[v * 3 + 1]; P[i * 3 + 2] = verts[v * 3 + 2]; });
      const pin = new Uint8Array(n);
      if (!ch.closed) { pin[0] = 1; pin[n - 1] = 1; }
      // keep real corners: big turn measured a few points away (jaggies average out)
      // smoothing reach in mm, whatever the mesh density
      let spacing = 0;
      for (let i = 0; i + 1 < n; i++) spacing += Math.hypot(P[i * 3 + 3] - P[i * 3], P[i * 3 + 4] - P[i * 3 + 1], P[i * 3 + 5] - P[i * 3 + 2]);
      spacing = spacing / Math.max(1, n - 1) || 1;
      const iters = 0;
      const K = Math.max(3, Math.min(60, Math.round(smoothLen / spacing))), idx = i => ch.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));
      // keep sharp creases, but only real ones: a long run of sharp edges, not the odd sharp edge in a textured sculpt
      {
        const ne = ch.edges.length, minRun = Math.max(2, Math.round(K / 2));
        let i = 0;
        while (i < ne) {
          if (!ch.edges[i].crease) { i++; continue; }
          let j = i; while (j < ne && ch.edges[j].crease) j++;
          const wrap = ch.closed && i === 0 && j === ne; // whole loop is a crease
          if (j - i >= minRun || wrap || (ch.closed && j === ne && ch.edges[0].crease)) for (let k = i; k <= j && k <= ne; k++) pin[k % n] = 1;
          i = j;
        }
      }
      const turn = new Float64Array(n), KC = Math.min(Math.floor((n - 1) / 2), 2 * K);
      for (let i = 0; i < n; i++) {
        const p = idx(i - KC), q = idx(i + KC);
        const ux = P[i * 3] - P[p * 3], uy = P[i * 3 + 1] - P[p * 3 + 1], uz = P[i * 3 + 2] - P[p * 3 + 2];
        const vx = P[q * 3] - P[i * 3], vy = P[q * 3 + 1] - P[i * 3 + 1], vz = P[q * 3 + 2] - P[i * 3 + 2];
        const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
        turn[i] = lu && lv ? (ux * vx + uy * vy + uz * vz) / (lu * lv) : 1;
      }
      for (let i = 0; i < n; i++) {
        if (turn[i] > 0.26) continue; // < ~75 degrees turn
        let isMin = true;
        for (let j = -KC; j <= KC && isMin; j++) if (j && turn[idx(i + j)] < turn[i]) isMin = false;
        if (isMin) pin[i] = 1;
      }
      // Gaussian smoothing along the edge (sigma = half the smoothing distance), faded out near pinned points
      const arc = new Float64Array(n + 1);
      for (let i = 1; i <= n; i++) {
        const p = (i - 1) * 3, q = (i % n) * 3;
        arc[i] = arc[i - 1] + (i < n || ch.closed ? Math.hypot(P[q] - P[p], P[q + 1] - P[p + 1], P[q + 2] - P[p + 2]) : 0);
      }
      const totalLen = ch.closed ? arc[n] : arc[n - 1];
      const sigma = Math.max(smoothLen / 2, spacing), reach = 3 * sigma;
      const gap = (i, j) => { let d = Math.abs(arc[j] - arc[i]); if (ch.closed) d = Math.min(d, totalLen - d); return d; };
      // distance along the edge to the nearest pinned point
      const pinD = new Float64Array(n).fill(Infinity);
      const pins = []; for (let i = 0; i < n; i++) if (pin[i]) pins.push(i);
      if (pins.length) for (let i = 0; i < n; i++) {
        let best = Infinity;
        for (const p of pins) { const d = gap(i, p); if (d < best) best = d; }
        pinD[i] = best;
      }
      const Q = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        let sx = 0, sy = 0, sz = 0, sw = 0;
        for (const dir of [-1, 1]) {
          for (let k = dir === -1 ? 0 : 1; ; k++) {
            const jj = i + dir * k;
            if (!ch.closed && (jj < 0 || jj >= n)) break;
            if (k >= n) break;
            const j = ((jj % n) + n) % n;
            const d = gap(i, j);
            if (d > reach) break;
            const wgt = Math.exp(-d * d / (2 * sigma * sigma));
            sx += P[j * 3] * wgt; sy += P[j * 3 + 1] * wgt; sz += P[j * 3 + 2] * wgt; sw += wgt;
          }
        }
        const f = pin[i] ? 0 : Math.min(1, pinD[i] / (2 * sigma)) ** 2;
        Q[i * 3] = P[i * 3] + f * (sx / sw - P[i * 3]);
        Q[i * 3 + 1] = P[i * 3 + 1] + f * (sy / sw - P[i * 3 + 1]);
        Q[i * 3 + 2] = P[i * 3 + 2] + f * (sz / sw - P[i * 3 + 2]);
      }
      let disp = 0;
      if (opts.debug) { let pc = 0; for (let i = 0; i < n; i++) pc += pin[i]; opts.debug.push({ n, pinned: pc, iters, K, spacing: +spacing.toFixed(3), closed: ch.closed }); }
      for (let i = 0; i < n; i++) disp = Math.max(disp, Math.hypot(Q[i * 3] - P[i * 3], Q[i * 3 + 1] - P[i * 3 + 1], Q[i * 3 + 2] - P[i * 3 + 2]));
      if (disp < 1e-6) continue;
      moved++;
      // which side is A? check against the original (unsmoothed) chain with the original triangles
      let agree = 0, tot = 0;
      ch.edges.forEach((r, i) => {
        const j = i + 1 < n ? i + 1 : 0, t = r.tA;
        const dx = P[j * 3] - P[i * 3], dy = P[j * 3 + 1] - P[i * 3 + 1], dz = P[j * 3 + 2] - P[i * 3 + 2];
        const nx = fd.normals[t * 3], ny = fd.normals[t * 3 + 1], nz = fd.normals[t * 3 + 2];
        const lx = ny * dz - nz * dy, ly = nz * dx - nx * dz, lz = nx * dy - ny * dx;
        const s = lx * (fd.cent[t * 3] - P[i * 3]) + ly * (fd.cent[t * 3 + 1] - P[i * 3 + 1]) + lz * (fd.cent[t * 3 + 2] - P[i * 3 + 2]);
        tot++; if (s > 0) agree++;
      });
      const sign = agree * 2 >= tot ? 1 : -1;
      const nSeg = ch.closed ? n : n - 1, base0 = segs.length;
      for (let i = 0; i < nSeg; i++) {
        const j = (i + 1) % n, r = ch.edges[i];
        const el = Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 1] - P[i * 3 + 1], P[j * 3 + 2] - P[i * 3 + 2]);
        const di = Math.max(Math.hypot(Q[i * 3] - P[i * 3], Q[i * 3 + 1] - P[i * 3 + 1], Q[i * 3 + 2] - P[i * 3 + 2]),
          Math.hypot(Q[j * 3] - P[j * 3], Q[j * 3 + 1] - P[j * 3 + 1], Q[j * 3 + 2] - P[j * 3 + 2]));
        let nx = fd.normals[r.tA * 3] + fd.normals[r.tB * 3], ny = fd.normals[r.tA * 3 + 1] + fd.normals[r.tB * 3 + 1], nz = fd.normals[r.tA * 3 + 2] + fd.normals[r.tB * 3 + 2];
        const ln = Math.hypot(nx, ny, nz) || 1;
        segs.push([Q[i * 3], Q[i * 3 + 1], Q[i * 3 + 2], Q[j * 3], Q[j * 3 + 1], Q[j * 3 + 2], di + el + target, nx / ln, ny / ln, nz / ln, ch.A, ch.B, sign,
          i > 0 ? base0 + i - 1 : (ch.closed ? base0 + nSeg - 1 : -1), i < nSeg - 1 ? base0 + i + 1 : (ch.closed ? base0 : -1)]);
        const m = Math.max(1, Math.ceil(Math.hypot(Q[j * 3] - Q[i * 3], Q[j * 3 + 1] - Q[i * 3 + 1], Q[j * 3 + 2] - Q[i * 3 + 2]) / (target * 0.5)));
        for (let k = 0; k < m; k++) samples.push(Q[i * 3] + (Q[j * 3] - Q[i * 3]) * k / m, Q[i * 3 + 1] + (Q[j * 3 + 1] - Q[i * 3 + 1]) * k / m, Q[i * 3 + 2] + (Q[j * 3 + 2] - Q[i * 3 + 2]) * k / m);
      }
    }
    if (!segs.length) return null;
    // refine along the new lines
    const res = refineNear(verts, tris, [paint].concat(extra || []), samples, target, opts.maxTris);
    const V = res.verts, T = res.tris, np = res.carry[0].slice();
    const fd2 = faceData(V, T);
    // spatial grid of segments
    let h = 0; for (const s of segs) h += s[6]; h = Math.max(1e-3, 2 * h / segs.length);
    const grid = new Map(), key = (x, y, z) => x * 73856093 ^ y * 19349663 ^ z * 83492791;
    segs.forEach((s, si) => {
      const r = s[6];
      const x0 = Math.floor((Math.min(s[0], s[3]) - r) / h), x1 = Math.floor((Math.max(s[0], s[3]) + r) / h);
      const y0 = Math.floor((Math.min(s[1], s[4]) - r) / h), y1 = Math.floor((Math.max(s[1], s[4]) + r) / h);
      const z0 = Math.floor((Math.min(s[2], s[5]) - r) / h), z1 = Math.floor((Math.max(s[2], s[5]) + r) / h);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const k = key(x, y, z); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(si);
      }
    });
    const nT2 = T.length / 3;
    let changed = 0;
    for (let t = 0; t < nT2; t++) {
      const cx = fd2.cent[t * 3], cy = fd2.cent[t * 3 + 1], cz = fd2.cent[t * 3 + 2];
      const l = grid.get(key(Math.floor(cx / h), Math.floor(cy / h), Math.floor(cz / h)));
      if (!l) continue;
      let best = -1, bd = Infinity;
      for (const si of l) {
        const s = segs[si];
        const d2 = segDist2(cx, cy, cz, s[0], s[1], s[2], s[3], s[4], s[5]);
        if (d2 < bd && d2 <= s[6] * s[6]) { bd = d2; best = si; }
      }
      if (best < 0) continue;
      const s = segs[best], c = np[t];
      if (c !== s[10] && c !== s[11]) continue;
      const nx = fd2.normals[t * 3], ny = fd2.normals[t * 3 + 1], nz = fd2.normals[t * 3 + 2];
      if (nx * s[7] + ny * s[8] + nz * s[9] < 0.2) continue;
      // left of the segment (A side); past a segment's end, use the bisector with the next/previous segment
      const leftOf = q => {
        const dx = q[3] - q[0], dy = q[4] - q[1], dz = q[5] - q[2], l = Math.hypot(dx, dy, dz) || 1;
        return [(ny * dz - nz * dy) / l, (nz * dx - nx * dz) / l, (nx * dy - ny * dx) / l];
      };
      const dx = s[3] - s[0], dy = s[4] - s[1], dz = s[5] - s[2], l2 = dx * dx + dy * dy + dz * dz || 1;
      const u = ((cx - s[0]) * dx + (cy - s[1]) * dy + (cz - s[2]) * dz) / l2;
      let L = leftOf(s), ox = s[0], oy = s[1], oz = s[2];
      if (u < 0 && s[13] >= 0) { const o = leftOf(segs[s[13]]); L = [L[0] + o[0], L[1] + o[1], L[2] + o[2]]; }
      else if (u > 1 && s[14] >= 0) { const o = leftOf(segs[s[14]]); L = [L[0] + o[0], L[1] + o[1], L[2] + o[2]]; ox = s[3]; oy = s[4]; oz = s[5]; }
      else if (u > 1) { ox = s[3]; oy = s[4]; oz = s[5]; }
      const side = (L[0] * (cx - ox) + L[1] * (cy - oy) + L[2] * (cz - oz)) * s[12];
      const want = side > 0 ? s[10] : s[11];
      if (want !== c) { np[t] = want; changed++; }
    }
    return { verts: V, tris: T, paint: np, carry: res.carry.slice(1), changed, chains: moved, limited: res.limited };
  }

  // ---------- export ----------
  function fmt(x) {
    const s = (+x).toFixed(6);
    return s.replace(/\.?0+$/, '') || '0';
  }
  function bedCenter(settings) {
    const pa = settings && settings.printable_area;
    if (pa && pa.length) {
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (const p of pa) {
        const [x, y] = String(p).split('x').map(Number);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      if (isFinite(minX)) return [(minX + maxX) / 2, (minY + maxY) / 2];
    }
    return [128, 128];
  }
  function uuid(prefix) {
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return prefix + '-' + h() + '-' + h() + '-' + h() + '-' + h() + h() + h();
  }
  function appFromTemplate(t) {
    const m = /name="Application">([^<]+)</.exec(t['3D/3dmodel.model'] || '');
    return m ? m[1] : 'BambuStudio-02.09.01.70';
  }
  function xmlEsc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  /**
   * Build every file of a slicer project 3MF from a template project and a painted mesh.
   *
   * Settings, thumbnails and plate data come from the template (a project saved by the slicer); its
   * objects and slice results are replaced. The model is centred on the bed from the template's
   * `printable_area`. Bambu Studio only treats a 3MF as one of its own projects, and so only loads the
   * mixed filaments, when the Application metadata starts with "BambuStudio-": any other appVersion
   * falls back to the template's value. buildSnorca() in app.js reuses this for Snapmaker Orca and
   * rewrites the Bambu-specific tags afterwards.
   *
   * @param {Object<string, string|Uint8Array>} template Files of the template project.
   * @param {{verts: Float32Array, tris: Uint32Array, paint: Uint8Array}} mesh Paint = 1-based slots.
   * @param {string} name Object and project title.
   * @param {string} [appVersion] Application tag; used only if it starts with "BambuStudio-".
   * @returns {Object<string, string|Uint8Array>} Path → contents, ready to zip.
   */
  function build3MF(template, mesh, name, appVersion) {
    const settings = JSON.parse(template['Metadata/project_settings.config']);
    const { verts, tris, paint } = mesh;
    const nV = verts.length / 3, nT = tris.length / 3;
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    for (let i = 0; i < nV; i++) {
      const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2, hz = (maxZ - minZ) / 2;
    const [bx, by] = bedCenter(settings);
    const nFil = (settings.filament_colour || []).length || 1;

    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n  <object id="1" p:UUID="' + uuid('00010000') + '" type="model">\n   <mesh>\n    <vertices>\n');
    const chunk = [];
    for (let i = 0; i < nV; i++) {
      chunk.push('     <vertex x="' + fmt(verts[i * 3] - cx) + '" y="' + fmt(verts[i * 3 + 1] - cy) + '" z="' + fmt(verts[i * 3 + 2] - cz) + '"/>\n');
      if (chunk.length > 20000) { parts.push(chunk.join('')); chunk.length = 0; }
    }
    parts.push(chunk.join('')); chunk.length = 0;
    parts.push('    </vertices>\n    <triangles>\n');
    const codes = {};
    for (let t = 0; t < nT; t++) {
      const s = paint[t];
      let pc = codes[s];
      if (pc === undefined) pc = codes[s] = (s ? ' paint_color="' + encodePaint(s) + '"' : '');
      chunk.push('     <triangle v1="' + tris[t * 3] + '" v2="' + tris[t * 3 + 1] + '" v3="' + tris[t * 3 + 2] + '"' + pc + '/>\n');
      if (chunk.length > 20000) { parts.push(chunk.join('')); chunk.length = 0; }
    }
    parts.push(chunk.join(''));
    parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build/>\n</model>\n');
    const objectModel = parts.join('');

    const today = new Date().toISOString().slice(0, 10);
    const rootModel = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n' +
      ' <metadata name="Application">' + xmlEsc(/^BambuStudio-/.test(appVersion || '') ? appVersion : appFromTemplate(template)) + '</metadata>\n' +
      ' <metadata name="BambuStudio:3mfVersion">1</metadata>\n' +
      ' <metadata name="CreationDate">' + today + '</metadata>\n' +
      ' <metadata name="ModificationDate">' + today + '</metadata>\n' +
      ' <metadata name="Title">' + xmlEsc(name) + '</metadata>\n' +
      ' <resources>\n  <object id="2" p:UUID="' + uuid('00000001') + '" type="model">\n   <components>\n' +
      '    <component p:path="/3D/Objects/object_1.model" objectid="1" p:UUID="' + uuid('00010000') + '" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n' +
      '   </components>\n  </object>\n </resources>\n' +
      ' <build p:UUID="' + uuid('2c7c17d8') + '">\n  <item objectid="2" p:UUID="' + uuid('00000002') + '" transform="1 0 0 0 1 0 0 0 1 ' + fmt(bx) + ' ' + fmt(by) + ' ' + fmt(hz) + '" printable="1"/>\n </build>\n</model>\n';

    const rootRels = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/Objects/object_1.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n';

    // model_settings: keep the template's plate block (filament maps etc.), replace object/instance/assemble.
    let plate = '';
    const ms = template['Metadata/model_settings.config'];
    if (typeof ms === 'string') {
      const pm = /<plate>([\s\S]*?)<\/plate>/.exec(ms);
      if (pm) plate = pm[1].replace(/\s*<model_instance>[\s\S]*?<\/model_instance>/g, '');
    }
    if (!plate) {
      plate = '\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n    <metadata key="filament_maps" value="' + new Array(nFil).fill('1').join(' ') + '"/>';
    }
    plate = plate.replace(/\s+$/, '');
    plate = plate.replace(/(key="filament_maps" value=")([^"]*)"/, (m, p, v) => {
      const a = v.trim() ? v.trim().split(/\s+/) : [];
      while (a.length < nFil) a.push('1');
      return p + a.slice(0, nFil).join(' ') + '"';
    }).replace(/(key="filament_volume_maps" value=")([^"]*)"/, (m, p, v) => {
      const a = v.trim() ? v.trim().split(/\s+/) : [];
      while (a.length < nFil) a.push(a.length ? a[a.length - 1] : '0');
      return p + a.slice(0, nFil).join(' ') + '"';
    });
    const nameEsc = xmlEsc(name);
    const modelSettings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="2">\n    <metadata key="name" value="' + nameEsc + '"/>\n    <metadata key="extruder" value="1"/>\n    <metadata face_count="' + nT + '"/>\n' +
      '    <part id="1" subtype="normal_part">\n      <metadata key="name" value="' + nameEsc + '"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n      <mesh_stat face_count="' + nT + '" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n    </part>\n  </object>\n' +
      '  <plate>' + plate + '\n    <model_instance>\n      <metadata key="object_id" value="2"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="62"/>\n    </model_instance>\n  </plate>\n' +
      '  <assemble>\n   <assemble_item object_id="2" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 ' + fmt(hz) + '" offset="0 0 0" />\n  </assemble>\n</config>\n';

    const out = {};
    // carry over the template's settings and thumbnails; drop its objects and slice results
    for (const p in template) {
      if (/^3D\//.test(p)) continue;
      if (/^Metadata\/(plate_\d+\.json|.*\.gcode.*|cut_information\.xml|model_settings\.config)$/i.test(p)) continue;
      out[p] = template[p];
    }
    out['3D/3dmodel.model'] = rootModel;
    out['3D/_rels/3dmodel.model.rels'] = rootRels;
    out['3D/Objects/object_1.model'] = objectModel;
    out['Metadata/model_settings.config'] = modelSettings;
    out['Metadata/cut_information.xml'] = '<?xml version="1.0" encoding="utf-8"?>\n<objects>\n <object id="1">\n  <cut_id id="0" check_sum="1" connectors_cnt="0"/>\n </object>\n</objects>\n';
    if (!out['[Content_Types].xml']) out['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n';
    if (!out['_rels/.rels']) out['_rels/.rels'] = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n';
    return out;
  }

  const api = { encodePaint, decodePaint, parseSTL, parse3MF, parsePalette, colorName, hexToRgb, weld, adjacency, faceData,
    smartFill, sameColorFill, nearestNonWall, segSide, lineSide, absorbWalls, lassoRegion, cavityShade, creaseEdges, linkPath, brushSelect, findIslands, refineMarked, subdivide, refineNear, pointTriDist2, build3MF,
    hexToLab, nearestSlot, segmentParts, segmentLines, suggestLineParts, segmentCombined, suggestCombined, partLabels, suggestParts, growSel, shrinkSel, boundaryChains, cleanEdges, addMix, editMix, deleteSlot, mixKey, addPhysical, permuteFilaments, physicalCount, capsInfo, insideCaps, refineAlongCaps, ditherValue, shadeThreshold, FILAMENT_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LabCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
