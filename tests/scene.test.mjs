import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_UP, PRESETS, calculateView, cameraDirection } from '../scene.mjs';

function nearlyEqual(actual, expected, error = 1e-7) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < error,
    `${actual} is not near ${expected}`));
}

test('T02 · player-relative preset axes and default world up are consistent', () => {
  assert.deepEqual(PRESETS.front, [0, 0, -1]);
  assert.deepEqual(PRESETS.back, [0, 0, 1]);
  assert.deepEqual(PRESETS.left, [-1, 0, 0]);
  assert.deepEqual(PRESETS.right, [1, 0, 0]);
  assert.deepEqual(CAMERA_UP, [0, 1, 0]);
  nearlyEqual(cameraDirection(Math.PI, 0), PRESETS.front);
  nearlyEqual(cameraDirection(0, 0), PRESETS.back);
  nearlyEqual(cameraDirection(-Math.PI / 2, 0), PRESETS.left);
  nearlyEqual(cameraDirection(Math.PI / 2, 0), PRESETS.right);
});

test('T02 · fitting different viewports and instrument widths preserves preset direction and target', () => {
  for (const direction of [...Object.values(PRESETS), cameraDirection(Math.PI / 3, Math.PI / 5)]) {
    const reference = calculateView(direction, 1.6, 6.35);
    for (const aspect of [0.75, 1, 1.6, 2]) {
      for (const width of [4.5, 6.35, 7.5]) {
        const { eye, target, up, distance } = calculateView(direction, aspect, width);
        const offset = eye.map((value, index) => value - target[index]);
        const norm = Math.hypot(...offset);
        assert.ok(norm > 0 && Number.isFinite(distance));
        nearlyEqual(offset.map((value) => value / norm), direction);
        nearlyEqual(target, reference.target);
        nearlyEqual(up, CAMERA_UP);
      }
    }
  }
});
