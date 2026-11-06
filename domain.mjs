// Model data is the shared contract between the learning panel and the renderer.

/** @typedef {'unspecified' | 'provisional' | 'checked' | 'conflict'} VerificationStatus */
/** @typedef {'none' | 'blow' | 'draw'} Breath */
/** @typedef {'diatonic' | 'chromatic' | 'blues'} CategoryId */
/** @typedef {[number, number, number]} Vec3 */
/** @typedef {{noteName:'A'|'B'|'C'|'D'|'E'|'F'|'G', octave:number, accidental?:'#'|'b'|'##'|'bb'}} Pitch */
/**
 * @typedef {({kind:'unknown'|'unsupported'|'silent', pitches?:never}
 *   | {kind:'pitches', pitches:[Pitch, ...Pitch[]]}) &
 *   {verificationStatus:VerificationStatus, evidenceIds:string[], reason?:string}} NoteResult
 */
/** @typedef {{positionId:string, breath:Exclude<Breath,'none'>, mechanismState:Record<string,string>, result:NoteResult}} NoteMapping */
/** @typedef {{id:string, x:number, y:number, width:number, height:number, shape:'rect'|'round'}} Hole */
/** @typedef {{id:string, label:string, physicalHoleIds:string[], contact:Vec3}} Position */
/** @typedef {{id:string, requiredForPitch:boolean, states:string[], defaultState?:string}} Mechanism */
/** @typedef {{id:string, title:string, source:string, locator:string, checkedAt:string, scope:string}} Evidence */
/** @typedef {'geometry'|'noteMapping'|'notation'|'contactModel'} VerificationField */
/**
 * @typedef {object} Model
 * @property {string} id
 * @property {string} title
 * @property {'diatonic'|'chromatic'} family
 * @property {boolean} fixture
 * @property {string|null} manufacturer
 * @property {string|null} product
 * @property {string|null} key
 * @property {string|null} tuning
 * @property {{width:number,height:number,depth:number,mouthpieceZ:number,hasSlide:boolean,cover:'rounded'|'flat',unit:'scene'}} geometry
 * @property {Hole[]} holes
 * @property {Position[]} positions
 * @property {{up:Vec3,mouthpieceNormal:Vec3,viewConvention:'player',numberingRule:string|null}} orientation
 * @property {Mechanism[]} mechanisms
 * @property {NoteMapping[]} noteMappings
 * @property {Record<VerificationField,VerificationStatus>} verification
 * @property {Partial<Record<VerificationField,string[]>>} verificationEvidence
 * @property {Evidence[]} evidence
 * @property {string|null} defaultPositionId
 */
/** @typedef {{id:CategoryId,label:string,modelId:string,alias:boolean}} Category */
/**
 * @typedef {object} StudyState
 * @property {CategoryId|null} categoryId
 * @property {CategoryId|null} requestedCategoryId
 * @property {Model|null} model
 * @property {'idle'|'loading'|'ready'|'error'} loadState
 * @property {string|null} error
 * @property {string|null} positionId
 * @property {Breath} breath
 * @property {number} transparency
 * @property {Record<string,string>} mechanismState
 * @property {string} notice
 */

/** @type {ReadonlyArray<Category>} */
export const CATEGORIES = Object.freeze([
  {id:'diatonic', label:'다이아토닉', modelId:'compact-study', alias:false},
  {id:'chromatic', label:'크로매틱', modelId:'slide-study', alias:false},
  {id:'blues', label:'블루스', modelId:'compact-study', alias:true},
])

export const BREATHS = Object.freeze({
  blow: Object.freeze({label:'날숨 · 불기', description:'입에서 하모니카 쪽으로 숨을 내쉽니다.'}),
  draw: Object.freeze({label:'들숨 · 들이마시기', description:'하모니카를 통해 숨을 들이마십니다.'}),
})

const verificationFields = /** @type {const} */ (['geometry','noteMapping','notation','contactModel'])
const verificationStatuses = new Set(['unspecified','provisional','checked','conflict'])
const resultKinds = new Set(['unknown','unsupported','silent','pitches'])
const modelFamilies = new Map(CATEGORIES.filter(({alias}) => !alias).map(({id,modelId}) => [modelId,id]))
const isText = value => typeof value === 'string' && Boolean(value.trim())
const isId = value => isText(value) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isPositive = value => Number.isFinite(value) && value > 0
const isVec3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)
const sameVec3 = (value, expected) => isVec3(value) && value.every((component, index) => component === expected[index])

export function faceOpacity(percent) {
  const value = Number.isFinite(percent) ? percent : 0
  return 1 - Math.max(0, Math.min(100, value)) / 100
}

/** @param {unknown} model @param {string} [expectedId] @returns {Model} */
export function validateModel(model, expectedId) {
  check(isRecord(model), '모델 형식')
  const candidate = /** @type {Model} */ (model)
  const {id,title,family,fixture,geometry,orientation,verification,verificationEvidence} = candidate
  check(isId(id) && (!expectedId || id === expectedId), '모델 ID')
  check(isText(title) && ['diatonic','chromatic'].includes(family) && typeof fixture === 'boolean', '모델 정보')
  check(!modelFamilies.has(id) || modelFamilies.get(id) === family, '모델 종류')
  for (const field of /** @type {const} */ (['manufacturer','product','key','tuning'])) {
    check(candidate[field] === null || isText(candidate[field]), '제품 정보')
  }
  check(isRecord(geometry) && [geometry.width,geometry.height,geometry.depth].every(isPositive) &&
    Number.isFinite(geometry.mouthpieceZ) && typeof geometry.hasSlide === 'boolean' &&
    ['rounded','flat'].includes(geometry.cover) && geometry.unit === 'scene', '악기 형상')
  check(isRecord(orientation) && sameVec3(orientation.up, [0, 1, 0]) && sameVec3(orientation.mouthpieceNormal, [0, 0, 1]) &&
    orientation.viewConvention === 'player' && (orientation.numberingRule === null || isText(orientation.numberingRule)),
  '방향 기준')

  const holes = indexRecords(candidate.holes, '취구')
  for (const hole of holes.values()) {
    check(Number.isFinite(hole.x) && Number.isFinite(hole.y) && isPositive(hole.width) && isPositive(hole.height) &&
      Math.abs(hole.x) + hole.width / 2 <= geometry.width / 2 &&
      Math.abs(hole.y) + hole.height / 2 <= geometry.height / 2 &&
      ['rect','round'].includes(hole.shape), '취구 형상')
  }

  const positions = indexRecords(candidate.positions, '연주 위치')
  check(candidate.defaultPositionId === null || positions.has(candidate.defaultPositionId), '초기 연주 위치')
  for (const position of positions.values()) {
    check(isText(position.label) && isVec3(position.contact) &&
      Math.abs(position.contact[0]) <= geometry.width / 2 &&
      Math.abs(position.contact[1]) <= geometry.height / 2 &&
      Math.abs(position.contact[2] - geometry.mouthpieceZ) < 0.0001 &&
      Array.isArray(position.physicalHoleIds) && position.physicalHoleIds.length > 0 &&
      unique(position.physicalHoleIds) && position.physicalHoleIds.every(holeId => holes.has(holeId)), '연주 위치 참조')
  }

  const mechanisms = indexRecords(candidate.mechanisms, '기구')
  for (const mechanism of mechanisms.values()) {
    check(typeof mechanism.requiredForPitch === 'boolean' && Array.isArray(mechanism.states) &&
      mechanism.states.length > 0 && unique(mechanism.states) && mechanism.states.every(isId) &&
      (mechanism.defaultState === undefined || mechanism.states.includes(mechanism.defaultState)), '기구 상태')
  }
  const evidence = indexRecords(candidate.evidence, '근거')
  for (const item of evidence.values()) {
    check([item.title,item.source,item.locator,item.scope].every(isText) && isDate(item.checkedAt), '근거 정보')
  }
  check(isRecord(verification) && isRecord(verificationEvidence), '검증 상태')
  check(Object.keys(verificationEvidence).every(field => verificationFields.includes(field)), '검증 근거의 범위')
  for (const field of verificationFields) {
    check(verificationStatuses.has(verification[field]), '검증 상태')
    if (verification[field] === 'checked' || Object.hasOwn(verificationEvidence, field)) {
      validateEvidenceIds(verificationEvidence[field], evidence, verification[field] === 'checked')
    }
  }
  if (verification.noteMapping === 'checked') {
    check(!fixture && [candidate.manufacturer,candidate.product,candidate.key,candidate.tuning].every(isText), '검증된 음의 모델 식별 정보')
  }

  check(Array.isArray(candidate.noteMappings), '호흡별 음 결과')
  const mappingKeys = new Set()
  for (const entry of candidate.noteMappings) {
    check(isRecord(entry) && positions.has(entry.positionId) &&
      ['blow','draw'].includes(entry.breath) && isRecord(entry.mechanismState), '호흡별 음 결과 참조')
    const states = Object.entries(entry.mechanismState)
    check(states.every(([mechanism, value]) => mechanisms.get(mechanism)?.states.includes(value)), '음 결과의 기구 상태')
    const mappingKey = JSON.stringify([entry.positionId, entry.breath, states.sort(([a], [b]) => a.localeCompare(b))])
    check(!mappingKeys.has(mappingKey), '중복 음 결과')
    mappingKeys.add(mappingKey)
    const {result} = entry
    check(isRecord(result) && resultKinds.has(result.kind) && verificationStatuses.has(result.verificationStatus) &&
      (result.reason === undefined || isText(result.reason)), '음 결과 상태')
    validateEvidenceIds(result.evidenceIds, evidence, result.verificationStatus === 'checked')
    if (result.kind === 'pitches') {
      check(Array.isArray(result.pitches) && result.pitches.length > 0 && result.pitches.every(isPitch), '음명·옥타브')
      if (result.verificationStatus === 'checked') {
        check([...mechanisms.values()].every(({id,requiredForPitch}) =>
          !requiredForPitch || Object.hasOwn(entry.mechanismState, id)), '검증된 음의 필수 기구 상태')
      }
    } else {
      check(!Object.hasOwn(result, 'pitches'), '음 배열이 허용되지 않는 결과')
    }
  }
  return candidate
}

function check(condition, field) {
  if (!condition) throw new TypeError(`악기 데이터 오류: ${field}`)
}

/** @template {{id:string}} T @param {T[]} records @param {string} field @returns {Map<string,T>} */
function indexRecords(records, field) {
  check(Array.isArray(records), field)
  const index = new Map()
  for (const item of records) {
    check(isRecord(item) && isId(item.id) && !index.has(item.id), field)
    index.set(item.id, item)
  }
  return index
}

function validateEvidenceIds(ids, evidence, required) {
  check(Array.isArray(ids) && unique(ids) && (!required || ids.length > 0) &&
    ids.every(id => evidence.has(id)), '근거 참조')
}

function unique(list) {
  return new Set(list).size === list.length
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isPitch(pitch) {
  return isRecord(pitch) && typeof pitch.noteName === 'string' && /^[A-G]$/.test(pitch.noteName) &&
    Number.isInteger(pitch.octave) && pitch.octave >= -1 && pitch.octave <= 10 &&
    (pitch.accidental === undefined || ['#','b','##','bb'].includes(pitch.accidental))
}

/** @param {string} modelId @param {{signal?:AbortSignal}} [options] @returns {Promise<Model>} */
export async function loadModel(modelId, {signal} = {}) {
  check(modelFamilies.has(modelId), '지원 모델 ID')
  const response = await fetch(new URL(`./models/${modelId}.json`, import.meta.url), {signal})
  if (!response.ok) throw new Error('악기 파일을 불러올 수 없습니다.')
  return validateModel(await response.json(), modelId)
}

/** @param {Pick<StudyState,'model'|'positionId'>} state */
export function getPosition({model,positionId}) {
  return model?.positions.find(position => position.id === positionId) ?? null
}

const pending = reason => ({kind: /** @type {const} */ ('unknown'), reason})

/** @param {Pick<StudyState,'model'|'positionId'|'breath'|'mechanismState'> & {loadState?:StudyState['loadState']}} state */
export function getLearningResult(state) {
  if (state.loadState && state.loadState !== 'ready') return pending('현재 모델을 준비한 뒤 음 정보를 확인할 수 있습니다.')
  if (!getPosition(state) || !state.model) return pending('살펴볼 위치를 선택하세요.')
  if (state.breath === 'none') return pending('날숨 또는 들숨을 선택하세요.')

  const {model,positionId,breath,mechanismState} = state
  if (model.mechanisms.some(({id,requiredForPitch,states}) => requiredForPitch && !states.includes(mechanismState[id]))) {
    return pending(model.fixture ? '기구 상태와 호흡별 음 배열의 검증이 필요합니다.' : '이 모델의 음을 확인하려면 기구 상태를 먼저 설정해야 합니다.')
  }
  const activeStates = Object.entries(mechanismState)
  const mapping = model.noteMappings.find(entry => entry.positionId === positionId && entry.breath === breath &&
    Object.keys(entry.mechanismState).length === activeStates.length &&
    activeStates.every(([id,value]) => entry.mechanismState[id] === value))
  if (!mapping) return pending('이 위치의 음 정보가 아직 검증되지 않았습니다.')
  const {result} = mapping
  if (result.kind !== 'pitches') return result
  if (model.verification.noteMapping === 'conflict' || result.verificationStatus === 'conflict') {
    return pending('음 정보의 출처가 서로 달라 확인이 필요합니다.')
  }
  if (model.fixture || model.verification.noteMapping !== 'checked' || result.verificationStatus !== 'checked') {
    return pending('이 위치의 음 정보가 아직 검증되지 않았습니다.')
  }
  return result
}

/** @param {{load?:(modelId:string, options:{signal:AbortSignal})=>Promise<unknown>, onChange?:(state:StudyState)=>void}} [options] */
export function createStudy({load = loadModel, onChange = () => {}} = {}) {
  /** @type {StudyState} */
  let state = Object.freeze({
    categoryId:null, requestedCategoryId:null, model:null, loadState:'idle', error:null,
    positionId:null, breath:'none', transparency:60, mechanismState:Object.freeze({}), notice:'',
  })
  /** @type {AbortController|null} */
  let pendingRequest = null
  let disposed = false

  /** @param {Partial<StudyState>} updates */
  function commit(updates) {
    if (disposed) return
    state = Object.freeze({...state,...updates})
    onChange(state)
  }

  /** @param {CategoryId} categoryId */
  async function selectCategory(categoryId) {
    const category = CATEGORIES.find(candidate => candidate.id === categoryId)
    if (disposed || !category) return false

    pendingRequest?.abort()
    pendingRequest = null
    if (state.model?.id === category.modelId) {
      commit({categoryId, requestedCategoryId:categoryId, loadState:'ready', error:null,
        notice:category.alias ? '블루스는 이 다이아토닉 시제품의 별칭입니다.' : ''})
      return true
    }

    const request = new AbortController()
    pendingRequest = request
    commit({requestedCategoryId:categoryId, loadState:'loading', error:null, notice:''})

    let model
    try {
      model = validateModel(await load(category.modelId, {signal:request.signal}), category.modelId)
    } catch (error) {
      if (disposed || pendingRequest !== request) return false
      pendingRequest = null
      const detail = error instanceof TypeError && error.message.startsWith('악기 데이터 오류:') ?
        error.message : '악기 모델을 불러올 수 없습니다.'
      commit({loadState:'error', error:detail,
        notice:state.model ? '이전 모델을 표시 중입니다. 선택한 모델을 다시 불러올 수 있습니다.' : '모델을 다시 불러올 수 있습니다.'})
      return false
    }

    if (disposed || pendingRequest !== request) return false
    pendingRequest = null
    const firstModel = state.model === null
    const positionId = firstModel ? model.defaultPositionId : null
    const mechanismState = Object.freeze(Object.fromEntries(model.mechanisms
      .filter(mechanism => mechanism.defaultState !== undefined)
      .map(mechanism => [mechanism.id,mechanism.defaultState])))
    const notice = category.alias ? '블루스는 이 다이아토닉 시제품의 별칭입니다.' :
      firstModel ? '' : '모델이 바뀌었습니다. 새로 살펴볼 위치를 선택하세요.'
    commit({categoryId, requestedCategoryId:categoryId, model, loadState:'ready', error:null,
      positionId, breath:'none', mechanismState, notice})
    return true
  }

  return {
    getState: () => state,
    selectCategory,
    retry: async () => state.loadState === 'error' && state.requestedCategoryId !== null ?
      selectCategory(state.requestedCategoryId) : false,
    /** @param {string|null} positionId */
    selectPosition(positionId) {
      if (disposed || state.loadState !== 'ready' ||
        (positionId !== null && !state.model?.positions.some(position => position.id === positionId))) return false
      commit({positionId, breath:positionId ? state.breath : 'none', notice:''})
      return true
    },
    /** @param {Breath} breath */
    selectBreath(breath) {
      if (disposed || state.loadState !== 'ready' || !state.positionId || !['none','blow','draw'].includes(breath)) return false
      commit({breath})
      return true
    },
    setTransparency(percent) {
      if (disposed || !Number.isFinite(percent)) return false
      commit({transparency:Math.max(0, Math.min(100, percent))})
      return true
    },
    dispose() {
      disposed = true
      pendingRequest?.abort()
      pendingRequest = null
    },
  }
}
