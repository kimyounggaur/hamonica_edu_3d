import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Viewer } from '../scene.mjs';

const compact = await readFixture('compact-study');
const slide = await readFixture('slide-study');

async function readFixture(id) {
  return JSON.parse(await readFile(new URL(`../models/${id}.json`, import.meta.url), 'utf8'));
}

function mockRenderer(t, reducedMotion = true) {
  const frames = new Map();
  const buffers = new Set();
  const draws = [];
  const programs = new Set();
  let sequence = 0;
  let boundBuffer;
  let opacity;
  let offset;
  let depthWrite;
  let eye;
  const gl = new Proxy({
    createShader: () => Symbol('shader'),
    getShaderParameter: () => true,
    createProgram() {
      const id = Symbol('program');
      programs.add(id);
      return id;
    },
    deleteProgram: program => programs.delete(program),
    getProgramParameter: () => true,
    getAttribLocation: (_, name) => name,
    getUniformLocation: (_, name) => name,
    createBuffer() {
      const id = Symbol('buffer');
      buffers.add(id);
      return id;
    },
    deleteBuffer: buffer => buffers.delete(buffer),
    bindBuffer(_, buffer) { boundBuffer = buffer; },
    bufferData(_, data) {
      assert.ok(data instanceof Float32Array && data.length > 0 && data.length % 6 === 0);
      assert.ok(data.every(Number.isFinite));
    },
    clear() { draws.length = 0; },
    depthMask(value) { depthWrite = value; },
    uniform3fv(name, value) {
      if (name === 'uOffset') offset = [...value];
      if (name === 'uEye') eye = [...value];
    },
    uniform1f(name, value) {
      if (name === 'uOpacity') opacity = value;
    },
    drawArrays(_, __, count) {
      assert.ok(buffers.has(boundBuffer));
      assert.ok(count > 0 && count % 3 === 0);
      draws.push({ buffer: boundBuffer, opacity, offset, depthWrite, eye, count });
    },
  }, {
    get(target, key) {
      return target[key] ?? (/^[A-Z_]+$/.test(key) ? 1 : () => {});
    },
  });

  const originals = new Map();
  for (const [name, value] of Object.entries({
    window: { devicePixelRatio: 1, matchMedia: () => ({ matches: reducedMotion }) },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: id => frames.delete(id),
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  class Canvas extends EventTarget {
    clientWidth = 1000;
    clientHeight = 650;
    classList = new Set();
    capturedPointer = null;

    constructor() {
      super();
      this.classList.remove = this.classList.delete;
    }

    getContext() { return gl; }
    hasPointerCapture(id) { return id === this.capturedPointer; }
    setPointerCapture(id) { this.capturedPointer = id; }
    releasePointerCapture() { this.capturedPointer = null; }
  }

  return {
    canvas: new Canvas(), draws, frames, buffers, programs,
    frame(time = performance.now()) {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(time);
      }
      return draws.map(draw => ({ ...draw }));
    },
    lose() {
      buffers.clear();
      programs.clear();
    },
  };
}


test('T01/T05 · renderer keeps instrument and lips independent of face transparency', (t) => {
  const renderer = mockRenderer(t);
  const viewer = new Viewer(renderer.canvas);
  viewer.setModel(compact);
  viewer.setPosition(compact.positions[0]);
  const middle = renderer.frame();
  viewer.setTransparency(0);
  const solid = renderer.frame();
  viewer.setTransparency(100);
  const hidden = renderer.frame();

  assert.ok(hidden.length > 0 && hidden.length < solid.length);
  assert.equal(middle.length, solid.length);
  assert.deepEqual(hidden, solid.slice(0, hidden.length));
  assert.deepEqual(hidden, middle.slice(0, hidden.length));
  assert.ok(solid.slice(hidden.length).every(draw => draw.depthWrite));
  assert.ok(middle.slice(hidden.length).every(draw => !draw.depthWrite && draw.opacity > 0 && draw.opacity <= .4));
  assert.deepEqual(hidden[0].offset, [0, 0, 0]);
  assert.deepEqual(hidden.at(-1).offset, compact.positions[0].contact);
  assert.equal(renderer.buffers.size, solid.length);

  viewer.setPosition(compact.positions.at(-1));
  const moved = renderer.frame();
  assert.deepEqual(moved[0], hidden[0]);
  assert.deepEqual(moved.at(-1).offset, compact.positions.at(-1).contact);
  viewer.dispose();
  assert.equal(renderer.buffers.size, 0);
  assert.equal(renderer.programs.size, 0);
});

test('T02/T08/T09 · model changes preserve view, pointers remain scoped, and graphics resources are released', (t) => {
  const renderer = mockRenderer(t);
  const viewChanges = [];
  const issues = [];
  let restored = 0;
  const viewer = new Viewer(renderer.canvas, {
    onViewChange: preset => viewChanges.push(preset),
    onFailure: error => issues.push(error),
    onRestore: () => restored++,
  });

  viewer.setModel(compact);
  viewer.setPreset('right');
  viewer.setTransparency(50);
  renderer.frame();
  const foreignPointer = new EventTarget();
  foreignPointer.dispatchEvent(new Event('pointermove'));
  assert.deepEqual(viewChanges, ['right']);

  const pointer = (type, x, y) => Object.assign(new Event(type), {
    button: 0, pointerId: 3, clientX: x, clientY: y,
  });
  renderer.canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  renderer.canvas.dispatchEvent(pointer('pointermove', 140, 120));
  renderer.canvas.dispatchEvent(pointer('pointercancel', 140, 120));
  const freeEye = renderer.frame()[0].eye;
  assert.deepEqual(viewChanges, ['right', null]);
  renderer.canvas.dispatchEvent(pointer('pointermove', 170, 150));
  assert.equal(renderer.frames.size, 0);

  viewer.setModel(slide);
  const newSize = renderer.frame().length;
  assert.equal(viewer.transparency, 50);
  assert.equal(viewer.preset, null);
  assert.equal(renderer.buffers.size, newSize);
  assert.deepEqual(viewChanges, ['right', null]);
  assert.equal(Math.sign(renderer.draws[0].eye[0]), Math.sign(freeEye[0]));

  for (let i = 0; i < 30; i += 1) {
    viewer.setModel(i % 2 === 0 ? compact : slide);
    const rendered = renderer.frame();
    assert.equal(renderer.buffers.size, rendered.length);
  }
  assert.equal(renderer.buffers.size, newSize);
  assert.equal(renderer.programs.size, 1);

  const lost = new Event('webglcontextlost', { cancelable: true });
  renderer.canvas.dispatchEvent(lost);
  renderer.lose();
  assert.ok(lost.defaultPrevented);
  assert.equal(issues.length, 1);
  viewer.setTransparency(55);
  assert.equal(renderer.frames.size, 0);
  renderer.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(restored, 1);
  assert.equal(renderer.frame().length, newSize);
  viewer.dispose();
  assert.equal(renderer.buffers.size, 0);
  assert.equal(renderer.programs.size, 0);
  renderer.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(restored, 1);
});


test('T02/V03 · preset animation reports pending, cancels for drag, and accepts the latest request', (t) => {
  const renderer = mockRenderer(t, false);
  const viewChanges = [];
  const viewer = new Viewer(renderer.canvas, {
    onViewChange: (active, pending) => viewChanges.push([active, pending]),
  });
  viewer.setModel(compact);
  viewer.setPosition(compact.positions[0]);
  viewer.setTransparency(75);
  const initialEye = renderer.frame()[0].eye;

  viewer.setPreset('front');
  assert.deepEqual(viewChanges, [[null, 'front']]);
  const inMotionEye = renderer.frame(performance.now() + 100)[0].eye;
  assert.notDeepEqual(inMotionEye, initialEye);
  assert.equal(renderer.frames.size, 1);

  const pointer = (type, x, y) => Object.assign(new Event(type), {
    button: 0, pointerId: 4, clientX: x, clientY: y,
  });
  renderer.canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  renderer.canvas.dispatchEvent(pointer('pointermove', 140, 115));
  renderer.canvas.dispatchEvent(pointer('pointerup', 140, 115));
  const freeEye = renderer.frame(performance.now() + 600)[0].eye;
  assert.notDeepEqual(freeEye, inMotionEye);
  assert.deepEqual(viewChanges.at(-1), [null, null]);
  assert.equal(renderer.frames.size, 0);

  viewer.setPreset('left');
  viewer.setPreset('back');
  renderer.frame(performance.now() + 600);
  assert.deepEqual(viewChanges.slice(-3), [[null, 'left'], [null, 'back'], ['back', null]]);
  assert.equal(viewer.position, compact.positions[0]);
  assert.equal(viewer.transparency, 75);
  assert.equal(viewer.model, compact);
  viewer.dispose();
});
