import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
if (process.argv.length !== 3) throw new Error('Usage: node meshes.mjs <output-directory>');
const app = fileURLToPath(new URL('../../', import.meta.url));
const scene = fs.readFileSync(path.join(app, 'scene.mjs'), 'utf8')
  .replace("'./domain.mjs'", JSON.stringify(pathToFileURL(path.join(app, 'domain.mjs')).href));
const add = 'export { details, instrumentMeshes, lipMeshes, cameraMatrices, VERTEX, FRAGMENT, INITIAL_YAW, INITIAL_PITCH };';
const data = Buffer.from(scene + '\n' + add).toString('base64');
const lib = await import(`data:text/javascript;base64,${data}`);
const root = path.resolve(process.argv[2]);
fs.mkdirSync(root, { recursive: true });
const manifest = { shader: [lib.VERTEX, lib.FRAGMENT], models: {}, meshes: [], sizes: {} };
function write(name, specs) {
  return specs.map(([vertices, style, alpha = 1, cull = true], i) => {
    const filename = `${name}-${i}.bin`;
    fs.writeFileSync(path.join(root, filename), Buffer.from(new Float32Array(vertices).buffer));
    manifest.meshes.push({ filename, count: vertices.length / 6, style, alpha, cull });
    return manifest.meshes.length - 1;
  });
}
manifest.face = write('face', lib.details());
for (const name of ['compact-study','slide-study']) {
  const model = JSON.parse(fs.readFileSync(path.join(app,'models',name+'.json'),'utf8'));
  manifest.models[name] = {
    instrument: write(name, lib.instrumentMeshes(model)),
    lips: write(name+'-lips', lib.lipMeshes(model.geometry.height)),
    offset: model.positions.find(pos => pos.id === model.defaultPositionId).contact,
    alternate: model.positions.at(-1).contact,
  };
  for (const [size, [w,h]] of Object.entries({desktop:[768,465],mobile:[330,330]})) {
    manifest.sizes[size] ??= {w,h};
    const views = {};
    const alt = {free:lib.cameraDirection(lib.INITIAL_YAW,lib.INITIAL_PITCH),
      'free-left':lib.cameraDirection(-1.15,0.19), ...lib.PRESETS};
    for (const [id,dir] of Object.entries(alt)) {
      const view = lib.calculateView(dir,w/h,model.geometry.width);
      views[id] = {...lib.cameraMatrices(view,w/h), eye:view.eye};
    }
    manifest.models[name][size] = views;
  }
}
fs.writeFileSync(path.join(root,'manifest.json'), JSON.stringify(manifest));
