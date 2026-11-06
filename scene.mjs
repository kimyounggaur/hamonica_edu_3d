import { faceOpacity } from './domain.mjs';

const PI = Math.PI;
const TAU = PI * 2;

export const PRESETS = Object.freeze({
  front: Object.freeze([0, 0, -1]),
  back: Object.freeze([0, 0, 1]),
  left: Object.freeze([-1, 0, 0]),
  right: Object.freeze([1, 0, 0]),
});

export const CAMERA_UP = Object.freeze([0, 1, 0]);
const INITIAL_YAW = 1.08;
const INITIAL_PITCH = 0.26;
const FOV = 0.59;
const CAMERA_TARGET = [0, 1.02, 0.13];
const PRESET_DURATION = 220;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const add = (a, b) => a.map((n, i) => n + b[i]);
const sub = (a, b) => a.map((n, i) => n - b[i]);
const scale = (v, factor) => v.map(n => n * factor);
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const cross = ([a, b, c], [x, y, z]) => [b * z - c * y, c * x - a * z, a * y - b * x];
const unit = v => scale(v, 1 / (Math.hypot(...v) || 1));

export function cameraDirection(yaw, pitch) {
  const h = Math.cos(pitch);
  return [h * Math.sin(yaw), Math.sin(pitch), h * Math.cos(yaw)];
}

export function calculateView(direction, aspect, width = 6.35) {
  const target = [...CAMERA_TARGET];
  const up = [...CAMERA_UP];
  const verticalHalfSpan = 2.40;
  const horizontalHalfSpan = width / 2 + 0.83;
  const span = Math.max(verticalHalfSpan, horizontalHalfSpan / Math.max(0.2, aspect));
  const distance = span / Math.tan(FOV / 2) + 1.28;
  return { target, up, distance, fov: FOV, eye: add(target, scale(unit(direction), distance)) };
}

function cameraMatrices({ eye, target, up, fov }, aspect) {
  const z = unit(sub(eye, target));
  const x = unit(cross(up, z));
  const y = cross(z, x);
  const view = [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
  const f = 1 / Math.tan(fov / 2);
  const near = 0.1;
  const far = 100;
  const projection = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
  return { view, projection };
}

const hex = value => [16, 8, 0].map(shift => ((value >> shift) & 255) / 255);
const material = (color, metal = 0) => ({ color: hex(color), metal });
const styles = {
  head: material(0x8ca9c3, 0.18),
  ear: material(0x91a9c1, 0.09),
  detail: material(0x4b6480),
  eye: material(0x40536b),
  skinEdge: material(0xa4bbd0, 0.12),
  lipUpper: material(0xb94f46, 0.15),
  lipLower: material(0xd66352, 0.18),
  lipLine: material(0xff977c, 0.12),
  lipLineInner: material(0xffc2a9, 0.13),
  dark: material(0x132033, 0.18),
  well: material(0x27394e, 0.21),
  steel: material(0x9eb4cc, 0.76),
  bright: material(0xccdfeb, 0.8),
  brushed: material(0x6c879e, 0.59),
  gold: material(0xab8d5e, 0.54),
  copper: material(0xb87f4e, 0.55),
  gasket: material(0x39465a, 0.22),
};

function triangle(mesh, a, b, c, normals) {
  const normal = normals ? null : unit(cross(sub(b, a), sub(c, a)));
  for (const [i, point] of [a, b, c].entries()) {
    mesh.push(...point, ...(normals ? normals[i] : normal));
  }
}

function quad(mesh, a, b, c, d, normals) {
  triangle(mesh, a, b, c, normals && [normals[0], normals[1], normals[2]]);
  triangle(mesh, a, c, d, normals && [normals[0], normals[2], normals[3]]);
}

function grid(mesh, cols, rows, point, normal) {
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const corners = [[col, row], [col + 1, row], [col + 1, row + 1], [col, row + 1]];
      const points = corners.map(([x, y]) => point(x / cols, y / rows));
      const normals = normal && corners.map(([x, y]) => normal(x / cols, y / rows));
      quad(mesh, ...points, normals);
    }
  }
}

function roundBox(mesh, center, size, radius) {
  const half = scale(size, 0.5);
  const r = Math.min(radius, ...half);
  const panels = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];

  // Include the straight-to-rounded breakpoints on each edge.
  for (const [face, axisU, axisV] of panels) {
    const stops = axis => {
      const edge = r / (2 * Math.abs(dot(half, axis)));
      return [...new Set([0, 0.33 * edge, 0.66 * edge, edge, 1 - edge, 1 - 0.66 * edge,
        1 - 0.33 * edge, 1])];
    };
    const stepsU = stops(axisU);
    const stepsV = stops(axisV);
    const patch = (u, v) => {
      const corner = add(face, add(scale(axisU, 2 * u - 1), scale(axisV, 2 * v - 1)));
      const p = corner.map((n, i) => n * half[i]);
      const core = p.map((n, i) => clamp(n, -half[i] + r, half[i] - r));
      const normal = unit(sub(p, core));
      return { position: add(center, add(core, scale(normal, r))), normal };
    };
    const patches = stepsV.map(v => stepsU.map(u => patch(u, v)));
    for (let v = 0; v < stepsV.length - 1; v++) {
      for (let u = 0; u < stepsU.length - 1; u++) {
        const p = [patches[v][u], patches[v][u + 1], patches[v + 1][u + 1], patches[v + 1][u]];
        quad(mesh, ...p.map(point => point.position), p.map(point => point.normal));
      }
    }
  }
}

function ellipsoid(mesh, center, radius, yaw = 0) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const rotate = ([x, y, z]) => [x * c + z * s, y, -x * s + z * c];
  const angles = (u, v) => {
    const long = u * TAU;
    const lat = (v - 0.5) * PI;
    return [Math.cos(lat) * Math.sin(long), Math.sin(lat), Math.cos(lat) * Math.cos(long)];
  };
  grid(mesh, 30, 20,
    (u, v) => add(center, rotate(angles(u, v).map((n, i) => n * radius[i]))),
    (u, v) => unit(rotate(angles(u, v).map((n, i) => n / radius[i]))));
}

function surfaceWithNormals(mesh, cols, rows, point) {
  const normal = (u, v) => {
    const step = 0.0002;
    const a = sub(point(u + step, v), point(u - step, v));
    const b = sub(point(u, Math.min(0.99999, v + step)), point(u, Math.max(0.00001, v - step)));
    return unit(cross(a, b));
  };
  grid(mesh, cols, rows, (u, v) => point(u, clamp(v, 0.00001, 0.99999)),
    (u, v) => normal(u, clamp(v, 0.00002, 0.99998)));
}

function tube(mesh, sample, thickness, segments = 36, sides = 8) {
  function point(u, v) {
    const t = v * TAU;
    const p = sample(u);
    const tangent = unit(sub(sample(u + 0.0005), sample(u - 0.0005)));
    const normal = unit(cross(tangent, [0, 0, 1]));
    const binormal = unit(cross(normal, tangent));
    const radial = add(scale(normal, Math.cos(t)), scale(binormal, Math.sin(t)));
    return { p: add(p, scale(radial, thickness)), n: radial };
  }
  grid(mesh, segments, sides, (u, v) => point(u, v).p, (u, v) => point(u, v).n);
}

const HEAD_CENTER_Y = 1.14;
const HEAD_RADIUS_Y = 1.99;
const gaussian = (x, y, cx, cy, sx, sy) => Math.exp(-(((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2));
const jawWidth = y => 1.41 * (1 - 0.24 * gaussian(0, y, 0, -0.51, 1, 0.69) +
  0.07 * gaussian(0, y, 0, 0.93, 1, 0.54));

function faceDepth(x, y, base, frontWeight) {
  const nose = 0.51 * gaussian(x, y, 0, 0.84, 0.27, 0.33) + 0.22 * gaussian(x, y, 0, 1.17, 0.22, 0.60);
  const cheeks = 0.13 * gaussian(Math.abs(x), y, 0.77, 0.72, 0.41, 0.44);
  const eyes = 0.12 * gaussian(Math.abs(x), y, 0.54, 1.46, 0.39, 0.20);
  const mouth = 0.42 * gaussian(x, y, 0, 0.04, 0.64, 0.56) -
    0.20 * gaussian(x, y, 0, 0.06, 0.43, 0.16);
  const chin = 0.64 * gaussian(x, y, 0, -0.59, 0.63, 0.37);
  const z = base - (nose + cheeks - eyes + mouth + chin) * frontWeight;
  const clearance = 0.105 + 0.09 * clamp(Math.abs(x) / 0.56, 0, 1);
  const noseBlend = clamp((y - 0.54) / 0.23, 0, 1);
  return z + Math.max(0, clearance - z) * (1 - noseBlend);
}

function faceZ(x, y) {
  const vertical = 1 - ((y - HEAD_CENTER_Y) / HEAD_RADIUS_Y) ** 2;
  const projected = vertical - (x / jawWidth(y)) ** 2;
  const c = Math.sqrt(Math.max(0.001, projected));
  return faceDepth(x, y, 1.45 - 1.18 * c, c ** 2 / Math.max(0.001, vertical));
}

function details() {
  const head = [];
  const ears = [];
  const detail = [];
  const eyes = [];
  const rims = [];

  function face(u, v) {
    const yaw = u * TAU;
    const lat = (v - 0.5) * PI;
    const c = Math.cos(lat);
    const y = HEAD_CENTER_Y + HEAD_RADIUS_Y * Math.sin(lat);
    const x = jawWidth(y) * c * Math.sin(yaw);
    const z = 1.45 + 1.18 * c * Math.cos(yaw);
    return [x, y, faceDepth(x, y, z, Math.max(0, -Math.cos(yaw)) ** 2)];
  }
  surfaceWithNormals(head, 78, 72, face);

  for (const side of [-1, 1]) {
    ellipsoid(ears, [1.33 * side, 0.95, 1.52], [0.27, 0.42, 0.19], side * 0.38);
    const earArc = u => {
      const angle = (0.09 + 0.84 * u) * TAU;
      return [side * (1.43 + 0.085 * Math.sin(angle)), 0.96 + 0.24 * Math.cos(angle), 1.347];
    };
    tube(rims, earArc, 0.017, 24);

    const eye = u => {
      const x = side * (0.26 + u * 0.59);
      const y = 1.42 + 0.075 * Math.sin(PI * u) + 0.042 * u;
      return [x, y, faceZ(x, y) - 0.023];
    };
    tube(eyes, eye, 0.020, 26);

    const brow = u => {
      const x = side * (0.28 + u * 0.59);
      const y = 1.69 + 0.11 * Math.sin(PI * u) + 0.015 * u;
      return [x, y, faceZ(x, y) - 0.021];
    };
    tube(detail, brow, 0.028, 26);

    const noseEdge = u => {
      const x = side * (0.11 + 0.19 * u);
      const y = 0.75 + 0.07 * Math.sin(u * PI * 0.75);
      return [x, y, faceZ(x, y) - 0.016];
    };
    tube(detail, noseEdge, 0.017, 22);
  }

  return [[head, styles.head], [ears, styles.ear], [detail, styles.detail, 0.8],
    [eyes, styles.eye, 0.83], [rims, styles.skinEdge, 0.85]];
}

function lipMeshes(height) {
  const upper = [];
  const lower = [];
  const outline = [];
  const innerOutline = [];
  const innerH = height * 0.24;
  const upperH = height * 0.73;
  const lowerH = Math.min(height * 0.62, 0.55);
  const outerW = 0.57;
  const innerW = 0.32;

  function profile(u, outer) {
    const t = u * TAU;
    const h = Math.sin(t);
    const x = Math.cos(t) * (outer ? outerW : innerW);
    const cupid = h > 0 ? 0.84 + 0.22 * Math.sin(PI * Math.abs(x) / outerW) : 1.06;
    const y = h * cupid * (outer ? (h > 0 ? upperH : lowerH) : innerH);
    const z = outer ? faceZ(x, y) - 0.020 : 0.025 + 0.022 * (x / innerW) ** 2;
    return [x, y, z];
  }

  function patch(u, v) {
    const a = profile(u, false);
    const b = profile(u, true);
    const p = a.map((n, i) => n * (1 - v) + b[i] * v);
    p[2] -= 0.085 * Math.sin(PI * v);
    return p;
  }
  surfaceWithNormals(upper, 38, 10, (u, v) => patch(u / 2, v));
  surfaceWithNormals(lower, 38, 10, (u, v) => patch((1 + u) / 2, v));
  tube(outline, u => profile(u, true), 0.031, 72);
  tube(innerOutline, u => profile(u, false), 0.024, 64);
  return [[upper, styles.lipUpper, 1, false], [lower, styles.lipLower, 1, false], [outline, styles.lipLine, 1, false],
    [innerOutline, styles.lipLineInner, 1, false]];
}

function strip(mesh, left, right, bottom, top, z) {
  if (right <= left || top <= bottom) return;
  quad(mesh, [left, bottom, z], [right, bottom, z], [right, top, z], [left, top, z]);
}

function aperturePanel(holes, width, height, z) {
  const panel = [];
  const walls = [];
  const sorted = [...holes].sort((a, b) => a.x - b.x);
  let edge = -width / 2;

  for (const hole of sorted) {
    const [left, right] = [hole.x - hole.width / 2, hole.x + hole.width / 2];
    strip(panel, edge, left, -height / 2, height / 2, z);
    edge = right;
    if (hole.shape === 'round') {
      const samples = 24;
      for (let i = 0; i < samples; i++) {
        const a = PI - i * PI / samples;
        const b = PI - (i + 1) * PI / samples;
        const [ax, bx] = [a, b].map(t => hole.x + (hole.width / 2) * Math.cos(t));
        const [ay, by] = [a, b].map(t => hole.height / 2 * Math.sin(t));
        quad(panel, [ax, hole.y + ay, z], [bx, hole.y + by, z],
          [bx, height / 2, z], [ax, height / 2, z]);
        quad(panel, [ax, -height / 2, z], [bx, -height / 2, z],
          [bx, hole.y - by, z], [ax, hole.y - ay, z]);
      }
      grid(walls, 48, 1, (u, v) => {
        const t = -u * TAU;
        const taper = 1 - 0.31 * v;
        return [hole.x + taper * Math.cos(t) * hole.width / 2,
          hole.y + taper * Math.sin(t) * hole.height / 2, z - 0.22 * v];
      });
    } else {
      const [bottom, top] = [hole.y - hole.height / 2, hole.y + hole.height / 2];
      strip(panel, left, right, top, height / 2, z);
      strip(panel, left, right, -height / 2, bottom, z);
      const points = [[left, bottom], [left, top], [right, top], [right, bottom]];
      for (let i = 0; i < 4; i++) {
        const a = points[i];
        const b = points[(i + 1) % 4];
        const inner = p => [hole.x + (p[0] - hole.x) * 0.77, hole.y + (p[1] - hole.y) * 0.73, z - 0.20];
        quad(walls, [...b, z], [...a, z], inner(a), inner(b));
      }
    }
  }
  strip(panel, edge, width / 2, -height / 2, height / 2, z);
  return { panel, walls };
}

function instrumentMeshes(model) {
  const { width: w, height: h, depth: d, mouthpieceZ: z, cover, hasSlide } = model.geometry;
  const rounded = cover === 'rounded';
  const hull = [];
  const highlights = [];
  const fasteners = [];
  const separator = [];
  const core = [];
  const dark = [];
  const slots = [];
  const slide = [];
  const sideRadius = rounded ? 0.13 : 0.09;
  const plateH = h * (rounded ? 0.22 : 0.21);
  const plateD = d * 0.99;
  const capHeight = h * (rounded ? 0.39 : 0.34);
  const coverZ = z - d * 0.53;

  // The front is a perforated mesh. The wells end on a recessed, dark comb face.
  const { panel, walls } = aperturePanel(model.holes, w - 0.08, h * 0.62, z);
  roundBox(core, [0, 0, z - d * 0.60], [w - 0.10, h * 0.65, d * 0.73], sideRadius);
  roundBox(dark, [0, 0, z - 0.235], [w - 0.10, h * 0.62, 0.026], 0.012);
  for (const side of [-1, 1]) {
    const x = side * (w / 2 - 0.062);
    roundBox(hull, [x, 0, z - d / 2 - 0.009], [0.16, h * 0.77, d * 0.98], 0.075);
    roundBox(separator, [x, 0, z - d * 0.78], [0.174, 0.078, d * 0.40], 0.035);
  }

  for (const side of [-1, 1]) {
    const y = side * (h / 2 - plateH / 2);
    roundBox(hull, [0, y, coverZ], [w, plateH, plateD], sideRadius);
    roundBox(hull, [0, side * (h / 2 - capHeight / 2 + 0.05), z - d * 0.57],
      [w * (rounded ? 0.91 : 0.94), capHeight, d * 0.77], rounded ? 0.20 : 0.12);
    roundBox(highlights, [0, side * (h * 0.337), z - 0.051], [w - 0.095, 0.094, 0.13], 0.045);
    roundBox(separator, [0, side * (h * 0.281), z - d * 0.54], [w - 0.16, 0.058, d * 0.84], 0.025);

    for (const xsign of [-1, 1]) {
      const x = xsign * w * 0.388;
      const top = side * (h / 2 + 0.047);
      ellipsoid(fasteners, [x, top, z - d * 0.49], [0.094, 0.024, 0.094]);
      roundBox(slots, [x, top + side * 0.023, z - d * 0.49], [0.076, 0.009, 0.013], 0.004);
    }
  }

  // Dark back seam and machined accents give the two faces of the object distinct cues.
  roundBox(dark, [0, 0, z - d * 0.984], [w * 0.89, h * 0.33, 0.065], 0.028);
  const divisions = rounded ? 6 : 8;
  for (let i = 0; i < divisions; i++) {
    const x = ((i + 0.5) / divisions - 0.5) * w * 0.81;
    roundBox(separator, [x, 0, z - d - 0.016], [0.065, h * 0.29, 0.046], 0.022);
  }
  if (hasSlide) {
    roundBox(separator, [w / 2 + 0.10, 0, z - d * 0.31], [0.42, 0.19, 0.27], 0.055);
    roundBox(slide, [w / 2 + 0.36, 0, z - d * 0.31], [0.29, h * 0.53, 0.57], 0.135);
    roundBox(highlights, [w / 2 + 0.49, 0, z - d * 0.31], [0.055, h * 0.32, 0.41], 0.026);
  }
  return [[hull, rounded ? styles.steel : styles.brushed], [highlights, styles.bright],
    [fasteners, styles.steel], [separator, rounded ? styles.gold : styles.gasket], [core, styles.well],
    [dark, styles.dark], [slots, styles.gasket], [panel, rounded ? styles.brushed : styles.gold],
    [walls, styles.well, 1, false], [slide, styles.copper]].filter(([mesh]) => mesh.length);
}

const VERTEX = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uView;
uniform mat4 uProjection;
uniform vec3 uOffset;
varying vec3 vPosition;
varying vec3 vNormal;
void main() {
  vPosition = aPosition + uOffset;
  vNormal = aNormal;
  gl_Position = uProjection * uView * vec4(vPosition, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform vec3 uEye;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uMetal;
varying vec3 vPosition;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(gl_FrontFacing ? vNormal : -vNormal);
  vec3 v = normalize(uEye - vPosition);
  vec3 key = normalize(vec3(-0.48, 0.75, -0.65));
  vec3 fill = normalize(vec3(0.52, 0.37, 0.72));
  float keyLight = max(0.0, dot(n, key));
  float fillLight = max(0.0, dot(n, fill));
  float edge = pow(1.0 - clamp(dot(v, n), 0.0, 1.0), 2.9);
  float spec = pow(max(0.0, dot(n, normalize(key + v))), mix(22.0, 52.0, uMetal));
  float second = pow(max(0.0, dot(n, normalize(fill + v))), 17.0);
  float studioBand = pow(max(0.0, dot(reflect(-v, n), normalize(vec3(0.38, 0.78, 0.48)))), 8.0);
  vec3 color = uColor * (0.58 + 0.28 * keyLight + 0.20 * fillLight);
  color += vec3(0.77, 0.87, 0.99) * (spec * (0.12 + 0.41 * uMetal) + second * 0.09);
  color += vec3(0.49, 0.65, 0.87) * edge * (0.16 + 0.22 * uMetal);
  color += vec3(0.42, 0.53, 0.65) * studioBand * 0.15 * uMetal;
  gl_FragColor = vec4(color, uOpacity);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'WebGL 셰이더 초기화 실패');
  }
  return shader;
}

function makeProgram(gl) {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  let fragment;
  let program;
  try {
    fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'WebGL 프로그램 연결 실패');
    }
    const attribute = name => gl.getAttribLocation(program, name);
    const uniform = name => gl.getUniformLocation(program, name);
    return { program, position: attribute('aPosition'), normal: attribute('aNormal'),
      view: uniform('uView'), projection: uniform('uProjection'), offset: uniform('uOffset'),
      eye: uniform('uEye'), color: uniform('uColor'), opacity: uniform('uOpacity'), metal: uniform('uMetal') };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  }
}

function upload(gl, meshes) {
  return meshes.map(([vertices, style, alpha = 1, cull = true]) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    return { buffer, count: vertices.length / 6, style, alpha, cull };
  });
}

export class Viewer {
  constructor(canvas, { onViewChange = () => {}, onFailure = () => {}, onRestore = () => {} } = {}) {
    this.canvas = canvas;
    this.onViewChange = onViewChange;
    this.onFailure = onFailure;
    this.onRestore = onRestore;
    this.model = null;
    this.position = null;
    this.transparency = 60;
    this.yaw = INITIAL_YAW;
    this.pitch = INITIAL_PITCH;
    this.preset = null;
    this.motion = null;
    this.drawFrame = null;
    this.drag = null;
    this.lost = false;
    this.disposed = false;
    this.abort = new AbortController();
    this.gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!this.gl) throw new Error('이 브라우저에서 WebGL을 사용할 수 없습니다.');
    this.initialize();
    this.listen();
    this.resize = new ResizeObserver(() => this.redraw());
    this.resize.observe(canvas);
    this.redraw();
  }

  initialize() {
    this.shader = makeProgram(this.gl);
    this.face = upload(this.gl, details());
    this.instrument = [];
    this.lips = [];
    if (this.model) this.rebuildModel();
  }

  listen() {
    const { signal } = this.abort;
    const { canvas } = this;
    canvas.addEventListener('pointerdown', event => {
      if (this.drag || event.button !== 0 || this.lost) return;
      this.cancelMotion();
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add('is-dragging');
    }, { signal });
    canvas.addEventListener('pointermove', event => {
      if (this.drag?.id !== event.pointerId) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      this.drag.x = event.clientX;
      this.drag.y = event.clientY;
      if (dx || dy) this.turn(-dx * 0.012, dy * 0.012);
    }, { signal });
    const stop = event => {
      if (this.drag?.id !== event.pointerId) return;
      this.drag = null;
      canvas.classList.remove('is-dragging');
    };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(event, stop, { signal });
    }

    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      this.lost = true;
      if (this.drag) stop({ pointerId: this.drag.id });
      this.onFailure(new Error('3D 그래픽 연결이 끊겼습니다.'));
    }, { signal });
    canvas.addEventListener('webglcontextrestored', () => {
      if (!this.lost) return;
      try {
        this.initialize();
        this.lost = false;
        this.onRestore();
        this.redraw();
      } catch (error) {
        this.onFailure(error);
      }
    }, { signal });
  }

  release(group) {
    for (const mesh of group) this.gl.deleteBuffer(mesh.buffer);
  }

  rebuildModel() {
    this.release(this.instrument);
    this.release(this.lips);
    this.instrument = this.model ? upload(this.gl, instrumentMeshes(this.model)) : [];
    this.lips = this.model ? upload(this.gl, lipMeshes(this.model.geometry.height)) : [];
  }

  setModel(model) {
    if (this.model === model) return;
    this.model = model;
    this.position = null;
    if (!this.lost) this.rebuildModel();
    this.redraw();
  }

  setPosition(position) {
    if (this.position === position) return;
    this.position = position;
    this.redraw();
  }

  setTransparency(percent) {
    if (!Number.isFinite(percent)) return;
    const next = clamp(percent, 0, 100);
    if (next === this.transparency) return;
    this.transparency = next;
    this.redraw();
  }

  setPreset(id) {
    if (!Object.hasOwn(PRESETS, id)) return;
    const [x, , z] = PRESETS[id];
    const yaw = Math.atan2(x, z);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || this.preset === id) {
      this.finishPreset(id, yaw);
    } else {
      const delta = yaw - this.yaw;
      const yawChange = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.motion = { id, yaw, yawChange, startYaw: this.yaw, startPitch: this.pitch, start: performance.now() };
      this.preset = null;
      this.onViewChange(null, id);
    }
    this.redraw();
  }

  finishPreset(id, yaw) {
    this.yaw = yaw;
    this.pitch = 0;
    this.preset = id;
    this.motion = null;
    this.onViewChange(id, null);
  }

  cancelMotion() {
    if (!this.motion) return;
    this.motion = null;
    this.onViewChange(null, null);
  }

  advanceMotion(time) {
    if (!this.motion) return;
    const { id, yaw, yawChange, startYaw, startPitch, start } = this.motion;
    const progress = clamp((time - start) / PRESET_DURATION, 0, 1);
    if (progress === 1) {
      this.finishPreset(id, yaw);
      return;
    }
    const eased = progress * progress * (3 - 2 * progress);
    this.yaw = startYaw + yawChange * eased;
    this.pitch = startPitch * (1 - eased);
  }

  turn(yaw, pitch) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || (!yaw && !pitch)) return;
    this.cancelMotion();
    this.yaw = (this.yaw + yaw) % TAU;
    this.pitch = clamp(this.pitch + pitch, -1.45, 1.45);
    if (this.preset !== null) {
      this.preset = null;
      this.onViewChange(null, null);
    }
    this.redraw();
  }

  redraw() {
    if (this.disposed || this.lost || this.drawFrame !== null) return;
    this.drawFrame = requestAnimationFrame(time => {
      this.drawFrame = null;
      this.advanceMotion(time);
      this.draw();
      if (this.motion) this.redraw();
    });
  }

  draw() {
    const { gl, canvas, shader } = this;
    if (this.lost || this.disposed) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const pixelW = Math.round(w * dpr);
    const pixelH = Math.round(h * dpr);
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    gl.viewport(0, 0, pixelW, pixelH);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.model) return;

    const aspect = w / h;
    const direction = this.preset ? PRESETS[this.preset] : cameraDirection(this.yaw, this.pitch);
    const view = calculateView(direction, aspect, this.model.geometry.width);
    const matrices = cameraMatrices(view, aspect);
    const contact = this.position?.contact;
    const offset = contact ?? [0, 0, this.model.geometry.mouthpieceZ + 0.44];
    const opacity = faceOpacity(this.transparency);

    gl.useProgram(shader.program);
    gl.uniformMatrix4fv(shader.view, false, matrices.view);
    gl.uniformMatrix4fv(shader.projection, false, matrices.projection);
    gl.uniform3fv(shader.eye, view.eye);
    gl.enableVertexAttribArray(shader.position);
    gl.enableVertexAttribArray(shader.normal);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.paint(this.instrument, [0, 0, 0], 1);
    this.paint(this.lips, offset, 1);

    if (opacity > 0) {
      gl.enable(gl.BLEND);
      // The semi-transparent face overlays nearby opaque surfaces without hiding the ones behind it.
      gl.depthMask(opacity === 1);
      this.paint(this.face, offset, opacity);
    }
    gl.depthMask(true);
  }

  paint(meshes, offset, opacity) {
    const { gl, shader } = this;
    gl.uniform3fv(shader.offset, offset);
    for (const mesh of meshes) {
      if (mesh.cull) gl.enable(gl.CULL_FACE);
      else gl.disable(gl.CULL_FACE);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
      gl.vertexAttribPointer(shader.position, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(shader.normal, 3, gl.FLOAT, false, 24, 12);
      gl.uniform3fv(shader.color, mesh.style.color);
      gl.uniform1f(shader.metal, mesh.style.metal);
      gl.uniform1f(shader.opacity, opacity * mesh.alpha);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.resize.disconnect();
    if (this.drawFrame !== null) cancelAnimationFrame(this.drawFrame);
    if (this.drag && this.canvas.hasPointerCapture(this.drag.id)) {
      this.canvas.releasePointerCapture(this.drag.id);
    }
    this.canvas.classList.remove('is-dragging');
    if (!this.lost) {
      this.release(this.face);
      this.release(this.lips);
      this.release(this.instrument);
      this.gl.deleteProgram(this.shader.program);
    }
  }
}
