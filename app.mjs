import {BREATHS, CATEGORIES, createStudy, getLearningResult, getPosition, validateModel} from './domain.mjs'
import {Viewer} from './scene.mjs'

const node = id => document.getElementById(id)
const app = node('app')
let canvas = node('viewer')
const modelStatus = node('model-status')
const modelRetry = node('model-retry')
const sceneMessage = node('scene-message')
const fallback = node('fallback')
const viewerRetry = node('viewer-retry')
const slider = node('transparency')
const sliderValue = node('transparency-value')
const positions = node('position')
const positionLabel = node('learning-position')
const breathExplanation = node('learning-breath')
const resultLabel = node('note-label')
const resultBody = node('learning-result')
const learningLive = node('learning-live')
const stateSummary = node('state-summary')
const categoryButtons = [...document.querySelectorAll('[data-category]')]
const presetButtons = [...document.querySelectorAll('[data-view]:is(button)')]
const breathButtons = {blow: node('breath-blow'), draw: node('breath-draw')}
const viewNames = {free: '자유 시점', front: '정면', back: '후면', left: '왼쪽', right: '오른쪽'}
const resultNames = {unknown: '음 정보 · 검증 대기', unsupported: '음 정보 · 지원하지 않음', silent: '음 정보 · 무음', pitches: '검증된 음명과 옥타브'}

let viewer = null
let viewerFailure = false
let renderedModel = null
let sceneModel = null
let scenePosition
let sceneTransparency
let lastState = null
const lifecycle = new AbortController()
let viewerKeys = new AbortController()

const offlineSource = node('offline-models')
const offlineModels = offlineSource ? JSON.parse(offlineSource.textContent) : null
const study = createStudy({
  load: offlineModels ? async id => validateModel(offlineModels[id], id) : undefined,
  onChange: render
})

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value
}

function setView(id, pendingId) {
  const view = Object.hasOwn(viewNames, id) ? id : 'free'
  app.dataset.view = view
  setText(node('view-status'), pendingId ? `${viewNames[pendingId]} 이동 중` : viewNames[view])
  for (const button of presetButtons) button.setAttribute('aria-pressed', String(button.dataset.view === view))
}

function renderScene(state, position) {
  if (!viewer) return
  if (sceneModel !== state.model) {
    viewer.setModel(state.model)
    sceneModel = state.model
    scenePosition = undefined
  }
  if (scenePosition !== position) {
    viewer.setPosition(position)
    scenePosition = position
  }
  if (sceneTransparency !== state.transparency) {
    viewer.setTransparency(state.transparency)
    sceneTransparency = state.transparency
  }
}

function updateStageStatus(state) {
  const message = {
    idle: '임시 모델을 준비하는 중입니다.',
    loading: state.model ? '이전 모델 표시 중 · 새 모델을 불러오는 중' : '임시 모델을 불러오는 중입니다.',
    error: state.model ? '이전 모델 표시 중 · 모델 전환 실패' : '모델을 표시할 수 없습니다. 위에서 다시 시도하세요.',
    ready: ''
  }[state.loadState]
  setText(sceneMessage, message)
  sceneMessage.hidden = viewerFailure || !message
}

function setViewerAvailability(error = '') {
  const hadFocus = document.activeElement === viewerRetry
  viewerFailure = Boolean(error)
  fallback.hidden = !viewerFailure
  if (viewerFailure) setText(node('fallback-message'), error)
  node('viewer-help').hidden = viewerFailure
  canvas.tabIndex = viewerFailure ? -1 : 0
  canvas.setAttribute('aria-hidden', String(viewerFailure))
  for (const button of presetButtons) button.disabled = viewerFailure
  updateStageStatus(study.getState())
  if (hadFocus && !viewerFailure) canvas.focus()
}

function openViewer(retry = false) {
  viewer?.dispose()
  if (retry) {
    viewerKeys.abort()
    viewerKeys = new AbortController()
    const replacement = canvas.cloneNode()
    canvas.replaceWith(replacement)
    canvas = replacement
  }
  canvas.addEventListener('keydown', turnWithKeys, {signal: viewerKeys.signal})
  viewer = null
  sceneModel = null
  scenePosition = undefined
  sceneTransparency = undefined
  setView('free')
  try {
    viewer = new Viewer(canvas, {
      onViewChange: setView,
      onFailure: () => setViewerAvailability('3D 장면에 연결할 수 없습니다.'),
      onRestore: () => setViewerAvailability()
    })
    setViewerAvailability()
    const state = study.getState()
    renderScene(state, getPosition(state))
  } catch {
    setViewerAvailability('이 환경에서는 3D 장면을 표시할 수 없습니다.')
  }
}

function render(state) {
  const {model, categoryId, requestedCategoryId, loadState, breath, transparency} = state
  const position = getPosition(state)
  const result = getLearningResult(state)
  const ready = loadState === 'ready'
  const requested = CATEGORIES.find(category => category.id === requestedCategoryId)
  const current = CATEGORIES.find(category => category.id === categoryId)
  const prior = lastState
  app.dataset.model = model?.id ?? ''
  app.dataset.load = loadState
  for (const button of categoryButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.category === categoryId))
    button.setAttribute('aria-busy', String(loadState === 'loading' && button.dataset.category === requestedCategoryId))
  }
  const statusText = {
    idle: '임시 모델 준비 중',
    loading: `${requested?.label ?? '악기'} 불러오는 중`,
    error: `${requested?.label ?? '악기'} · ${state.error} ${state.notice}`,
    ready: current?.alias ? state.notice || '다이아토닉과 같은 임시 구조' :
      `${model?.title ?? '악기'} · ${model?.fixture ? '규격 미확정' : model?.key ?? '조성 미정'}`
  }[loadState]
  setText(modelStatus, statusText)
  if (loadState !== 'error' && document.activeElement === modelRetry) {
    categoryButtons.find(button => button.dataset.category === requestedCategoryId)?.focus()
  }
  modelRetry.hidden = loadState !== 'error'

  if (renderedModel !== model) {
    const options = [new Option('위치를 선택하세요', '')]
    for (const item of model?.positions ?? []) options.push(new Option(item.label, item.id))
    positions.replaceChildren(...options)
    renderedModel = model
  }
  positions.disabled = !ready
  positions.value = state.positionId ?? ''
  for (const [id, button] of Object.entries(breathButtons)) {
    button.disabled = !ready || !position
    button.setAttribute('aria-pressed', String(breath === id && ready))
  }
  setText(node('input-reason'), !ready ? '모델이 준비되면 위치와 호흡을 선택할 수 있습니다.' :
    !position ? state.notice || '연주 위치를 먼저 선택하세요.' : '선택한 위치에서 날숨과 들숨을 비교해 보세요.')

  slider.value = String(transparency)
  slider.setAttribute('aria-valuetext', `${transparency}%`)
  sliderValue.value = `${transparency}%`
  setText(positionLabel, !ready ? '모델 준비 후 관찰 가능' : position ?
    `${position.label} · 입술 접촉` : '살펴볼 위치를 선택하세요.')
  const instruction = BREATHS[breath]
  setText(breathExplanation, ready && position && instruction ? instruction.description :
    '입술 윤곽과 취구가 만나는 곳을 관찰해 보세요.')
  setText(resultLabel, resultNames[result.kind])
  let resultText = result.kind === 'pitches'
    ? result.pitches.map(pitch => `${pitch.noteName}${pitch.accidental ?? ''}${pitch.octave}`).join(' · ')
    : result.reason ?? '상세 정보가 없습니다.'
  if (ready && model?.fixture && result.kind === 'unknown') {
    resultText = `미검증 · ${position && breath !== 'none' ? resultText : '실제 모델의 규격과 음 배열 확인이 필요합니다.'}`
  }
  setText(resultBody, resultText)
  setText(stateSummary, `${model?.title ?? '악기 미선택'}. ${ready ? '' : statusText + '. '}${position && ready ? position.label : '위치 미선택'}. ${ready && instruction ? instruction.label : '호흡 미선택'}. 얼굴 투명도 ${transparency}%. ${resultNames[result.kind]}. ${resultText}`)
  if (prior && ready && (prior.breath !== breath || prior.positionId !== state.positionId)) {
    setText(learningLive, `${positionLabel.textContent.replace(/\.$/, '')}. ${instruction?.label ?? '호흡 미선택'}. ${resultText}`)
  }
  updateStageStatus(state)
  renderScene(state, position)
  lastState = state
}

function listen(element, name, handler) {
  element.addEventListener(name, handler, {signal: lifecycle.signal})
}

for (const button of categoryButtons) {
  listen(button, 'click', () => study.selectCategory(button.dataset.category))
}
for (const button of presetButtons) {
  listen(button, 'click', () => viewer?.setPreset(button.dataset.view))
}
for (const [id, button] of Object.entries(breathButtons)) {
  listen(button, 'click', () => study.selectBreath(id))
}
listen(modelRetry, 'click', () => study.retry())
listen(viewerRetry, 'click', () => openViewer(true))
listen(slider, 'input', () => study.setTransparency(slider.valueAsNumber))
listen(positions, 'change', () => study.selectPosition(positions.value || null))
const turns = {ArrowLeft: [-0.16, 0], ArrowRight: [0.16, 0], ArrowUp: [0, 0.14], ArrowDown: [0, -0.14]}
function turnWithKeys(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || !Object.hasOwn(turns, event.key)) return
  event.preventDefault()
  viewer?.turn(...turns[event.key])
}
listen(document.querySelector('.help-link'), 'click', () => { node('guide').open = true })
listen(document.querySelector('.brand'), 'click', event => {
  event.preventDefault()
  window.scrollTo({top: 0, behavior: 'instant'})
})
listen(window, 'pagehide', event => {
  if (event.persisted) return
  study.dispose()
  viewer?.dispose()
  viewerKeys.abort()
  lifecycle.abort()
})

render(study.getState())
openViewer()
study.selectCategory('diatonic')
