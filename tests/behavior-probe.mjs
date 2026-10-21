// Behaviour tests for the plugin's logic — the parts a static checker cannot see.
//
// Run:  node tests/behavior-probe.mjs dynamic-backdrop/plugin.js
//
// These live in the repo on purpose. An earlier batch lived in a scratch directory, was
// deleted during cleanup, and the coverage had to be rebuilt from memory.
//
// The plugin is loaded with stubbed SDK/react modules and a fake DOM/clock, then exercised
// directly: profile mutations, save/apply separation, rotation advance, per-entry position.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = process.argv[2] || join(here, '..', 'dynamic-backdrop', 'plugin.js')
const stage = join(tmpdir(), `db-probe-${process.pid}`)
mkdirSync(stage, { recursive: true })

const raw = readFileSync(pluginPath, 'utf8')

const SDKS = `
export const host = { notify(){}, navigate(){} }
export const PALETTE_AREA = 'palette'
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const Button = 'Button'
export const ConfirmDialog = 'ConfirmDialog'
export const Input = 'Input'
export const Switch = 'Switch'
`
const REACT = `
export const jsx = (t, p) => ({ type: t, props: p })
export const jsxs = (t, p) => ({ type: t, props: p })
export const Fragment = 'Fragment'
export const useEffect = () => {}
export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}]
export const useRef = (v) => ({ current: v })
export const useMemo = (f) => f()
`
writeFileSync(join(stage, 'sdk.mjs'), SDKS)
writeFileSync(join(stage, 'react.mjs'), REACT)

const at = raw.lastIndexOf('export default {')
const close = raw.indexOf('\n}', at) + 2
const exports = `
export const __t = {
  get cfg(){return cfg}, get profiles(){return profiles}, get activeProfileId(){return activeProfileId},
  get previewId(){return previewId}, get runtime(){return runtime},
  DEFAULT_CONFIG, settingsOf, activeProfile, readConfig, saveConfig, saveProfileSettings,
  addProfile, renameProfile, deleteProfile, reorderProfiles, showProfile,
  applyShown, restoreEntry, createProfileNamed, renumber, nextProfileName, copyNameOf,
  unique, uniqueName, clampAlpha, rotationActive,
  rotationList, rotationEntryPath, rotationEntryPosition, seedRotation, startRotation,
  syncRotation, stopRotation, readRotationCursor, writeRotationCursor, writeLiveAt, clearLiveAt,
  readLiveAt, pickNextRotationPath, clearStoredSettings, classifyStoredKeys,
}
`
writeFileSync(
  join(stage, 'plugin.mjs'),
  (raw.slice(0, close) + exports + raw.slice(close))
    .replace("from '@hermes/plugin-sdk'", "from './sdk.mjs'")
    .replace("from 'react/jsx-runtime'", "from './react.mjs'")
    .replace("from 'react'", "from './react.mjs'"),
)

// ---- fake browser ------------------------------------------------------------
const store = new Map()
const timers = new Map()
let seq = 0
globalThis.setInterval = (fn, ms) => { seq += 1; timers.set(seq, { fn, ms }); return seq }
globalThis.clearInterval = (id) => timers.delete(id)
const realTimeout = globalThis.setTimeout.bind(globalThis)
globalThis.setTimeout = (fn) => { seq += 1; timers.set(seq, { fn, ms: 0 }); return seq }
globalThis.clearTimeout = (id) => timers.delete(id)
const fireShortTimers = () => {
  for (const [id, t] of [...timers.entries()]) {
    if (t.ms === 0) { timers.delete(id); t.fn() }
  }
}

const mkEl = (tag) => ({
  tagName: String(tag).toUpperCase(), id: '', attributes: {}, children: [], value: '',
  style: {
    setProperty(k, v) { this[k] = v },
    removeProperty(k) { delete this[k] },
    getPropertyValue(k) { return this[k] ?? '' },
  },
  classList: { add() {}, remove() {}, contains() { return false } },
  setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
  remove() {}, appendChild(c) { this.children.push(c); return c },
  prepend(c) { this.children.unshift(c); return c },
  addEventListener() {}, removeEventListener() {},
  play() { return Promise.resolve() }, pause() {},
  getBoundingClientRect() { return { width: 100, height: 32, top: 0, left: 0 } },
  querySelector() { return null }, querySelectorAll() { return [] },
  closest() { return null }, contains() { return false },
})
const newWindow = () => ({
  __dynamicBackdrop: null,
  addEventListener() {}, removeEventListener() {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  localStorage: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    get length() { return store.size },
    key: (i) => [...store.keys()][i],
  },
  innerWidth: 1440, innerHeight: 900,
  location: { pathname: '/x/index.html', hash: '#/other' },
})
globalThis.window = newWindow()
globalThis.document = {
  documentElement: mkEl('html'), head: mkEl('head'), body: mkEl('body'),
  createElement: mkEl, getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  createTextNode: (t) => ({ text: t }),
}
globalThis.getComputedStyle = globalThis.window.getComputedStyle
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
globalThis.requestAnimationFrame = () => 0
globalThis.fetch = async () => ({ ok: true, headers: { get: () => null } })

const NS = 'hermes.plugin.dynamic-backdrop.'
const ctx = {
  storage: {
    get: (k, d) => { const v = store.get(`${NS}${k}`); return v === undefined ? d : v },
    set: (k, v) => store.set(`${NS}${k}`, v),
    remove: (k) => store.delete(`${NS}${k}`),
  },
  register() {}, log() {}, notify() {},
}

const m = await import(join(stage, 'plugin.mjs'))
const T = m.__t
const D = T.DEFAULT_CONFIG

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}   [${JSON.stringify(detail)}]`) }
}
const settle = () => new Promise((r) => realTimeout(r, 30))

const FILES = ['/a.mp4', '/b.mp4', '/c.mp4']
// Wipes storage but KEEPS the playback cursor unless told otherwise: a restart is not a
// fresh install, and clearing the cursor made every "restart" look like it started over.
const seedProfiles = (settingsList, { keepCursor = true } = {}) => {
  const cursor = keepCursor ? store.get(`${NS}rotationCursor`) : undefined
  const live = keepCursor ? store.get(`${NS}rotationLiveAt`) : undefined
  store.clear()
  if (cursor !== undefined) store.set(`${NS}rotationCursor`, cursor)
  if (live !== undefined) store.set(`${NS}rotationLiveAt`, live)
  const profiles = settingsList.map((s, i) => ({
    id: `p${i + 1}`, name: `方案${i + 1}`, order: i,
    settings: { ...D, playMode: 'rotate', rotationPaths: FILES.map((p) => ({ path: p })), ...s },
  }))
  store.set(`${NS}profiles`, profiles)
  store.set(`${NS}activeProfileId`, profiles[0].id)
}

// ================= rotation: per-entry position =================
seedProfiles([{}])
m.default.register(ctx)
await settle()

check('entry 读字符串', T.rotationEntryPath('/x.mp4') === '/x.mp4')
check('entry 读对象', T.rotationEntryPath({ path: '/x.mp4', positionX: 40 }) === '/x.mp4')
check('entry 空值安全', T.rotationEntryPath(null) === '')
check('位置读对象', T.rotationEntryPosition({ path: '/x.mp4', positionX: 40 }, 25) === 40)
check('位置回退全局', T.rotationEntryPosition({ path: '/x.mp4' }, 25) === 25)
check('位置回退（字符串条目）', T.rotationEntryPosition('/x.mp4', 25) === 25)
check('位置钳制上限', T.rotationEntryPosition({ path: '/x.mp4', positionX: 150 }, 25) === 100)
check('位置钳制下限', T.rotationEntryPosition({ path: '/x.mp4', positionX: -5 }, 25) === 0)
check('列表取路径', T.rotationList().join(',') === '/a.mp4,/b.mp4,/c.mp4')

// ================= rotation: startup advance =================
//
// Two situations that must be told apart, and the fake browser has to model them
// explicitly or the tests contradict each other:
//   launch   — nothing is beating (the app was not running)      -> advance
//   sibling  — another window is beating right now               -> adopt, do not advance
const launch = async (extra = {}) => {
  seedProfiles([{ rotationOnStartup: true, ...extra }])
  T.clearLiveAt()
  globalThis.window = newWindow()
  m.default.register(ctx)
  await settle()
  return T.runtime.rotationPath
}
const siblingWindow = async () => {
  globalThis.window = newWindow()
  m.default.register(ctx)
  await settle()
  return T.runtime.rotationPath
}

const first = await launch()
check('首次启动 → a', first === '/a.mp4', first)

const sib = await siblingWindow()
check('兄弟窗口不推进 → a', sib === '/a.mp4', sib)

const second = await launch()
check('重启前进一格 → b', second === '/b.mp4', second)

const third = await launch()
check('再重启 → c', third === '/c.mp4', third)

const fourth = await launch()
check('顺序循环回到 a', fourth === '/a.mp4', fourth)

// A stale beat also counts as a launch: the app had been closed long enough.
seedProfiles([{ rotationOnStartup: true }])
store.set(`${NS}rotationLiveAt`, Date.now() - 60000)
globalThis.window = newWindow()
m.default.register(ctx)
await settle()
check('心跳过期算新启动', T.runtime.rotationPath !== '', T.runtime.rotationPath)

// shuffle must never re-pick the file already showing
let same = 0
for (let i = 0; i < 20; i += 1) {
  seedProfiles([{ rotationOnStartup: true, rotationShuffle: true }])
  store.set(`${NS}rotationCursor`, '/a.mp4')
  T.clearLiveAt()
  globalThis.window = newWindow()
  m.default.register(ctx)
  await settle()
  if (T.runtime.rotationPath === '/a.mp4') same += 1
}
check('随机启动不重复当前文件', same === 0, same)

// The cursor outranks a pinned start: a pin is a fixed point, so leading from it every
// launch would land on the same file forever.
seedProfiles([{ rotationOnStartup: true, rotationStartPath: '/a.mp4' }])
store.set(`${NS}rotationCursor`, '/b.mp4')
T.clearLiveAt()
globalThis.window = newWindow()
m.default.register(ctx)
await settle()
check('cursor 优先于 pin（b→c）', T.runtime.rotationPath === '/c.mp4', T.runtime.rotationPath)

// Interval mode installs a timer; startup mode must not.
seedProfiles([{ rotationIntervalMin: 2 }])
timers.clear()
T.clearLiveAt()
globalThis.window = newWindow()
m.default.register(ctx)
await settle()
check('间隔模式装 120s 定时器', [...timers.values()].some((t) => t.ms === 120000),
  [...timers.values()].map((t) => t.ms))

seedProfiles([{ rotationOnStartup: true }])
timers.clear()
T.clearLiveAt()
globalThis.window = newWindow()
m.default.register(ctx)
await settle()
check('启动模式不装定时器', ![...timers.values()].some((t) => t.ms >= 60000),
  [...timers.values()].map((t) => t.ms))

// ================= profiles =================
seedProfiles([{}, {}])
m.default.register(ctx)
await settle()
check('两个方案', T.profiles.length === 2, T.profiles.length)
check('当前方案 p1', T.activeProfileId === 'p1', T.activeProfileId)

const before = T.profiles.length
const dup = await T.addProfile(ctx, '方案1 复制', { afterId: T.activeProfileId })
await settle()
check('复制增一层', T.profiles.length === before + 1, T.profiles.length)
check('复制名带前缀', /方案1/.test(dup?.name || ''), dup && dup.name)

const renamed = await T.renameProfile(ctx, T.activeProfileId, '夜间')
check('重命名生效', T.profiles.find((p) => p.id === T.activeProfileId)?.name === '夜间')

const del = await T.deleteProfile(ctx, T.profiles[T.profiles.length - 1].id)
check('删除成功', del.ok === true, del)

// ================= save / apply separation =================
seedProfiles([{}, {}])
m.default.register(ctx)
await settle()
const p1 = T.activeProfileId
const p2 = T.profiles[1].id

const savedOpacity = 0.5
T.saveProfileSettings(ctx, p1, { ...D, opacity: savedOpacity })
check('保存写入记录', T.profiles.find((p) => p.id === p1).settings.opacity === savedOpacity)
check('保存不改 cfg', T.cfg.opacity !== savedOpacity || T.cfg.opacity === D.opacity,
  { cfg: T.cfg.opacity, saved: savedOpacity })
check('保存不改 active', T.activeProfileId === p1, T.activeProfileId)

await T.showProfile(ctx, p2)
check('切换只预览', T.activeProfileId === p1, T.activeProfileId)
check('预览改了 cfg', T.cfg.opacity === T.settingsOf(T.profiles.find((p) => p.id === p2)).opacity)

await T.restoreEntry({ id: p1, cfg: { ...D, opacity: savedOpacity } })
check('离开还原到入口方案', T.activeProfileId === p1)
check('离开还原 cfg', T.cfg.opacity === savedOpacity, T.cfg.opacity)

// ================= settings pruning =================
const pruned = T.settingsOf({ settings: { ...D, goneField: 1 } })
check('剪枝未知字段', !('goneField' in pruned), Object.keys(pruned))
check('保留已知字段', pruned.opacity === D.opacity)

// ================= cleanup key ownership =================
store.clear()
store.set(`${NS}profiles`, [])
store.set('hermes.plugin.other.profiles', 'keep')
store.set('hermes.plugin.dynamic-backdrop-extra.profiles', 'keep')
store.set('hermes.plugin.dynamic-backdrop.madeUpKey', 'keep')
const classified = T.classifyStoredKeys()
check('识别自己的键', classified.owned.length >= 1, classified.owned)
check('别家插件不动', classified.foreign.length >= 1, classified.foreign)

// ================= right-click must not unmount the position box =================
// The bug: the box's onBlur called commitPosition(), which cleared `posEdit` and unmounted
// the input — so when 粘贴 was chosen there was no editable left. Measured in the running
// app as commitPosition firing 0.5s after the box opened, on the right press itself.
//
// The guard is a time window, so it is tested through the plugin's own predicate rather
// than by faking a clock: whatever else changes, a blur inside a fresh menu gesture must
// not commit, and a blur outside it must.
const blurGuard = (raw.match(
  /onBlur: \(e\) => \{\n\s*if \(Date\.now\(\) - menuGestureAt < MENU_GESTURE_MS\) return\n\s*commitPosition/
) || [])[0]
check('位置框 blur 有菜单手势守卫', Boolean(blurGuard), blurGuard === undefined)
check('blur 仍会提交普通失焦', /commitPosition\(path, e\.currentTarget\.value\)/.test(raw))
// A right press anywhere is what opens a menu, so every right press must start the window.
check('右键按下开启手势窗口', /if \(e\.button === 2\) menuGestureAt = Date\.now\(\)/.test(raw))
// The value must not be silently dropped when the guard swallows the blur.
check('关闭浮层仍会结算位置', /settlePosition\(\)\n\s*setRotationOpen\(false\)/.test(raw))

// ================= removing unplayable files actually removes them =================
// The bug: `bad` is a Set of PATH STRINGS while `form.rotationPaths` holds OBJECTS
// ({ path, positionX }) since per-file positions landed. `!bad.has(entry)` was therefore
// always true, every row survived, and the toast still reported N files removed.
//
// This runs the real filter expression taken from the plugin source, so a future change
// to the entry shape fails here instead of silently doing nothing.
const filterSrc = (() => {
  const at = raw.indexOf('const kept = entries.filter(')
  if (at < 0) return ''
  const end = raw.indexOf('\n', at)
  return raw.slice(at, end)
})()
check('移除过滤器可提取', filterSrc.length > 0, filterSrc)

const runFilter = (entries, badPaths) => {
  const rotationEntryPath = (entry) => {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object' && typeof entry.path === 'string') return entry.path
    return ''
  }
  const bad = new Set(badPaths)
  // eslint-disable-next-line no-new-func
  return new Function('entries', 'bad', 'rotationEntryPath',
    `${filterSrc}; return kept`)(entries, bad, rotationEntryPath)
}

const KEEP = { path: '/m/keep.mp4', positionX: 60 }
const BAD1 = { path: '/m/bad1.mp4' }
const BAD2 = { path: '/m/bad2.mp4', positionX: 20 }

const removed = runFilter([KEEP, BAD1, BAD2], ['/m/bad1.mp4', '/m/bad2.mp4'])
check('坏文件被移除', removed.length === 1, removed)
check('留下的是好文件', removed[0] === KEEP)
check('留下的条目保留自己的 positionX', removed[0].positionX === 60)

const noneBad = runFilter([KEEP, BAD1], [])
check('没有坏文件时一个不动', noneBad.length === 2)

const allBad = runFilter([BAD1, BAD2], ['/m/bad1.mp4', '/m/bad2.mp4'])
check('全部坏文件时清空', allBad.length === 0, allBad)

// Old string entries (pre-v0.7 profiles) must still be matchable.
const legacy = runFilter(['/m/old.mp4', KEEP], ['/m/old.mp4'])
check('旧字符串条目也能匹配', legacy.length === 1 && legacy[0] === KEEP, legacy)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
