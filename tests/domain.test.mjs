import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CATEGORIES, createStudy, faceOpacity, getLearningResult, getPosition, validateModel,
} from '../domain.mjs';

const compact = await readFixture('compact-study');
const slide = await readFixture('slide-study');

async function readFixture(id) {
  return JSON.parse(await readFile(new URL(`../models/${id}.json`, import.meta.url), 'utf8'));
}

function study(options = {}) {
  return createStudy({
    load: async (id) => structuredClone(id === compact.id ? compact : slide),
    ...options,
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function modelWithMapping(kind = 'pitches', verificationStatus = 'checked') {
  const model = {
    ...structuredClone(compact), fixture: false, manufacturer: 'Test only',
    product: 'Test only', key: 'C', tuning: 'Test only',
  };
  const positionId = model.positions[0].id;
  const evidence = {
    id: 'test-only',
    title: 'Test evidence fixture',
    source: 'https://example.test/fixture',
    locator: 'Test suite',
    checkedAt: '2026-11-06',
    scope: 'Software test only',
  };
  model.evidence = [evidence];
  model.verification = { ...model.verification, noteMapping: verificationStatus };
  model.verificationEvidence = {
    ...model.verificationEvidence,
    noteMapping: verificationStatus === 'checked' ? [evidence.id] : [],
  };
  model.noteMappings = [{
    positionId, breath: 'blow', mechanismState: {},
    result: {
      kind, verificationStatus, reason: 'Software test only',
      evidenceIds: verificationStatus === 'checked' ? [evidence.id] : [],
      ...(kind === 'pitches' ? { pitches: [{ noteName: 'C', octave: 4 }] } : {}),
    },
  }];
  return { model, positionId, breath: 'blow', mechanismState: {} };
}

test('T01 · face transparency converts only the requested scalar', () => {
  assert.equal(faceOpacity(0), 1);
  assert.equal(faceOpacity(50), 0.5);
  assert.equal(faceOpacity(100), 0);
  assert.equal(faceOpacity(-20), 1);
  assert.equal(faceOpacity(180), 0);
  for (const input of [NaN, Infinity, 'incorrect', undefined]) {
    const output = faceOpacity(input);
    assert.ok(Number.isFinite(output) && output >= 0 && output <= 1);
  }
});

test('T03 · fixture shapes and each category reference have valid identifiers', () => {
  assert.equal(validateModel(compact, compact.id), compact);
  assert.equal(validateModel(slide, slide.id), slide);
  assert.throws(() => validateModel(compact, slide.id));
  assert.throws(() => validateModel(null));
  assert.equal(CATEGORIES.find(({ id }) => id === 'diatonic').modelId, compact.id);
  assert.equal(CATEGORIES.find(({ id }) => id === 'blues').modelId, compact.id);
  assert.equal(CATEGORIES.find(({ id }) => id === 'chromatic').modelId, slide.id);
});

test('T03 · reject duplicate, missing, and invalid structural references', () => {
  for (const mutate of [
    (model) => { model.holes.push(structuredClone(model.holes[0])); },
    (model) => { model.positions.push(structuredClone(model.positions[0])); },
    (model) => { model.positions[0].physicalHoleIds = ['missing-hole']; },
    (model) => { model.positions[0].contact = [0, 0, NaN]; },
    (model) => { model.geometry.width = 0; },
    (model) => { model.verification.geometry = 'checked'; },
    (model) => { model.verification.noteMapping = 'invented-state'; },
  ]) {
    const model = structuredClone(compact);
    mutate(model);
    assert.throws(() => validateModel(model));
  }
});

test('T03 · reject invalid note, state, and evidence references', () => {
  for (const mutate of [
    (mapping) => { mapping.positionId = 'missing-position'; },
    (mapping) => { mapping.breath = 'automatic'; },
    (mapping) => { mapping.mechanismState = { imaginary: 'on' }; },
    (mapping) => { mapping.result.pitches = []; },
    (mapping) => { mapping.result.pitches[0].noteName = 'R'; },
    (mapping) => { mapping.result.pitches[0].octave = 4.5; },
    (mapping) => { mapping.result.evidenceIds = ['missing-source']; },
    (mapping) => { mapping.result.kind = 'silent'; },
  ]) {
    const { model } = modelWithMapping();
    mutate(model.noteMappings[0]);
    assert.throws(() => validateModel(model));
  }
  const state = modelWithMapping();
  state.model.mechanisms = [{ id: 'slide', requiredForPitch: true, states: ['out', 'in'] }];
  state.model.noteMappings[0].mechanismState = { slide: 'broken' };
  assert.throws(() => validateModel(state.model));
});

test('T04 · checked pitch route and distinct unknown, unsupported and silent routes', () => {
  for (const kind of ['pitches', 'unknown', 'unsupported', 'silent']) {
    const state = modelWithMapping(kind);
    assert.equal(validateModel(state.model), state.model);
    const result = getLearningResult(state);
    assert.equal(result.kind, kind);
    if (kind === 'pitches') {
      assert.deepEqual(result.pitches, [{ noteName: 'C', octave: 4 }]);
    } else {
      assert.equal(result.pitches, undefined);
    }
  }
});

test('T04 · block unverified note mappings, geometry-only checks and unspecified mechanisms', () => {
  for (const verification of ['unspecified', 'provisional', 'conflict']) {
    const state = modelWithMapping('pitches', verification);
    assert.equal(getLearningResult(state).kind, 'unknown');
    assert.equal(getLearningResult(state).pitches, undefined);
  }

  const geometryOnly = modelWithMapping('pitches', 'provisional');
  geometryOnly.model.verification.geometry = 'checked';
  geometryOnly.model.verificationEvidence.geometry = ['test-only'];
  geometryOnly.model.noteMappings[0].result.verificationStatus = 'checked';
  geometryOnly.model.noteMappings[0].result.evidenceIds = ['test-only'];
  assert.equal(getLearningResult(geometryOnly).kind, 'unknown');

  const unknownSlide = modelWithMapping();
  unknownSlide.model.mechanisms = [{ id: 'slide', requiredForPitch: true, states: ['out', 'in'] }];
  unknownSlide.model.noteMappings[0].mechanismState = { slide: 'out' };
  assert.equal(getLearningResult(unknownSlide).kind, 'unknown');
  unknownSlide.mechanismState = { slide: 'out' };
  assert.equal(getLearningResult(unknownSlide).kind, 'pitches');
});

test('T05 · changing position updates the current contact and note lookup follows selected breath', async () => {
  const stateWithMapping = modelWithMapping();
  const app = study({ load: async () => stateWithMapping.model });
  await app.selectCategory('diatonic');
  const first = stateWithMapping.model.positions[0];
  const second = stateWithMapping.model.positions[1];
  app.selectPosition(first.id);
  app.selectBreath('blow');
  assert.deepEqual(getPosition(app.getState()).contact, first.contact);
  assert.equal(getLearningResult(app.getState()).kind, 'pitches');
  app.selectBreath('draw');
  assert.equal(getLearningResult(app.getState()).kind, 'unknown');
  app.selectPosition(second.id);
  app.selectBreath('blow');
  assert.deepEqual(getPosition(app.getState()).contact, second.contact);
  assert.equal(getLearningResult(app.getState()).kind, 'unknown');
  app.selectPosition(null);
  assert.equal(getPosition(app.getState()), null);
  assert.equal(app.getState().breath, 'none');
  assert.equal(getLearningResult(app.getState()).kind, 'unknown');
});

test('T06 · model bundles change together, with transparency and same-model alias state preserved', async () => {
  const app = study();
  await app.selectCategory('diatonic');
  app.selectPosition(compact.positions[0].id);
  app.selectBreath('draw');
  app.setTransparency(73);
  await app.selectCategory('blues');
  assert.equal(app.getState().categoryId, 'blues');
  assert.equal(app.getState().model.id, compact.id);
  assert.equal(app.getState().positionId, compact.positions[0].id);
  assert.equal(app.getState().breath, 'draw');
  await app.selectCategory('chromatic');
  const state = app.getState();
  assert.equal(state.categoryId, 'chromatic');
  assert.equal(state.model.id, slide.id);
  assert.notDeepEqual(state.model.geometry, compact.geometry);
  assert.notDeepEqual(state.model.holes, compact.holes);
  assert.notDeepEqual(state.model.positions, compact.positions);
  assert.equal(state.positionId, null);
  assert.equal(state.breath, 'none');
  assert.equal(state.transparency, 73);
});

test('T07 · A → B → A ignores outdated successful and failed completions', async () => {
  const pending = [];
  const app = study({
    load(id, options) {
      const request = deferred();
      pending.push({ ...request, id, signal: options?.signal });
      return request.promise;
    },
  });
  const first = app.selectCategory('diatonic');
  const second = app.selectCategory('chromatic');
  const third = app.selectCategory('diatonic');
  assert.equal(pending.length, 3);
  assert.equal(app.getState().requestedCategoryId, 'diatonic');
  assert.equal(app.getState().loadState, 'loading');
  pending[2].resolve(structuredClone(compact));
  await third;
  const latest = app.getState();
  pending[0].reject(new Error('stale request'));
  pending[1].resolve(structuredClone(slide));
  await Promise.all([first, second]);
  assert.equal(app.getState(), latest);
  assert.equal(latest.model.id, compact.id);
  assert.equal(latest.loadState, 'ready');
  assert.ok(pending[0].signal?.aborted);
  assert.ok(pending[1].signal?.aborted);
});

test('T08 · data failure keeps state safe, retry restores it, and disposal ignores late responses', async () => {
  let next = deferred();
  const changes = [];
  const app = study({
    load: () => next.promise,
    onChange: (state) => changes.push(state),
  });

  const load = app.selectCategory('chromatic');
  next.resolve({ id: slide.id });
  await load;
  assert.equal(app.getState().loadState, 'error');
  assert.equal(app.getState().model, null);
  assert.ok(app.getState().error);

  next = deferred();
  const retry = app.retry();
  next.resolve(structuredClone(slide));
  await retry;
  assert.equal(app.getState().loadState, 'ready');
  assert.equal(app.getState().model.id, slide.id);

  next = deferred();
  const late = app.selectCategory('diatonic');
  app.dispose();
  const count = changes.length;
  next.resolve(structuredClone(compact));
  await late;
  assert.equal(changes.length, count);
});
