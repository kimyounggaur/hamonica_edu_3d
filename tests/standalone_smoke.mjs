import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('../dist/harmonica-3d.html', import.meta.url);
const html = await readFile(target, 'utf8');
const inlineModels = html.match(/<script type="application\/json" id="offline-models">([\s\S]*?)<\/script>/);
const inlineApp = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(inlineModels && inlineApp, 'standalone HTML contains inline app code and model data');
assert.match(html, /<style>[\s\S]+<\/style>/);
assert.doesNotMatch(html, /<(?:link\b[^>]*rel="stylesheet"|script\b[^>]*src=)/i);

const imports = [...inlineApp[1].matchAll(/\bfrom "(data:text\/javascript;base64,[^"]+)"/g)].map(match => match[1]);
assert.equal(imports.length, 2, 'standalone app imports two embedded ESM dependencies');
const modules = await Promise.all(imports.map(specifier => import(specifier)));
const domain = modules.find(module => typeof module.validateModel === 'function');
assert.ok(modules.some(module => typeof module.Viewer === 'function'), 'embedded scene module resolves');
assert.ok(domain, 'embedded domain module resolves');

const models = JSON.parse(inlineModels[1]);
const study = domain.createStudy({
  load: async id => domain.validateModel(models[id], id),
});
await study.selectCategory('diatonic');
assert.equal(study.getState().model.id, 'compact-study');
assert.equal(study.getState().loadState, 'ready');
await study.selectCategory('chromatic');
assert.equal(study.getState().model.id, 'slide-study');
assert.equal(study.getState().loadState, 'ready');
study.dispose();
console.log('Standalone HTML: embedded CSS, model data, both ESM dependencies and both model loads passed.');
