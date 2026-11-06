import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises'
import {validateModel} from '../domain.mjs'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const escapeScript = code => code.replace(/<\/script/gi, '<\\/script')

const [html, css, domain, scene, app, modelFiles] = await Promise.all([
  read('index.html'), read('styles.css'), read('domain.mjs'), read('scene.mjs'), read('app.mjs'),
  readdir(new URL('models/', root))
])
const models = {}
for (const file of modelFiles.filter(name => name.endsWith('.json'))) {
  const id = file.slice(0, -5)
  models[id] = validateModel(JSON.parse(await read('models/' + file)), id)
}
const domainUrl = JSON.stringify(moduleUrl(domain))
const sceneUrl = JSON.stringify(moduleUrl(scene.replace("'./domain.mjs'", domainUrl)))
const source = app
  .replace("'./domain.mjs'", domainUrl)
  .replace("'./scene.mjs'", sceneUrl)
const portable = html
  .replace('<link rel="stylesheet" href="./styles.css">', () => '<style>\n' + css + '</style>')
  .replace('<script type="module" src="./app.mjs"></script>', () =>
    '<script type="application/json" id="offline-models">' + JSON.stringify(models).replaceAll('<', '\\u003c') +
    '</script>\n  <script type="module">\n' + escapeScript(source) + '</script>')
const dist = new URL('dist/', root)
await mkdir(dist, {recursive: true})
await writeFile(new URL('harmonica-3d.html', dist), portable)
console.log('dist/harmonica-3d.html')
