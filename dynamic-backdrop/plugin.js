import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'
import {
  host,
  Button,
  ConfirmDialog,
  Input,
  Switch,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
} from '@hermes/plugin-sdk'

const ID = 'dynamic-backdrop'
// Shown in the settings footer. The date is derived from the build slug so there
// is only one place to bump, and the slug itself stays available as a machine
// marker (data-build / tooltip) for telling which build the app is actually
// serving — the app can keep a previously loaded copy of a plugin, which is
// otherwise indistinguishable from a fixed one.
const VERSION = '1.0.0'
const BUILD = '2026-10-21-release'
const BUILD_DATE = BUILD.slice(0, 10)
// The Hermes build this release was hand-verified against. Recorded as a commit
// rather than a version because on disk the commit is the only identifier that is
// reliably present: the packaged Info.plist ships 0.0.0 and install-stamp.json
// carries displayVersion: null, so a version string simply cannot be read from the
// filesystem. A commit can also not be silently rebuilt in place. The readable
// version is kept alongside it for the UI.
const TESTED_HERMES = {
  version: '0.22.2',
  commit: 'd923a5eb',
  testedAt: '2026-10-17',
}
// Appended to the media URL so that replacing the file at the SAME path can take
// effect: a live <video> holds the media it loaded, and upsertMedia only reassigns
// src when the URL *string* changes. (The app's hermes-media:// handler is not the
// cause — it sends `Cache-Control: no-store` and re-stats per request.)
//
// It is kept in the shared store rather than derived per load, and that matters:
// a reload evaluates this module again without dissolving the previous instance, so
// a per-load value gave every leftover instance its own src and they rewrote the
// element every couple of seconds — an endless reload loop that the user sees as
// flicker. One persisted value means every instance computes the same URL, so
// leftovers are harmless and stopCycle() below has time to retire them.
//
// Empty by default: with no token the URL is the plain path, identical on every
// load, and the video is never re-read. A new value is minted only on demand —
// the "重新加载背景视频" palette command — which is the one moment a re-read is wanted.
const TOKEN_KEY = 'mediaToken'
// Where the last mousedown landed. HTML5 drag fires `dragstart` with the DRAGGABLE
// element as its target — not the child the pointer went down on — so checking
// `e.target.tagName` inside dragstart can never see an input that sits inside a
// draggable row. Recording the pointer's real target at mousedown is the only way to
// tell "started dragging from the text box" from "started dragging from the handle".
let rowDownTarget = null
const MEDIA_ID = 'dynamic-backdrop-media'
const STYLE_ID = 'dynamic-backdrop-style'
const MAIN_CLASS = 'dynamic-backdrop-main'
const SIDEBAR_CLASS = 'dynamic-backdrop-sidebar'
// NOTE: identifiers from the three earlier names (hermes-dynamic-backdrop,
// live-wallpaper, hermes-live-wallpaper) used to be listed here, to clear the
// remains of an older build after an in-place upgrade. Those builds are gone from
// every machine this ships to, so the lists were removed: they were unreachable
// code. The CURRENT name's identifiers below still matter, because upgrading from
// an earlier release of this same name is the ordinary case — a reload re-executes
// the module while the old DOM is still alive, and without clearing the current
// ids you would get two videos stacked and a stale stylesheet still applying.

// Which bundled video plays when the user has not picked one (mediaPath empty).
// A named constant rather than a literal because three places depend on the exact
// string: both branches of resolveDefaultPath() below, and the installer — if they
// disagree the wallpaper silently falls back to nothing, with no error anywhere.
const DEFAULT_MEDIA_FILE = 'Mornye-EP-Unwritten-in-the-Stars.mp4'

// Fresh-install and reset values. These are this user's tuned appearance, not the
// original prototype numbers: a reinstall or 清理配置 now lands on the look already
// in use instead of a washed-out placeholder that has to be re-dialled every time.
// Two of them are load-bearing beyond taste — sidebarAlpha 0.25 is the value the
// colour layering was designed around (higher and the video is buried), and
// positionX 25 is where the subject actually sits in the bundled clips.
const DEFAULT_CONFIG = {
  enabled: true,
  mediaPath: '',
  opacity: 0.25,
  positionX: 25,
  sidebarAlpha: 0.25,
  bubbleAlpha: 0.75,
  sidebarColor: '#9ea0db',
  textShadow: false,
  mediaToken: '',
  // ---- rotation ----
  // Two modes, mutually exclusive: one fixed file, or a list that rotates. `mediaPath`
  // stays meaningful in both so turning rotation off returns to the same single file.
  playMode: 'single',          // 'single' | 'rotate'
  rotationPaths: [],           // absolute paths, in play order
  rotationShuffle: false,      // pick the next one at random instead of in order
  // 「每次启动」replaces the interval: the list advances once per app launch and then
  // stays put. The interval field is disabled while this is on — a timer that never gets
  // to fire would just be a control that lies about its effect.
  rotationOnStartup: false,
  // The file the user picked by hand in the list. It is a STARTING POINT, not a mode:
  // loading the plugin (or applying the profile) begins there instead of at list[0].
  // Empty means "no pick" and the list decides.
  rotationStartPath: '',
  // How each entry may sit horizontally on its own. See rotationList() for the UI.
  rotationIntervalMin: 10,     // minutes between switches
  // Anything below one minute is not a rotation, it is a strobe. Enforced in the field,
  // in the save path and in the timer.
  // (Not a config key — declared here only so the constant lives beside its field.)
}

let cfg = { ...DEFAULT_CONFIG }
// Where the live instance parks its teardown hook. A reload creates a second
// module instance without dissolving the first, so the incoming one has to reach
// back and stop its predecessor; without that, every reload leaves another set of
// timers running.
const INSTANCE_KEY = '__dynamicBackdropInstance__'

// Set around an HTML5 drag of the profile rows. The 2s refresh tick skips itself while
// this is true, so a re-measure cannot land between the drop and the list re-render.
let dragInFlight = false

let runtime = {
  ctx: null,
  observer: null,
  refreshTimer: null,
  refreshInterval: null,
  rotationTimer: null,
  rotationPath: '',
  media: null,
  targets: new Set(),
  safeMode: false,
  result: null,
  defaultPath: '',
  migrated: false,
  customVars: [],
  // undefined = not asked yet; null = asked, app did not answer.
  hermesVersion: undefined,
}

const SELECTORS = {
  // Verified against the currently running packaged Hermes bundle's static assets.
  // The first selector is the thread viewport; the session-anchor is its stable shell.
  main: [
    '[data-slot="aui_thread-viewport"]',
    '[data-session-anchor="workspace"]',
    '[data-slot="workspace"]',
  ],
  sidebar: [
    '[data-slot="profile-rail"]',
    '[data-slot="sidebar-container"]',
    '[data-slot="sidebar"]',
  ],
}

// ---- profiles: the storage shape as of v0.4.0 ---------------------------------
//
// Before this, every setting was its own key (`opacity`, `sidebarAlpha`, …) which meant
// exactly one configuration could exist. Profiles need several, so the whole set is
// stored as one record.
//
// Two keys, both single records rather than one key per field:
//   profiles          array of { id, name, order, settings }
//   activeProfileId   which one is in effect
//
// `cfg` stays the single source of truth at runtime — it is the ACTIVE profile's
// settings, and nothing renders from anything else. The old flat keys are migrated once
// and then left in place, not deleted: if the migration is wrong the user's
// configuration is still recoverable from them, and the snapshot taken before shipping
// this build is the second safety net.
const PROFILES_KEY = 'profiles'
const ACTIVE_KEY = 'activeProfileId'
// Distinguishes the new record from a stale value of a different shape.
const PROFILES_SCHEMA = 1

let profiles = []
let activeProfileId = ''

const newProfileId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

// Fields dropped from DEFAULT_CONFIG in a later release must not survive in a profile
// record: showBadge was removed in v0.4.1, and a record written by v0.4.0 still carries
// it. Spreading the record last would keep the stale field forever and re-export it.
// Only keys that the current build knows are carried through.
const settingsOf = (profile) => {
  const merged = { ...DEFAULT_CONFIG }
  const stored = profile?.settings || {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (stored[key] !== undefined) merged[key] = stored[key]
  }
  return merged
}

function activeProfile() {
  return profiles.find((p) => p.id === activeProfileId) || profiles[0] || null
}

// Reads the whole store into `profiles` + `cfg`, migrating the flat keys on first run.
//
// Order matters: migration must be attempted BEFORE falling back to defaults, or an
// upgrading user silently loses their configuration and simply sees the default look
// with no error anywhere.
function readConfig(ctx) {
  let migrated = false
  try {
    const rawProfiles = ctx.storage.get(PROFILES_KEY, null)
    const rawActive = ctx.storage.get(ACTIVE_KEY, '')

    if (Array.isArray(rawProfiles) && rawProfiles.length > 0) {
      profiles = rawProfiles
      activeProfileId = typeof rawActive === 'string' && rawActive ? rawActive : rawProfiles[0].id
    } else {
      // First run on this shape: lift the flat keys into a single profile.
      const legacy = {}
      for (const name of LEGACY_SETTING_NAMES) legacy[name] = ctx.storage.get(name, DEFAULT_CONFIG[name])
      profiles = [{
        id: newProfileId(),
        name: '方案1',
        order: 0,
        settings: { ...DEFAULT_CONFIG, ...legacy },
      }]
      activeProfileId = profiles[0].id
      migrated = true
    }
  } catch {
    // A storage failure must not prevent the plugin from loading; fall back to a
    // single in-memory profile so the UI still works for this session.
    profiles = [{ id: newProfileId(), name: '方案1', order: 0, settings: { ...DEFAULT_CONFIG } }]
    activeProfileId = profiles[0].id
  }

  runtime.migrated = migrated
  cfg = settingsOf(activeProfile())
}

// Writes ONLY the two records. The flat legacy keys are deliberately untouched: they are
// the pre-v0.4.0 copy of the user's settings and the only rollback path if this shape
// turns out to be wrong.
// Persists the records as they are. It deliberately does NOT write `cfg` into the
// active profile any more: since 保存 and 应用 became separate actions, `cfg` is only
// what is being rendered, and copying it into a record here would silently turn every
// rename, delete or reorder into an implicit save.
function saveConfig(ctx) {
  try {
    ctx.storage.set(PROFILES_KEY, profiles)
    ctx.storage.set(ACTIVE_KEY, activeProfileId)
  } catch {
    // Swallowed on purpose: see readConfig's catch.
  }
}

// 保存: writes a draft into one profile's record. Nothing rendered changes, and the
// active profile does not change — that is 应用's job.
//
// `settingsOf` prunes fields this version no longer knows, so a record cannot accumulate
// leftovers from older releases.
function saveProfileSettings(ctx, id, settings) {
  const profile = profiles.find((p) => p.id === id)
  if (!profile) return false
  profile.settings = settingsOf({ settings })
  saveConfig(ctx)
  return true
}

// ---- committed vs shown -------------------------------------------------------
//
// profiles[].settings are the saved records; `cfg` is what is rendered right now.
// `activeProfileId` is the profile whose settings were last APPLIED — the one whose
// configuration the app is actually running.
//
// `previewId` is the profile the settings page is currently showing, when that differs
// from the applied one. It is memory only: browsing profiles must not rewrite the store,
// which is exactly what it used to do.
let previewId = ''

const shownProfile = () => (previewId
  ? profiles.find((p) => p.id === previewId) || activeProfile()
  : activeProfile())

const shownProfileId = () => previewId || activeProfileId

// 应用: make a profile the live one. This is the only path that changes what the app
// looks like once the page is closed.
async function applyShown(ctx, id, settings) {
  const profile = profiles.find((p) => p.id === id)
  if (!profile) return false
  // 应用 on a profile with unsaved edits also saves them: applying means "this is what I
  // want running", and a draft that was never written would be lost the moment it became
  // the active record.
  if (settings) profile.settings = settingsOf({ settings })
  activeProfileId = profile.id
  previewId = ''
  cfg = settingsOf(profile)
  saveConfig(ctx)
  runtime.safeMode = false
  if (!cfg.enabled) {
    cleanup()
    return true
  }
  await resolveDefaultPath()
  const result = runCompatibilityCheck({ notifyResult: true })
  if (result.level !== 'blocked') {
    // Rotation is part of the appearance: applying a profile with a different list or
    // interval has to restart the timer, not leave the previous one ticking.
    syncRotation()
    upsertMedia()
    observeLayout()
  }
  return true
}

// ---- profile operations -------------------------------------------------------
//
// Every mutation goes through here, re-numbers `order`, and writes once. Keeping the
// renumbering in one place is what stops the list drifting out of sequence after a
// delete: `order` is a stored field, so a gap left behind stays until something
// happens to rewrite it.
const NAME_MAX = 40

// Trimmed, length-capped, and compared case-insensitively so "Default" and "default"
// cannot coexist — to a human reading the list they are the same name.
const normalizeName = (raw) => String(raw ?? '').trim().slice(0, NAME_MAX)
const nameTaken = (name, exceptId) => profiles.some(
  (p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase(),
)

// Returns a name that is free: the requested one, or "name (2)", "name (3)"…
// Used by import when the file's profile name collides with an existing one.
function uniqueName(base) {
  const stem = normalizeName(base) || '导入的配置'
  if (!nameTaken(stem)) return stem
  for (let n = 2; n < 100; n += 1) {
    const candidate = normalizeName(`${stem} (${n})`)
    if (!nameTaken(candidate)) return candidate
  }
  return normalizeName(`${stem} (${Date.now().toString(36)})`)
}

// ---- automatic names -----------------------------------------------------------
//
// 另存为 names its profile 方案N; 复制 names its copy 「源名 复制」. Either way the name
// is fixed at creation and never changes afterwards. No 副本, no " (2)".
//
// An earlier version numbered them by position and renumbered on every mutation, so the
// numbers always matched the row order. That turned out to be the wrong trade: dragging a
// row rewrote the names of everything it passed, and a name that changes while you are
// looking at it is worse than a number that no longer matches its row. A name is an
// identity; the order is just the order.
//
// 另存为's number is one past the highest 方案N in use, not the list length. Reusing a
// freed number (say 方案2 after deleting it) would make a brand-new profile look like the
// one that was just removed.
// One minute is the floor everywhere: the field clamps, the save normalizes, and the
// timer refuses to run faster. A full day is the ceiling — beyond that "rotation" is just
// a static wallpaper and the value is almost certainly a typo.
const ROTATION_MIN_MINUTES = 1
const ROTATION_MAX_MINUTES = 1440

const AUTO_NAME = /^方案(\d+)$/

// 另存为's draft name: one past the highest 方案N in use.
//
// Not the list length: with 方案1 and 方案3 present, the length gives 方案3 — the number
// of the profile that was just deleted, which reads as if the delete was undone. Copy
// names never match AUTO_NAME, so they do not consume numbers.
function nextProfileName() {
  let highest = 0
  for (const p of profiles) {
    const m = AUTO_NAME.exec(p.name)
    if (m) highest = Math.max(highest, Number(m[1]))
  }
  return `方案${highest + 1}`
}

const COPY_SUFFIX = ' 复制'

// A copy is named 「源名 复制」. If that exact name is taken, a number is added:
// 「方案1 复制 2」, 「方案1 复制 3」.
//
// Why a number, when pure stacking (「复制 复制 复制」) was the previous rule:
// appending carries no information about *which* row was copied. With 方案1 /
// 方案1 复制 / 方案1 复制 复制 present, appending to any of them converges on the same
// string — 方案1 +复制+复制+复制 equals 方案1 复制 +复制+复制 — so three different clicks
// produced one indistinguishable name. The number is attached to the direct append
// only, which keeps the chains distinct: copies of 方案1 go 复制 / 复制 2 / 复制 3, while
// copies of 方案1 复制 go 复制 复制 / 复制 复制 2. Different shapes, no convergence.
function copyNameOf(name) {
  const base = normalizeName(`${normalizeName(name) || '方案'}${COPY_SUFFIX}`)
  if (!nameTaken(base)) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = normalizeName(`${base} ${n}`)
    if (!nameTaken(candidate)) return candidate
  }
  return normalizeName(`${base} ${Date.now().toString(36)}`)
}

function renumber() {
  profiles.forEach((p, i) => { p.order = i })
}

// 切换: shows another profile in the page. Writes nothing — not the active id, not the
// profile settings. The previous version committed on switch, so merely browsing the list
// changed the stored configuration.
//
// The page decides what to do with the outgoing draft (ask to save it, or drop it); this
// function only changes what is on screen.
async function showProfile(ctx, id) {
  const target = profiles.find((p) => p.id === id)
  if (!target) return false
  // Selecting the applied profile leaves preview mode; anything else enters it.
  previewId = id === activeProfileId ? '' : id
  cfg = settingsOf(target)
  await reapplyConfig()
  await resolveDefaultPath()
  return true
}

// Leaving the page: put the rendered configuration back to what it was on arrival,
// whatever the user previewed or saved in between. Records are untouched — a save is a
// save — but nothing that was not 应用'd stays on screen.
async function restoreEntry(entry) {
  previewId = ''
  if (entry && entry.id && profiles.some((p) => p.id === entry.id)) {
    activeProfileId = entry.id
    cfg = { ...DEFAULT_CONFIG, ...entry.cfg }
  } else {
    // The entry profile was deleted while the page was open; fall back to whatever is
    // currently applied rather than resurrecting settings that no longer belong to a row.
    cfg = settingsOf(activeProfile())
  }
  // Undoing a preview has to undo the FILE too, not just the settings around it. A file
  // picked by hand is a preview like any slider drag; leaving it playing would keep the
  // wallpaper on a file the store does not name.
  runtime.rotationPath = cfg.rotationStartPath && rotationList().includes(cfg.rotationStartPath)
    ? cfg.rotationStartPath
    : ''
  await reapplyConfig()
}

async function addProfile(ctx, rawName, { settings, copyOf, afterId } = {}) {
  const name = uniqueName(rawName)
  const profile = {
    id: newProfileId(),
    name,
    order: profiles.length,
    // A duplicate starts from the LIVE config, not from the stored one, so unsaved
    // tweaks on the page are what gets copied.
    settings: { ...DEFAULT_CONFIG, ...(copyOf ? settingsOf(copyOf) : (settings || cfg)) },
  }
  // A copy lands directly beneath its source. Names alone cannot always say which row
  // was copied, but position can: the new row appears right where the user clicked.
  const at = afterId ? profiles.findIndex((p) => p.id === afterId) : -1
  if (at >= 0) profiles.splice(at + 1, 0, profile)
  else profiles.push(profile)
  renumber()
  saveConfig(ctx)
  return profile
}

// Creates a profile with the exact name the user typed, refusing duplicates instead of
// silently suffixing them. Used by the 另存为 draft: the user sees the name they wrote in
// the field, so an automatic "(2)" would be a surprise — an error pill is the honest answer.
async function createProfileNamed(ctx, rawName, pending) {
  const name = normalizeName(rawName)
  if (!name) return { ok: false, reason: 'empty' }
  if (nameTaken(name)) return { ok: false, reason: 'duplicate' }
  const profile = {
    id: newProfileId(),
    name,
    order: profiles.length,
    settings: { ...DEFAULT_CONFIG, ...(pending || cfg) },
  }
  profiles.push(profile)
  renumber()
  saveConfig(ctx)
  return { ok: true, profile }
}

async function renameProfile(ctx, id, rawName) {
  const name = normalizeName(rawName)
  if (!name) return { ok: false, reason: 'empty' }
  if (nameTaken(name, id)) return { ok: false, reason: 'duplicate' }
  const profile = profiles.find((p) => p.id === id)
  if (!profile) return { ok: false, reason: 'missing' }
  profile.name = name
  saveConfig(ctx)
  return { ok: true, name }
}

async function deleteProfile(ctx, id) {
  // Refusing to delete the last one keeps the invariant "there is always an active
  // profile" true, which the rest of the code relies on.
  if (profiles.length <= 1) return { ok: false, reason: 'last' }
  const index = profiles.findIndex((p) => p.id === id)
  if (index < 0) return { ok: false, reason: 'missing' }
  const wasActive = profiles[index].id === activeProfileId
  profiles.splice(index, 1)
  renumber()
  if (wasActive) {
    const fallback = profiles[Math.min(index, profiles.length - 1)]
    activeProfileId = fallback.id
    cfg = settingsOf(fallback)
    saveConfig(ctx)
    await reapplyConfig()
  } else {
    saveConfig(ctx)
  }
  return { ok: true }
}

// Takes the full ordered id list rather than a from/to pair: the UI already knows the
// resulting order after a drop, and deriving it from indices makes an off-by-one in the
// drop handler silently reorder the wrong pair.
async function reorderProfiles(ctx, orderedIds) {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const next = []
  for (const id of orderedIds) {
    const profile = byId.get(id)
    if (profile) { next.push(profile); byId.delete(id) }
  }
  // Anything the caller omitted keeps its relative position at the end, so a stale id
  // list cannot delete a profile by accident.
  for (const leftover of byId.values()) next.push(leftover)
  profiles = next
  renumber()
  saveConfig(ctx)
  return profiles.map((p) => p.id)
}

// ---- the plugin's own stored settings ---------------------------------------
//
// How to tell this plugin's records apart from everything else in the store.
//
// The host builds the keys, not the plugin: it prefixes every setting with
// `hermes.plugin.<pluginId>.` and the plugin only ever supplies the bare setting
// name (see saveConfig/readConfig above). Two independent tests therefore have to
// pass before a key may be deleted:
//
//   1. the namespace — the segment between that fixed prefix and the next dot —
//      must equal this plugin's ID EXACTLY. A prefix test would be wrong here:
//      `dynamic-backdrop-extra` is a different plugin's namespace and starts with
//      the same characters.
//   2. the rest of the key must be one of the setting names this plugin actually
//      writes, i.e. a key of DEFAULT_CONFIG. This is the belt to the namespace's
//      braces — even if test 1 were somehow wrong, a name the plugin never writes
//      still cannot be deleted.
//
// Both tests are deliberately allow-list shaped: anything not positively identified
// as ours is left alone. Everything in this store is shared with the app itself and
// with every other plugin, so a false positive destroys someone else's settings.
const STORAGE_PREFIX = 'hermes.plugin.'
// The flat keys written by v0.3.x and earlier, in the order they were introduced.
// Frozen on purpose: this list describes the OLD shape, so it must not track
// DEFAULT_CONFIG — a field added later was never written as a flat key.
// Frozen at the v0.3.x flat-key set. This list exists to describe what might be sitting
// in storage from an old install, so it must NOT gain entries as the config grows — the
// four rotation keys were never written as flat keys and are not legacy anything.
const LEGACY_SETTING_NAMES = [
  'enabled', 'mediaPath', 'opacity', 'positionX', 'sidebarAlpha',
  'bubbleAlpha', 'sidebarColor', 'showBadge', 'textShadow', 'mediaToken',
]
// Every key this plugin may have written under its own namespace.
//
// `LEGACY_SETTING_NAMES` alone was wrong from v0.4.0 onwards: that release replaced the
// ten flat keys with two records (`profiles`, `activeProfileId`), so a cleanup that only
// looked for flat keys found nothing and deleted nothing — the dialog honestly reported
// "0 条记录" and the button was a no-op for four releases.
const CURRENT_RECORD_KEYS = ['profiles', 'activeProfileId']
// The last file the rotation actually showed. 「每次启动」advances FROM here, so without
// it every launch would restart at the first file — which is not a switch at all.
// It is deliberately NOT a config field: it is this machine's playback position, so it
// must not travel with an exported profile or make the settings look edited.
const ROTATION_CURSOR_KEY = 'rotationCursor'
// Kept only so 清理配置 still recognises the record older builds wrote. Nothing reads it
// any more: the heartbeat below replaced the timestamp scheme.
const ROTATION_ADVANCE_KEY = 'rotationAdvanceAt'
const ROTATION_ADVANCE_DEDUPE_MS = 15000
// Liveness heartbeat, written while any window of the app is running.
//
// Measured: `window` does NOT survive a Reload — the plugin document is recreated every
// time (new `performance.timeOrigin`, `window.__dynamicBackdrop` gone, a per-window counter
// always reads 1). So a flag on `window` can never tell a Reload from an app launch, and a
// plain timestamp cannot either: quitting and reopening within the dedupe window was
// indistinguishable from a sibling window, which is exactly how the switch kept failing.
//
// The heartbeat separates them: a window that starts while the previous document is still
// beating is a sibling of the same run; nothing beating means the app was not running.
const ROTATION_LIVE_KEY = 'rotationLiveAt'
// A sibling window registers seconds after the first and sees a beat well inside this.
const ROTATION_LIVE_STALE_MS = 8000
const ROTATION_HEARTBEAT_MS = 2000
const SETTING_NAMES = [
  ...CURRENT_RECORD_KEYS,
  ROTATION_CURSOR_KEY,
  ROTATION_ADVANCE_KEY,
  ROTATION_LIVE_KEY,
  ...LEGACY_SETTING_NAMES,
]

function classifyStoredKeys() {
  const owned = []
  const foreign = []
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i)
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue
      const rest = key.slice(STORAGE_PREFIX.length)
      const dot = rest.indexOf('.')
      if (dot < 0) { foreign.push(key); continue }
      const namespace = rest.slice(0, dot)
      const setting = rest.slice(dot + 1)
      if (namespace === ID && SETTING_NAMES.includes(setting)) owned.push(key)
      else foreign.push(key)
    }
  } catch {
    return { owned, foreign, unavailable: true }
  }
  return { owned, foreign, unavailable: false }
}

// Collect first, delete afterwards: removing entries while walking the store by
// index shifts the remaining ones and silently skips every second key.
function clearStoredSettings() {
  const { owned, foreign, unavailable } = classifyStoredKeys()
  if (unavailable) return { removed: [], foreignCount: 0, unavailable: true }
  const removed = []
  for (const key of owned) {
    try {
      window.localStorage.removeItem(key)
      removed.push(key)
    } catch {
      // A key that refuses to go is reported by its absence from `removed`.
    }
  }
  // The in-memory copy has to follow the deletion, or the running plugin keeps
  // rendering the values whose records were just removed — and its next save would write
  // them straight back.
  profiles = [{
    id: newProfileId(),
    name: '方案1',
    order: 0,
    settings: { ...DEFAULT_CONFIG },
  }]
  activeProfileId = profiles[0].id
  previewId = ''
  cfg = { ...DEFAULT_CONFIG }
  return { removed, foreignCount: foreign.length, unavailable: false }
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/')
}

function pathToFileUrl(value) {
  const normalized = normalizePath(value)
  if (!normalized) return ''
  const encoded = normalized.split('/').map((segment, index) => {
    if (index === 0 && /^[A-Za-z]:$/.test(segment)) return segment
    return encodeURIComponent(segment)
  }).join('/')
  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`
}

async function resolveDefaultPath() {
  if (runtime.defaultPath) return runtime.defaultPath
  try {
    const root = await window.hermesDesktop?.desktopPluginsRoot?.()
    if (root) {
      runtime.defaultPath = `${String(root).replace(/[\\/]+$/, '')}/dynamic-backdrop/${DEFAULT_MEDIA_FILE}`
    }
    if (!runtime.defaultPath && typeof import.meta?.url === 'string') {
      const moduleUrl = new URL(import.meta.url)
      if (moduleUrl.protocol === 'file:') {
        runtime.defaultPath = decodeURIComponent(moduleUrl.pathname).replace(/\/plugin\.js$/, `/${DEFAULT_MEDIA_FILE}`)
      }
    }
  } catch {
    // The user can still provide an explicit path.
  }
  return runtime.defaultPath
}

function unique(elements) {
  return [...new Set(elements)]
}

// This app routes with the HASH (`#/dynamic-backdrop-settings`); `pathname` stays at the
// index.html file path forever. Comparing pathname therefore returned false everywhere —
// harmless for the compatibility guard, fatal for anything that needs to know whether the
// settings page is on screen.
// The app's text-editing menu (剪切 / 复制 / 粘贴 / 全选) is NOT the OS menu: it is a
// Radix DropdownMenu, portalled directly onto <body> — measured as
//   div[data-slot="dropdown-menu-content"][role="menu"] < div < body
// So its items register as clicks OUTSIDE the overlay that owns the input, and picking
// 粘贴 closed the popover before the paste could land.
//
// The earlier guess was `[data-slot*="context-menu"]`, which matched 30 unrelated nodes
// elsewhere in the app and none of this menu. Verified selector, from the running app:
const MENU_SELECTOR = '[data-slot="dropdown-menu-content"], [data-slot="context-menu-content"]'

function insideAppMenu(target) {
  if (!target || typeof target.closest !== 'function') return false
  return Boolean(target.closest(MENU_SELECTOR))
}

// Whether the CURRENT pointer press landed on the app's text menu.
//
// This has to be recorded, not inspected later. Radix dismisses its menu on `pointerdown`
// in the capture phase; if it runs first the menu subtree is detached, the event target's
// parent chain is cut, and `closest()` on that target returns nothing — so by the time any
// handler of ours looks at `e.target` the answer is "not the menu", and we close the
// overlay the menu was about to act on.
//
// One document-level capture listener, registered at mount (before any menu exists), wins
// the ordering race and sees the target while it is still connected.
let pointerOnAppMenu = false

// When the current right-click gesture began, or 0.
//
// Right-clicking the position box opens the app's text menu, and Radix moves focus into
// that menu. The box's own `onBlur` then committed the value and cleared `posEdit`, which
// unmounted the input — so by the time 粘贴 was chosen there was no editable left to paste
// into. Measured: commitPosition(raw="22") fired on the right-click itself.
//
// A right press therefore marks a short window during which blur must NOT commit. The
// edit is not lost: every path that truly closes the overlay (click outside, open another
// row, Escape) already settles it, and Enter still commits by blurring.
let menuGestureAt = 0
const MENU_GESTURE_MS = 1500

const SETTINGS_ROUTE = '/dynamic-backdrop-settings'
function isOwnRoute() {
  if (typeof window === 'undefined') return false
  const { pathname, hash } = window.location || {}
  return String(hash || '').includes(SETTINGS_ROUTE)
    || String(pathname || '') === SETTINGS_ROUTE
}

// The HUD is a separate renderer window (`?win=hud`) that legitimately has no
// session sidebar and no chat viewport. Treating those as "missing layout" made
// it report a partial-compatibility warning on every load.
function isHudWindow() {
  if (typeof window === 'undefined') return false
  return /(?:^|[?&])win=hud(?:&|$)/.test(window.location?.search || '')
}

function findTargets() {
  const main = unique(SELECTORS.main.flatMap((selector) => [
    ...document.querySelectorAll(selector),
  ]))
  const sidebar = unique(SELECTORS.sidebar.flatMap((selector) => [
    ...document.querySelectorAll(selector),
  ]))

  // Conservative fallback for routes such as the new-session screen, where
  // Hermes has no chat viewport yet. This only classifies large layout regions;
  // it never writes inline styles or recursively clears child backgrounds.
  if ((main.length === 0 || sidebar.length === 0) && document.body) {
    const vw = window.innerWidth || 1
    const vh = window.innerHeight || 1
    for (const element of document.body.querySelectorAll('*')) {
      if (element.id === MEDIA_ID || element.id === STYLE_ID) continue
      const rect = element.getBoundingClientRect()
      if (rect.width >= vw * 0.5 && rect.height >= vh * 0.4) main.push(element)
      else if (rect.width >= vw * 0.08 && rect.width <= vw * 0.48 && rect.height >= vh * 0.55) sidebar.push(element)
    }
  }
  return { main: unique(main), sidebar: unique(sidebar) }
}

const STYLE_CSS = `
    html, body { background: transparent !important; }
    #root, #root > div, [data-app], [data-tauri] {
      background: transparent !important;
      position: relative;
      z-index: 1;
    }
    /* No container is painted, and no class is used to force anything
       transparent: the tint comes from the tokens below. Forcing backgrounds to
       transparent by class was actively harmful — on routes without a chat
       viewport the target heuristic also matched the app's own chrome shell,
       which flattened the base tint there and made that page a different
       colour from the session page. */

    /* The app paints its chrome twice: once on the shell via --ui-bg-chrome and
       again on the sidebar wrapper via bg-background. Left alone, the sidebar
       region gets a double layer and reads darker than everything else. */
    [data-slot="sidebar-wrapper"] { background-color: transparent !important; }

    /* Inverted surfaces: bg-foreground is a light panel whose label is coloured
       by .text-background, which resolves to the now-transparent
       --dt-background. Without this, hover tooltips and the solid round buttons
       render their text invisibly. Only the exact bg-foreground token matches
       here; bg-foreground/5 and hover:bg-foreground/90 are separate classes. */
    .bg-foreground { color: #0d1117 !important; }

    /* Tool cards — including the "file changed" panel. The app forces these to
       background:0 0, which is why they read as a bare outline and ignored every
       opacity setting. They get one layer here, driven by the bubble opacity.
       html:root raises specificity above the app's own [data-slot=tool-block]
       rule so this wins regardless of stylesheet order. */
    html:root [data-slot="tool-block"] {
      background-color: var(--hlw-bubble) !important;
      border-radius: 0.5rem !important;
    }

    /* The composer declares --composer-fill on its own element
       ([data-slot=composer-root]{--composer-fill:color-mix(...)}), which beats a
       value inherited from html:root no matter how the root rule is written.
       Overriding it at the same element is the only way to make the input box
       follow the bubble opacity like the other panels. */
    html:root [data-slot="composer-root"] {
      --composer-fill: var(--hlw-composer) !important;
    }

    /* xterm paints the terminal background itself (into its canvas), from the
       token set above. The surrounding CSS boxes carry the very same token via
       the app's own classes — the pane container, and .xterm-screen /
       .xterm-viewport through arbitrary-variant classes — so left alone they
       paint the identical colour a second and third time, which is what produced
       the visible banding. Every one of them is cleared here so the canvas is
       the single source of the terminal background. */
    html:root [class~="bg-(--ui-terminal-surface-background)"],
    html:root .xterm,
    html:root .xterm-viewport,
    html:root .xterm-screen,
    html:root .xterm-scrollable-element,
    html:root .xterm-canvas {
      background-color: transparent !important;
    }

    /* Optional text shadow, off by default and driven by the "文字阴影" setting.
       Scope matters more than the value here: a shadow only helps where text
       sits directly on the video. On a surface that already paints its own
       background it adds nothing and makes type look furry, so every such
       surface clears it again below.

       The two-layer recipe is the app's own (see [data-hud-shell]
       [data-slot=composer-bounds] in its stylesheet): a tight dark edge that
       acts like an outline, plus a soft wider halo that separates the glyph from
       busy detail behind it. text-shadow is inherited, which is what makes the
       body-wide declaration and the per-surface opt-outs work in this
       direction — an inherited value always loses to a direct declaration. */
    html:root[data-hlw-text-shadow="on"] body {
      text-shadow:
        0 1px 2px rgb(0 0 0 / 85%),
        0 0 6px rgb(0 0 0 / 50%);
    }

    /* Surfaces that provide their own contrast, plus code and form controls
       (the app clears the shadow on these too). Anything here is text over a
       solid-ish fill, where a shadow is pure noise. */
    html:root[data-hlw-text-shadow="on"] :is(
      pre,
      code,
      kbd,
      input,
      textarea,
      select,
      .xterm,
      .xterm *,
      .bg-foreground,
      [data-slot="tool-block"],
      [data-slot="composer-root"],
      [data-slot="popover-content"],
      [data-slot="dropdown-menu-content"],
      [data-slot="file-diff-panel"],
      [data-slot="aui_user-message-root"],
      .composer-human-message,
      [class~="bg-(--ui-terminal-surface-background)"]
    ) {
      text-shadow: none;
    }

    /* The tint lives in the app's own design tokens, never on containers.
       Painting the same colour on nested containers is what made regions differ
       (each level multiplies the alphas) and buried the video. One base layer
       covers the whole window; each content surface gets exactly one
       deliberate layer of its own, so how readable or how transparent a panel
       is cannot vary with how deeply the app happens to nest its divs.

       The selector is html:root, not :root: the app declares these same tokens
       in its own stylesheet, and a plain :root rule ties on specificity and
       then loses on document order. */
    html:root {
      --ui-bg-chrome: var(--hlw-base) !important;

      --sidebar: transparent !important;
      /* --dt-background is overloaded: it is the surface colour behind
         .bg-background (69 call sites) AND the text colour in .text-background
         (the tooltip label and the inverted round buttons). Surfaces must stay
         transparent for the video to show, so the text role is restored on the
         light .bg-foreground surfaces further down. */
      --dt-background: transparent !important;
      /* --dt-card is NOT overridden: the theme derives it from --ui-bg-editor,
         so it follows automatically. Forcing it transparent made chips that use
         color-mix(in srgb, var(--dt-card) 92%, transparent) — e.g. the
         "waking up" indicator — disappear entirely. */
      --dt-sidebar-bg: transparent !important;
      /* --ui-bg-editor feeds code cards and, through --dt-card, popover-ish
         chips. Both are small local surfaces that need to stay readable, and
         neither is a full-window layer, so this one gets a real fill. */
      --ui-bg-editor: var(--hlw-input) !important;
      --ui-bg-sidebar: transparent !important;
      --ui-bg-tertiary: transparent !important;
      --ui-surface-background: transparent !important;
      --ui-chat-surface-background: transparent !important;
      --ui-editor-surface-background: transparent !important;
      --ui-sidebar-surface-background: transparent !important;

      /* The terminal background is NOT painted by CSS — xterm draws it into a
         GPU canvas. The app reads this token and hands it to xterm as the
         terminal theme background (Uyt() in the app bundle), so this value IS
         the terminal colour. It must therefore be a real colour, not
         transparent: Uyt() falls back to xterm's own default when the token
         resolves to transparent, which is what made the terminal look like a
         foreign dark block. It points at the bubble colour so the terminal
         matches the bubbles in both hue and opacity. */
      --ui-terminal-surface-background: var(--hlw-bubble) !important;
      --ui-widget-surface-background: var(--hlw-bubble) !important;

      --ui-chat-bubble-background: var(--hlw-bubble) !important;
      --ui-chat-bubble-opaque-background: var(--hlw-bubble) !important;
      --dt-user-bubble: var(--hlw-bubble) !important;

      --dt-input: var(--hlw-input) !important;
      --ui-bg-input: var(--hlw-input) !important;

      --dt-popover: var(--hlw-popover) !important;
      --ui-bg-elevated: var(--hlw-popover) !important;

      --composer-fill: var(--hlw-composer) !important;

      /* The dark theme paints secondary/tertiary text as light grey at low
         opacity, which reads as washed-out mush once the surface behind it is
         tinted at all. Lifting the opacity keeps the same hue and hierarchy but
         makes the faintest labels legible (measured against the darkest surface
         this plugin can produce: 4.9:1 at worst, up from 1.7:1). */
      --ui-text-secondary: color-mix(in srgb, #e6edf3 84%, transparent) !important;
      --ui-text-tertiary: color-mix(in srgb, #e6edf3 70%, transparent) !important;

      --ui-row-hover-background: var(--hlw-hover) !important;
      --ui-row-active-background: var(--hlw-active) !important;
      --ui-row-open-background: var(--hlw-open) !important;
      --ui-control-hover-background: var(--hlw-hover) !important;
      --ui-control-active-background: var(--hlw-active) !important;
      --sidebar-accent: var(--hlw-active) !important;
    }

    /* The destructive action in the settings row (清理配置).
       It keeps the neighbours' shape, size and foreground colour — overriding
       variant or size made it read as a different class of control, which is what
       prompted the complaint — and is marked instead by leaning its surface warm
       plus a hairline border.
       Mixed from the theme's own tokens rather than a fixed colour: --dt-primary is
       the button's normal background under either theme, so 55% of the accent tints
       it in a way that works on light and dark alike. The label colour is untouched,
       so the contrast stays whatever the theme already guarantees (measured 8.3:1 on
       the light theme, where the untinted buttons are 13.3:1 — still well past the
       4.5:1 that 12px text needs). 55% rather than a light touch: at 18% the mix
       landed almost back on the pink surface and did not read as a different button. */
    [data-hlw-danger] {
      background-color: color-mix(in srgb, var(--ui-orange) 55%, var(--dt-primary)) !important;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-orange) 80%, transparent) !important;
    }
    [data-hlw-danger]:hover {
      background-color: color-mix(in srgb, var(--ui-orange) 72%, var(--dt-primary)) !important;
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-orange) 100%, transparent) !important;
    }
  `

function ensureStyle() {
  // Replace the sheet's contents when they are stale, instead of returning early
  // on an existing element: a plugin reload re-executes this module but leaves
  // the previous <style> element in the DOM, so an early return would keep the
  // old rules alive and the new CSS would never apply.
  const existing = document.getElementById(STYLE_ID)
  if (existing) {
    if (existing.textContent !== STYLE_CSS) existing.textContent = STYLE_CSS
    return
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_CSS
  document.head.appendChild(style)
}

function removeTargets() {
  for (const element of runtime.targets) {
    element.classList.remove(MAIN_CLASS, SIDEBAR_CLASS)
  }
  runtime.targets.clear()
}

function applyTargets(targets) {
  // Deliberately does NOT touch classes any more. Marking matched elements and
  // forcing their background transparent was the cause of routes looking
  // different: on pages with no chat viewport the heuristic also matched the
  // app's own chrome shell and flattened the base tint there. The tokens below
  // are the single source of colour now, and they are global.
  runtime.targets.clear()
  for (const element of targets.main) runtime.targets.add(element)
  for (const element of targets.sidebar) runtime.targets.add(element)

  const root = document.documentElement
  const color = cfg.sidebarColor || DEFAULT_CONFIG.sidebarColor
  const base = clampAlpha(cfg.sidebarAlpha)
  const surface = clampAlpha(cfg.bubbleAlpha)

  // The chosen colour contributes its HUE; its lightness is capped so text stays
  // readable on it (see capLuminance). Every surface below is this one colour at
  // a different alpha, which is what makes the panels match each other.
  const scrim = capLuminance(hexToRgb(color), SCRIM_LUMINANCE)

  // "气泡不透明度" now drives every content panel — bubbles, the composer, code
  // cards, the terminal, tool cards. Previously those were pinned to fixed
  // alphas, so the setting only reached some of them and panels looked
  // inconsistent next to each other. Floating layers (right-click menus,
  // dropdowns, tooltips) keep a floor because they sit over arbitrary content.
  const vars = {
    '--hlw-scrim': `rgb(${scrim[0]}, ${scrim[1]}, ${scrim[2]})`,
    '--hlw-base': rgbaOf(scrim, base),
    '--hlw-bubble': rgbaOf(scrim, surface),
    '--hlw-input': rgbaOf(scrim, surface),
    '--hlw-composer': rgbaOf(scrim, surface),
    '--hlw-terminal': rgbaOf(scrim, surface),
    '--hlw-popover': rgbaOf(scrim, Math.max(surface, 0.75)),
    '--hlw-hover': rgbaOf(scrim, clampAlpha(base + 0.08)),
    '--hlw-open': rgbaOf(scrim, clampAlpha(base + 0.06)),
    '--hlw-active': rgbaOf(scrim, clampAlpha(base + 0.16)),
  }
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value)
  runtime.customVars = Object.keys(vars)

  // Drives the optional text-shadow rules in the stylesheet. An attribute is used
  // rather than a custom property so the whole rule (and its opt-out list) can be
  // switched off in one place.
  root.setAttribute('data-hlw-text-shadow', cfg.textShadow ? 'on' : 'off')
}

function clampAlpha(value) {
  const number = Number(value)
  // Fall back to the configured default rather than a literal: a hardcoded number
  // here silently reintroduces the old look whenever a value fails to parse.
  if (!Number.isFinite(number)) return DEFAULT_CONFIG.sidebarAlpha
  return Math.min(1, Math.max(0.05, number))
}

// The window's whole colour scheme now comes from ONE derived colour: the user's
// hue, with its lightness capped into a dark band. The cap is the important part.
// Hermes' dark theme draws its text in light greys (#e6edf3), so any surface that
// text sits on has to stay dark. Deriving surfaces straight from the chosen
// colour only worked while that colour happened to be dark: pick a light one and
// high alphas made the surface light too, turning light-on-light into grey mush
// (measured contrast 1.1-1.9, i.e. unreadable). Capping the lightness keeps the
// user's hue but guarantees the text stays legible at every opacity.
function hexToRgb(value) {
  let hex = String(value || '').replace('#', '')
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const parts = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  // Same reasoning as clampAlpha: an unparseable colour must land on the configured
  // default, not on a colour copied from the prototype era.
  if (parts.some(Number.isNaN)) {
    const fallback = String(DEFAULT_CONFIG.sidebarColor).replace('#', '')
    return [0, 2, 4].map((i) => Number.parseInt(fallback.slice(i, i + 2), 16))
  }
  return parts
}

function luminance([r, g, b]) {
  const channel = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

// Scale the colour toward black until its luminance drops to the target. Black
// scaling keeps the r:g:b ratio, so the hue survives; only brightness changes.
function capLuminance(rgb, target) {
  if (luminance(rgb) <= target) return rgb
  let lo = 0
  let hi = 1
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2
    if (luminance(rgb.map((c) => c * mid)) > target) hi = mid
    else lo = mid
  }
  return rgb.map((c) => Math.round(c * lo))
}

// 0.06 was picked by measuring contrast at every alpha from 0.2 to 1.0: it is the
// lightest cap that keeps even the faintest grey label above 4.5:1.
const SCRIM_LUMINANCE = 0.06

function rgbaOf(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

function hexToRgba(value, alpha) {
  return rgbaOf(hexToRgb(value), alpha)
}

function removeMedia() {
  document.getElementById(MEDIA_ID)?.remove()
  runtime.media = null
}

// Stops everything that runs on a timer or observes the DOM, and nothing else.
// Split out of cleanup() so a freshly loaded instance can silence a previous one
// WITHOUT tearing down the shared DOM: reloading a plugin re-executes this module
// while the old module's intervals keep firing, and since each load has its own
// value, those orphaned intervals rewrite the media src with a different token
// every couple of seconds — which reloads the video and reads as flicker.
function stopCycle() {
  if (runtime.refreshTimer) clearTimeout(runtime.refreshTimer)
  runtime.refreshTimer = null
  if (runtime.refreshInterval) clearInterval(runtime.refreshInterval)
  runtime.refreshInterval = null
  runtime.heartbeatTimer = null
  // The heartbeat must stop with everything else, or a closed window keeps claiming to be
  // alive and the next launch is mistaken for a sibling.
  if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer)
  runtime.heartbeatTimer = null
  // Rotation is a plugin-level timer like the refresh tick: a reload must not leave the
  // old instance's timer running beside the new one, or the file advances twice as fast.
  stopRotation()
  runtime.observer?.disconnect()
  runtime.observer = null
}

function cleanup() {
  stopCycle()
  removeTargets()
  for (const name of runtime.customVars || []) {
    document.documentElement.style.removeProperty(name)
  }
  document.documentElement.removeAttribute('data-hlw-text-shadow')
  // The previous build's media element, stylesheet and badge. A hot reload
  // re-executes this module while the old DOM is still alive, so without this they
  // survive alongside the new ones — two videos stacked, and a stale stylesheet
  // still applying.
  document.getElementById(STYLE_ID)?.remove()
  removeMedia()
  runtime.safeMode = false
}

// The host decides how long a toast lives: success/info auto-close after 5 s, but
// `warning` and `error` default to 0 — they stay until dismissed. That is right for a
// standing problem ("update made this incompatible") and wrong for feedback on something
// the user just did, so those pass an explicit duration.
const TOAST_MS = 5000

function notify(kind, message, durationMs) {
  try {
    const payload = { kind, message }
    if (typeof durationMs === 'number') payload.durationMs = durationMs
    host.notify(payload)
  } catch {
    // Notifications are optional; the plugin must remain safe if unavailable.
  }
}

// ---- Hermes version drift -------------------------------------------------
//
// TESTED_HERMES records the build this release was verified against. The check
// below is ADVISORY: it never blocks loading and never disables the plugin. A
// version string is a poor proxy for compatibility — what actually decides whether
// the plugin still works is the app's compiled Tailwind classes and its CSS token
// names, which tests/validate-classes.mjs checks directly against the installed
// bundle. A patch bump that breaks neither, and a major bump that breaks
// everything, are indistinguishable from the version alone; refusing to run on a
// version mismatch would mostly mean refusing to run on a version that is fine.
//
// Patch-level differences are ignored on purpose — they are the common case and
// the least meaningful.
function hermesDrift(info) {
  if (!info) return null
  const commit = typeof info.commit === 'string'
    ? info.commit.slice(0, TESTED_HERMES.commit.length)
    : null
  if (commit && commit === TESTED_HERMES.commit) return null
  const running = info.appVersion || null
  if (!running) return { running: null }
  const [wantMajor, wantMinor] = TESTED_HERMES.version.split('.')
  const [gotMajor, gotMinor] = String(running).split('.')
  if (wantMajor === gotMajor && wantMinor === gotMinor) return null
  return { running }
}

// Read once and cache. Called from a render path, and the answer cannot change
// while the app is running. `undefined` distinguishes "not asked yet" from "asked
// and unavailable", so an app without getVersion is not asked repeatedly.
async function readHermesVersion() {
  if (runtime.hermesVersion !== undefined) return runtime.hermesVersion
  try {
    runtime.hermesVersion = (await window.hermesDesktop?.getVersion?.()) || null
  } catch {
    runtime.hermesVersion = null
  }
  return runtime.hermesVersion
}

// One formatter for both the settings page and the palette command, so the two can
// never disagree about what the check found. Every string is single-line on purpose:
// the host collapses whitespace in a notification, and the settings row has no room
// to wrap.
function describeCompat(result, info) {
  const drift = hermesDrift(info)
  const version = info?.appVersion || '未知'
  const layout = `主 ${result.main} / 侧栏 ${result.sidebar}`
  if (result.level === 'blocked') {
    return {
      cls: 'text-destructive',
      kind: 'warning',
      short: `✗ 不兼容 · ${layout}`,
      long: `灵动舞台不兼容当前 Hermes，已恢复原有界面样式 · Hermes ${version} · 布局 ${layout}`,
    }
  }
  if (result.level === 'partial') {
    return {
      cls: 'text-amber-600',
      kind: 'warning',
      short: `⚠️ 部分兼容 · ${layout}`,
      long: `灵动舞台部分兼容，部分透明效果已关闭 · Hermes ${version} · 布局 ${layout}`,
    }
  }
  if (drift) {
    return {
      cls: 'text-amber-600',
      kind: 'warning',
      short: `⚠️ 未验证 · Hermes ${version}`,
      long: `灵动舞台可用，但未在当前 Hermes 版本上验证过 · Hermes ${version}（本插件适配 ${TESTED_HERMES.version}） · 布局 ${layout} · 外观若无异常可继续使用`,
    }
  }
  return {
    cls: 'text-emerald-600',
    kind: 'success',
    short: `✓ 兼容 · Hermes ${version} · ${layout}`,
    long: `灵动舞台兼容性检查通过 · Hermes ${version}（已适配） · 布局 ${layout}`,
  }
}

function runCompatibilityCheck({ notifyResult = false } = {}) {
  if (!document.body) return { level: 'blocked', main: 0, sidebar: 0 }

  // The plugin's own settings page replaces the chat viewport. Do not treat
  // that route as a Hermes incompatibility or clean up a working background.
  if (isOwnRoute() && runtime.result) {
    return runtime.result
  }

  // The HUD has no session sidebar or chat viewport by design; there is nothing
  // to classify there, and the token rules do all the work.
  const hud = isHudWindow()
  const targets = hud ? { main: [], sidebar: [] } : findTargets()
  const shell = document.body
  const result = {
    // The Desktop can show a new-session or plugin route without the chat
    // viewport. The document body is still a valid host for the media layer;
    // missing chat/sidebar targets only limits transparency refinements.
    level: hud || (targets.main.length > 0 && targets.sidebar.length > 0)
      ? 'compatible'
      : 'partial',
    main: targets.main.length,
    sidebar: targets.sidebar.length,
  }
  runtime.result = result

  if (result.level === 'blocked') {
    cleanup()
    runtime.safeMode = true
    notify('warning', 'Hermes 更新后灵动舞台插件暂不兼容，已恢复原有界面样式。')
    return result
  }

  if (!cfg.enabled) {
    cleanup()
    return result
  }

  ensureStyle()
  applyTargets(targets)

  if (result.level === 'partial' && notifyResult) {
    notify('warning', '灵动舞台已启用，但当前 Hermes 布局存在部分兼容性问题。')
  }
  return result
}

async function refreshPlugin() {
  await resolveDefaultPath()
  const result = runCompatibilityCheck()
  if (result.level !== 'blocked') upsertMedia()
}

function scheduleRefresh() {
  if (runtime.refreshTimer) return
  runtime.refreshTimer = setTimeout(() => {
    runtime.refreshTimer = null
    refreshPlugin().catch(() => {})
  }, 250)
}

function observeLayout() {
  runtime.observer?.disconnect()
  if (!document.body) return
  runtime.observer = new MutationObserver(scheduleRefresh)
  runtime.observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-state'],
  })
}

// ---- rotation -----------------------------------------------------------------
//
// The rotation cursor lives in `runtime`, never in storage. Writing the current file to
// storage every interval would mean a localStorage write every few minutes for the rest
// of the session — and it would make the config look "edited" while the user is not
// touching it, which the dirty check would then report.
//
// `cfg.mediaPath` keeps its meaning: the single file, used when play mode is 'single'.
// The rotating file is `runtime.rotationPath`, and upsertMedia() prefers it when
// rotation is on. That way turning rotation off restores the configured single file
// without having had to remember anything.

// An entry is `{ path, positionX? }`. Records written before per-file positions existed
// hold bare strings, and they stay readable: nothing is lost by tolerating both, and a
// migration pass over storage could fail halfway for no benefit.
const rotationEntryPath = (entry) => {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.path === 'string') return entry.path
  return ''
}

// The horizontal position for one entry. `fallback` is the profile-wide value, which is
// what an entry without its own setting should follow.
const rotationEntryPosition = (entry, fallback) => {
  if (entry && typeof entry === 'object') {
    const n = Number(entry.positionX)
    if (entry.positionX !== undefined && Number.isFinite(n)) return Math.min(100, Math.max(0, n))
  }
  return fallback
}

// Playback logic wants paths, in order. Everything that walks the list during playback
// goes through this, so the entry shape stays a storage/UI concern.
const rotationList = () => (Array.isArray(cfg.rotationPaths)
  ? cfg.rotationPaths.map(rotationEntryPath).filter(Boolean)
  : [])

// Only files the browser can actually try to decode. The list is user-supplied, and a
// typo would otherwise sit there as a black wallpaper with no explanation.
const PLAYABLE_EXT = /\.(mp4|webm|mov|m4v|png|jpe?g|webp|gif)$/i
const isPlayable = (pathText) => typeof pathText === 'string' && PLAYABLE_EXT.test(pathText)

// ---- playability check -----------------------------------------------------------
//
// A path that exists but cannot be decoded is the worst case for a wallpaper: no error,
// no fallback, just a black screen. `isPlayable` only looks at the extension, which
// catches typos but not a .mp4 encoded with a codec this build cannot decode.
//
// The check below actually loads each file into a detached element and waits for
// metadata. It is deliberately sequential and time-boxed: N files × 4s worst case, and
// one broken file must not block the rest.

const PROBE_TIMEOUT_MS = 4000

function probeOne(pathText) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok, reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      element.remove?.()
      resolve({ path: pathText, ok, reason })
    }
    const timer = setTimeout(() => done(false, '超时'), PROBE_TIMEOUT_MS)
    let element
    try {
      const isImage = /\.(png|jpe?g|webp|gif)$/i.test(pathText)
      element = document.createElement(isImage ? 'img' : 'video')
      element.muted = true
      element.preload = 'metadata'
      if (!isImage) {
        element.playsInline = true
        // NO crossOrigin here. Setting it makes the request CORS-checked, and the
        // hermes-media:// handler sends no CORS headers — every file then fails with
        // MEDIA_ELEMENT_ERROR code 4 (Format error). Verified in the running app: with
        // crossOrigin='anonymous' both real files fail; without it both load with the
        // correct duration. The playback path never set it either, which is exactly why
        // real playback worked while this check did not.
      }
      element.addEventListener('loadedmetadata', () => {
        // For video, also require a real duration: an element that "loads" without a
        // duration is a container the decoder could not make sense of.
        if (!isImage && !(element.duration > 0)) { done(false, '无法解码'); return }
        done(true, '')
      })
      element.addEventListener('error', () => done(false, '无法解码'))
      element.src = isImage
        ? pathToFileUrl(pathText)
        : `hermes-media://stream/${encodeURIComponent(normalizePath(pathText))}`
      // Some builds never fire either event for a missing file.
      if (typeof element.load === 'function') element.load()
    } catch (e) {
      done(false, e && e.message ? e.message : '加载失败')
    }
  })
}

// Sequential on purpose: loading a dozen 4K files at once would stall the renderer for
// the duration of the check.
async function probeRotationPaths(paths) {
  const results = []
  for (const p of paths) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await probeOne(p))
  }
  return results
}

function rotationActive() {
  return cfg.enabled && cfg.playMode === 'rotate' && rotationList().length > 0
}

// Picks the next file. In shuffle mode it re-rolls until it differs from the current one,
// so a short list does not look frozen; ordered mode just advances by one and wraps.
function pickNextRotationPath(previous) {
  const list = rotationList()
  if (!list.length) return ''
  if (!cfg.rotationShuffle) {
    const at = list.indexOf(previous)
    return list[(at + 1) % list.length]
  }
  if (list.length === 1) return list[0]
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = list[Math.floor(Math.random() * list.length)]
    if (candidate !== previous) return candidate
  }
  // Twenty identical rolls on a two-item list is unlikely but not impossible.
  return list[(list.indexOf(previous) + 1) % list.length]
}

// The last file shown, remembered across launches. Read lazily because register() may not
// have handed us a ctx yet when the module is first evaluated.
function readRotationCursor() {
  try {
    const raw = runtime.ctx?.storage?.get(ROTATION_CURSOR_KEY, '')
    if (typeof raw !== 'string' || !raw) return ''
    // The storage bridge may hand back the raw JSON rather than the value: one build
    // returns '"/a.mp4"' where another returns '/a.mp4'. A quoted string then matches no
    // entry in the list, the cursor is discarded, and 「每次启动」restarts at the first
    // file every time — which looks exactly like the feature not working.
    const trimmed = raw.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const decoded = JSON.parse(trimmed)
        if (typeof decoded === 'string') return decoded
      } catch {
        return trimmed.slice(1, -1)
      }
    }
    return raw
  } catch {
    return ''
  }
}

function writeRotationCursor(path) {
  try {
    runtime.ctx?.storage?.set(ROTATION_CURSOR_KEY, path || '')
  } catch {
    // A failed write only costs the next launch its starting point.
  }
}

function readLiveAt() {
  try {
    const n = Number(runtime.ctx?.storage?.get(ROTATION_LIVE_KEY, 0))
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function writeLiveAt(ms = Date.now()) {
  try {
    runtime.ctx?.storage?.set(ROTATION_LIVE_KEY, ms)
  } catch {
    // A failed beat only costs the next window its ability to recognise a sibling.
  }
}

function clearLiveAt() {
  try {
    runtime.ctx?.storage?.remove?.(ROTATION_LIVE_KEY)
  } catch {
    // Leaving a stale beat behind can only skip one launch; the staleness window caps it.
  }
}

// Runs for the life of the document. Stopped by stopCycle() along with everything else.
function startHeartbeat() {
  if (runtime.heartbeatTimer) clearInterval(runtime.heartbeatTimer)
  writeLiveAt()
  runtime.heartbeatTimer = setInterval(() => writeLiveAt(), ROTATION_HEARTBEAT_MS)
  // Quitting clears the beat immediately instead of waiting for it to go stale, so a fast
  // quit-and-reopen is still recognised as a new run rather than a sibling window.
  try {
    window.addEventListener('pagehide', clearLiveAt)
    window.addEventListener('beforeunload', clearLiveAt)
  } catch { /* a window without those events cannot happen, but must not break startup */ }
}

// Seeds the cursor when rotation is (re)started. Called on load and after a save, so the
// first file shown is the configured one rather than whatever was last displayed.
//
// Three inputs, in this order:
//   1. a file the user picked by hand (rotationStartPath) — explicit, so it wins;
//   2. 「每次启动」 — advance one step from the position remembered last launch, which is
//      what makes it a switch rather than "always the first file";
//   3. otherwise the list decides: first entry, or a random one.
function seedRotation() {
  if (!rotationActive()) {
    runtime.rotationPath = ''
    return ''
  }
  const list = rotationList()
  if (!list.length) {
    runtime.rotationPath = ''
    return ''
  }
  const pinned = cfg.rotationStartPath && list.includes(cfg.rotationStartPath)
    ? cfg.rotationStartPath
    : ''

  if (cfg.rotationOnStartup) {
    // Sibling windows of the same run must not each step the list: with two files, two
    // steps land back where it started. A window that starts while another is still
    // beating is a sibling; nothing beating means the app was not running.
    const live = readLiveAt()
    const sibling = live > 0 && Date.now() - live < ROTATION_LIVE_STALE_MS
    if (sibling) {
      const current = readRotationCursor()
      runtime.rotationPath = current && list.includes(current) ? current : list[0]
      return runtime.rotationPath
    }

    // Where to step from: what played last time, or the pinned entry on a first run.
    const prev = [readRotationCursor(), pinned].find((c) => c && list.includes(c)) || ''
    const from = prev ? list.indexOf(prev) : -1
    if (cfg.rotationShuffle) {
      // "换一个" has to CHANGE: picking uniformly would land on the current file a third
      // of the time, which reads as the switch not working.
      const others = list.filter((entry) => entry !== prev)
      const pool = others.length ? others : list
      runtime.rotationPath = pool[Math.floor(Math.random() * pool.length)]
    } else {
      runtime.rotationPath = from < 0 ? list[0] : list[(from + 1) % list.length]
    }
    writeRotationCursor(runtime.rotationPath)
    return runtime.rotationPath
  }

  runtime.rotationPath = pinned || (cfg.rotationShuffle
    ? list[Math.floor(Math.random() * list.length)]
    : list[0])
  return runtime.rotationPath
}

function stopRotation() {
  if (runtime.rotationTimer) clearInterval(runtime.rotationTimer)
  runtime.rotationTimer = null
}

function startRotation() {
  stopRotation()
  if (!rotationActive()) {
    runtime.rotationPath = ''
    return
  }
  if (!runtime.rotationPath) seedRotation()
  // 「每次启动」means exactly that: one advance per launch, then hold. Installing a timer
  // here would keep switching during the session, which is the other mode.
  if (cfg.rotationOnStartup) return
  // One rule for an unusable interval: fall back to the default. Half-applied clamping
  // (`max(1, n || default)`) treated 0 and -5 differently — 0 became the default while
  // -5 became one minute — which is the kind of rule nobody can predict from the UI.
  const raw = Number(cfg.rotationIntervalMin)
  const minutes = Number.isFinite(raw) && Math.floor(raw) >= ROTATION_MIN_MINUTES
    ? Math.min(ROTATION_MAX_MINUTES, Math.floor(raw))
    : DEFAULT_CONFIG.rotationIntervalMin
  runtime.rotationTimer = setInterval(() => {
    if (!rotationActive()) return
    runtime.rotationPath = pickNextRotationPath(runtime.rotationPath)
    // The stored cursor is only refreshed at launch and on a manual pick. Writing it on
    // every tick would mean a localStorage write every few minutes for no benefit: its
    // one job is to decide where the NEXT launch starts.
    // Straight to the media element. Going through refreshPlugin() would re-measure the
    // whole layout and return a promise, for a change that only swaps one <video> src.
    upsertMedia()
  }, minutes * 60 * 1000)
}

// Restarts the timer with the current config. Every path that can change the mode, the
// list or the interval must call this, or the old interval keeps running against the new
// settings.
function syncRotation() {
  if (!rotationActive()) {
    stopRotation()
    runtime.rotationPath = ''
    return
  }
  if (!runtime.rotationPath || !rotationList().includes(runtime.rotationPath)) {
    seedRotation()
  }
  startRotation()
}

function upsertMedia() {
  if (!cfg.enabled || runtime.safeMode) {
    removeMedia()
    return
  }
  // Rotation wins over the single file while it is active. Falling back keeps the
  // wallpaper on something if the list is emptied mid-session.
  const rotated = rotationActive() ? runtime.rotationPath : ''
  const mediaPath = rotated || cfg.mediaPath || runtime.defaultPath
  if (!mediaPath) return
  const isImage = /\.(png|jpe?g)$/i.test(mediaPath)
  const wantedTag = isImage ? 'IMG' : 'VIDEO'
  const hostElement = document.body
  let element = document.getElementById(MEDIA_ID)
  if (element && element.tagName !== wantedTag) {
    element.remove()
    element = null
  }
  if (!element) {
    element = document.createElement(wantedTag)
    element.id = MEDIA_ID
    Object.assign(element.style, {
      position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      objectFit: 'cover', pointerEvents: 'none', zIndex: '0', border: '0',
      margin: '0',
    })
    if (wantedTag === 'VIDEO') {
      element.autoplay = true
      element.loop = true
      element.muted = true
      element.playsInline = true
      element.preload = 'auto'
    }
    document.body.appendChild(element)
  }
  if (element.parentElement !== hostElement) hostElement.prepend(element)
  Object.assign(element.style, {
    position: 'fixed', inset: '0', width: '100vw', height: '100vh',
  })
  // The query is only added when a token exists, so the default URL is stable across
  // loads and the element is left alone. Both forms accept it: `hermes-media://`
  // resolves the path from the URL and ignores the query, and for `file://` the
  // query is not part of the filesystem path (images have to use file:// because the
  // app's media protocol defines no image MIME types).
  const suffix = cfg.mediaToken ? `?v=${cfg.mediaToken}` : ''
  const source = isImage
    ? `${pathToFileUrl(mediaPath)}${suffix}`
    : `hermes-media://stream/${encodeURIComponent(normalizePath(mediaPath))}${suffix}`
  if (element.getAttribute('src') !== source) element.src = source
  element.style.opacity = String(cfg.opacity)
  // A rotating file may carry its own horizontal position; without one it follows the
  // profile value. Looked up by path because the cursor only ever stores a path.
  const activeEntry = rotationActive()
    ? (Array.isArray(cfg.rotationPaths) ? cfg.rotationPaths : [])
      .find((entry) => rotationEntryPath(entry) === mediaPath)
    : null
  const positionX = rotationEntryPosition(activeEntry, cfg.positionX)
  element.style.objectPosition = `${positionX}% 50%`
  if (wantedTag === 'VIDEO' && element.paused) element.play?.().catch?.(() => {})
  runtime.media = element
}

// Pushes the in-memory config back onto the page WITHOUT writing it to storage.
// Needed after the stored records have been deleted: the defaults must take effect
// now, but going through applyConfig would immediately re-create the very keys that
// were just cleared, leaving the store looking untouched.
//
// It deliberately does NOT call runCompatibilityCheck. That function returns early
// on the plugin's own settings route whenever a result is already cached — a guard
// that exists so visiting the settings page cannot be mistaken for a Hermes
// incompatibility — and the early return skips the styling pipeline entirely. Since
// the cleanup button can only be pressed from that very route, routing through it
// meant the colours were never re-applied: the form showed the defaults while the
// page kept the old tint. The visual work is therefore done directly here, which is
// the same three steps runCompatibilityCheck ends with.
// Renders a candidate configuration WITHOUT touching storage or `cfg`... except it does
// update `cfg`, and that is deliberate: the 2s refresh interval calls upsertMedia(),
// which re-reads `cfg` and rewrites the element's style. If a preview only painted the
// DOM, the refresh would revert it within two seconds and the slider would appear to
// snap back mid-drag.
//
// So preview writes `cfg` (the live value everything renders from) and skips
// `saveConfig`. Leaving the page without 应用 restores `cfg` from the entry snapshot,
// which is what restoreEntry() does.
function previewConfig(next) {
  cfg = { ...cfg, ...next }
  if (!cfg.enabled) { removeMedia(); return }
  applyTargets(isHudWindow() ? { main: [], sidebar: [] } : findTargets())
  upsertMedia()
}

async function reapplyConfig() {
  runtime.safeMode = false
  if (!cfg.enabled) {
    cleanup()
    return
  }
  await resolveDefaultPath()
  ensureStyle()
  applyTargets(isHudWindow() ? { main: [], sidebar: [] } : findTargets())
  syncRotation()
  // The media element is NOT styled by applyTargets: its path, opacity and
  // object-position live only in upsertMedia(). Leaving this out meant switching profiles
  // repainted every panel but left the video exactly as it was — and returning to the
  // entry profile restored the panels while the video stayed on the other profile's
  // settings. Any caller that wants the whole appearance to follow cfg needs both.
  upsertMedia()
}

// Slider + live percentage readout + a box to type the value directly.
// kind 'alpha' stores 0..1 but shows 0..100%; kind 'plain' stores what it shows.
//
// The range and the number box must NOT share one commit handler. A range
// reports its own stored value (0..1 for alphas) while the box reports the
// displayed percentage, so a shared handler that divided by 100 made every
// alpha slider divide an already-fractional value by 100 and snap to its
// minimum the moment it was touched — the slider looked un-draggable.
//
// The box also keeps a local draft so it can be emptied while typing: binding a
// controlled input straight to the parsed value meant clearing it produced NaN,
// the commit bailed out, and the old text was restored before it could be
// replaced. The slider only follows on commit — Enter or the box losing focus.
function SliderRow({ label, hint, stored, min, max, step, kind, onChange, onPreview }) {
  const toShown = (value) => (kind === 'alpha' ? Math.round(value * 100) : Math.round(value))
  const shown = toShown(stored)
  const bounds = kind === 'alpha'
    ? { lo: Math.round(min * 100), hi: Math.round(max * 100), by: Math.max(1, Math.round(step * 100)) }
    : { lo: min, hi: max, by: step }
  const [draft, setDraft] = useState(String(shown))
  useEffect(() => { setDraft(String(shown)) }, [shown])

  // Clamps WHILE typing, not only on commit. The box used to accept "150" and show it
  // until you clicked away, which reads as "the limit does not exist". Typing a number
  // digit by digit still works: 1 -> 15 -> 100, and anything past the ceiling stops there.
  const clampDraft = (raw) => {
    const digits = String(raw ?? '').replace(/[^0-9]/g, '')
    if (digits === '') return ''
    const n = Number(digits)
    if (!Number.isFinite(n)) return ''
    return String(Math.min(bounds.hi, Math.max(bounds.lo, n)))
  }

  const commitDraft = (raw) => {
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) { setDraft(String(shown)); return }
    const value = kind === 'alpha' ? parsed / 100 : parsed
    const clamped = Math.min(max, Math.max(min, value))
    onChange(kind === 'alpha' ? Number(clamped.toFixed(3)) : Math.round(clamped))
  }

  return jsxs('div', {
    className: 'flex items-center justify-between gap-4 py-1.5',
    children: [
      jsxs('div', {
        className: 'min-w-0',
        children: [
          jsx('div', { className: 'text-sm font-medium', children: label }),
          hint ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: hint }) : null,
        ],
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('input', {
            type: 'range',
            min: String(min),
            max: String(max),
            step: String(step),
            value: stored,
            // `input` fires continuously while dragging; `change` fires once on release.
            // The live value is pushed through onPreview (paint only, no storage write)
            // and the committed value through onChange. Doing both on `change` alone made
            // the slider feel dead, because nothing on the page moved until the user let
            // go; doing both on `input` would have written storage on every pixel.
            onInput: (event) => {
              const raw = Number.parseFloat(event.target.value)
              if (!Number.isFinite(raw)) return
              const v = kind === 'alpha' ? Number(raw.toFixed(3)) : Math.round(raw)
              if (onPreview) onPreview(kind === 'alpha' ? { value: v } : { value: v })
            },
            onChange: (event) => {
              const next = Number.parseFloat(event.target.value)
              if (!Number.isFinite(next)) return
              onChange(kind === 'alpha' ? Number(next.toFixed(3)) : Math.round(next))
            },
            className: 'w-40',
          }),
          jsx('span', {
            // The width must be an inline style, not the `w-11` utility: the
            // plugin injects its UI into the app's own Tailwind bundle, which is
            // compiled ahead of time, so it only contains the utilities the app
            // itself uses. `w-11` is simply absent, the span fell back to
            // auto-width, and a 3-character readout ("5%") is narrower than a
            // 4-character one ("25%") — which shifted the whole right-aligned
            // group, and with it the slider, out of line between rows.
            //
            // text-right + tabular-nums + a fixed width is what keeps every row's
            // slider on the same x, at any value up to 100%.
            style: { width: '2.75rem', textAlign: 'right', flexShrink: 0 },
            className: 'text-sm tabular-nums text-(--ui-text-secondary)',
            children: `${shown}%`,
          }),
          jsx('input', {
            // `type: 'number'` was the odd one out. Besides drawing a spinner, a number
            // input has no selection API (selectionStart is null) and Chromium treats its
            // text differently for editi — the app's context menu is built from those
            // properties, so 粘贴 behaved unlike the other fields. Bounds are enforced in
            // commitDraft, which clamps to [min, max] on every commit anyway.
            type: 'text',
            inputMode: 'numeric',
            value: draft,
            // Digits only, typed OR pasted. A text input accepts anything, and the commit
            // path only ran on blur — so pasting "abc" left garbage on screen until you
            // clicked away, then silently reverted. Filtering on the way in means what you
            // see is always a number.
            // Paste is deliberately NOT intercepted.
            //
            // The old handler called preventDefault() whenever the clipboard text was not
            // pure digits and then replaced the WHOLE value with the filtered digits. So
            // pasting "55\n" (a newline is a non-digit) wiped the field instead of
            // inserting 55 where the caret was — the text vanished even with nothing
            // selected. Letting the browser paste normally keeps its own rule: replace
            // the selection, otherwise insert at the caret.
            //
            // Filtering still happens, in onChange. `event.target.value` is written back
            // when the sanitised value differs, because a controlled input whose state
            // does not change keeps whatever the DOM holds — "100" + pasted "abc" would
            // otherwise sit on screen as "100abc" while state still said "100".
            onChange: (event) => {
              const raw = event.target.value
              const next = clampDraft(raw)
              if (next !== raw) event.target.value = next
              setDraft(next)
            },
            onBlur: (event) => commitDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') commitDraft(event.currentTarget.value)
              if (event.key === 'Escape') setDraft(String(shown))
            },
            style: { width: '4.5rem' },
            className: 'rounded-md border border-(--ui-stroke-secondary) px-2 py-1 text-sm tabular-nums',
          }),
        ],
      }),
    ],
  })
}

function SettingsPage({ ctx }) {
  const [form, setForm] = useState({ ...cfg })
  const [saved, setSaved] = useState(false)
  const [applied, setApplied] = useState(false)
  // The DOM-level listeners below (outside-click, route watcher) are registered in
  // effects whose dependency lists deliberately do not include `form` — re-subscribing on
  // every keystroke would be pointless. But that means their closures see a stale `form`.
  // This ref always points at the newest one.
  const formRef = useRef(form)
  formRef.current = form
  // The element the app's text menu should act on. Radix moves focus into the menu when it
  // opens, so by the time 粘贴 is clicked the input is no longer `document.activeElement` —
  // the command would paste into the menu itself. Remembering the last focused input lets
  // focus be handed back before the command runs.
  const lastInputRef = useRef(null)
  useEffect(() => {
    const onFocusIn = (e) => {
      const el = e.target
      if (!el || typeof el.tagName !== 'string') return
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
        lastInputRef.current = el
      }
    }
    document.addEventListener('focusin', onFocusIn, true)
    return () => document.removeEventListener('focusin', onFocusIn, true)
  }, [])
  // A snapshot of the module-level `profiles` array, so React re-renders when it changes.
  // The array itself has to stay module-level (the rotation tick and other code paths
  // read it outside React), so the page keeps a copy and refreshes it after every
  // mutation. Copying also keeps the list rendering from a half-applied mutation.
  const [profileList, setProfileList] = useState(() => profiles.map((p) => ({ ...p })))
  const [activeId, setActiveId] = useState(activeProfileId)
  // Set while the page shows a profile other than the applied one.
  const [previewingId, setPreviewingId] = useState(previewId)
  // A switch waiting on the "unsaved changes" question.
  const [pendingSwitch, setPendingSwitch] = useState('')
  // Rotation list UI: the overlay, the paste field, and drag state for reordering.
  const [rotationOpen, setRotationOpen] = useState(false)
  // Result of the pre-save playability probe, shown as a dialog.
  const [brokenFiles, setBrokenFiles] = useState(null)
  const [probing, setProbing] = useState(false)
  // Set by 「仍然保存」 so the retried save does not probe again and loop.
  const brokenFilesSkipRef = useRef(false)
  const [pathDraft, setPathDraft] = useState('')
  const [pathError, setPathError] = useState('')
  const [pathDrag, setPathDrag] = useState(-1)
  const [pathDrop, setPathDrop] = useState(-1)
  const [pathDropAfter, setPathDropAfter] = useState(false)
  // Which row's horizontal position is being typed into, and the draft value.
  const [posEdit, setPosEdit] = useState('')
  const [posDraft, setPosDraft] = useState('')
  // BOTH of these are needed from the outside-click handler, whose effect dependency list
  // is [profilesOpen, editMode, rotationOpen] — opening a row's box changes none of those,
  // so that closure still holds the values from before the box existed. Reading state
  // there meant `if (!posEdit) return` fired immediately and the edit was dropped, while
  // the stale `posEdit` also brought the input back on reopen.
  const posDraftRef = useRef('')
  posDraftRef.current = posDraft
  const posEditRef = useRef('')
  posEditRef.current = posEdit
  // `runtime.rotationPath` is module state, so a tick that advanced the list would not
  // repaint the ▶ marker. Mirrored here and refreshed by the poll below.
  const [playingPath, setPlayingPath] = useState(runtime.rotationPath)
  const rotationRef = useRef(null)
  const syncProfiles = () => {
    setProfileList(profiles.map((p) => ({ ...p })))
    setActiveId(activeProfileId)
    setPreviewingId(previewId)
  }
  const [profilesOpen, setProfilesOpen] = useState(false)
  // null | 'rename' | 'create'. 'create' is a draft: nothing exists in storage until
  // 确定 is pressed, so 取消 genuinely discards. 另存为 used to create the profile first
  // and then open the name field, which made 取消 a lie — the profile was already saved.
  const [editMode, setEditMode] = useState(null)
  const editingName = editMode !== null
  const [nameDraft, setNameDraft] = useState('')
  const [nameError, setNameError] = useState('')
  const [dragId, setDragId] = useState('')
  const [dropTargetId, setDropTargetId] = useState('')
  // Which side of the hovered row the pointer is on. Without this the list can only be
  // inserted *before* a row, so the last position is unreachable: hovering the bottom row
  // lands you second-from-last, and the final slot can never be filled by dragging.
  const [dropAfter, setDropAfter] = useState(false)
  // The bar element, used to tell a click inside from a click elsewhere on the page.
  const barRef = useRef(null)

  // The page is kept mounted while the user navigates to other routes, so a form seeded
  // once at mount would keep showing edits the user never saved — they had to close and
  // reopen the page to see the real values. Re-seeding on mount plus discarding on
  // unmount keeps the form and the live config in step.
  //
  // `savedRef` distinguishes "left after saving" (nothing to discard) from "left with
  // unsaved edits" (restore the stored profile).
  const savedRef = useRef(false)
  // What the app looked like on arrival. Everything the page does is provisional until
  // 应用, so leaving has to restore exactly this.
  const entryRef = useRef({ id: activeProfileId, cfg: { ...cfg } })
  useEffect(() => {
    setForm({ ...cfg })
    syncProfiles()
    savedRef.current = false
    return () => {
      if (savedRef.current) return
      restoreEntry(entryRef.current).catch(() => {})
    }
  }, [])

  // The route watcher below exists because the unmount cleanup above does NOT run when
  // the user navigates to a conversation: the settings page stays mounted and merely
  // stops being rendered. Relying on unmount meant a 切换 was never undone — the store
  // still named 方案1 while the wallpaper showed 方案2, and coming back re-seeded the form
  // from a cfg that no longer matched the active profile.
  //
  // Polling the path is crude but exact: the plugin has no router hook, and this is a
  // 400ms comparison of one string.
  useEffect(() => {
    let wasHere = isOwnRoute()
    const tick = setInterval(() => {
      // Same poll, second job: keep the ▶ marker on the file the rotation actually shows.
      // setState with an unchanged value does not re-render, so this is free.
      setPlayingPath(runtime.rotationPath)
      const here = isOwnRoute()
      if (wasHere === here) return
      wasHere = here
      if (!here) {
        // Left the page: drop the preview / draft, unless the change was committed.
        if (savedRef.current) return
        restoreEntry(entryRef.current).catch(() => {})
        return
      }
      // Came back: re-seed from whatever is live now, and take that as the new baseline.
      setForm({ ...cfg })
      syncProfiles()
      savedRef.current = false
      entryRef.current = { id: activeProfileId, cfg: { ...cfg } }
    }, 400)
    return () => clearInterval(tick)
  }, [])
  // Drives the footer's version note and the compatibility status in the button row.
  // Resolved once per mount — neither the app version nor the layout can change
  // while the page is open, so there is nothing to keep watching.
  const [drift, setDrift] = useState(null)
  const [compat, setCompat] = useState(null)
  useEffect(() => {
    let alive = true
    readHermesVersion().then((info) => {
      if (!alive) return
      setDrift(hermesDrift(info))
      // Run on mount so the status is visible without a click; the button re-runs it.
      setCompat(describeCompat(runCompatibilityCheck({ notifyResult: false }), info))
    })
    return () => { alive = false }
  }, [])
  const runCheck = async () => {
    const result = runCompatibilityCheck({ notifyResult: false })
    setCompat(describeCompat(result, await readHermesVersion()))
  }

  // ---- clearing the plugin's own records ----
  // Two steps by design: the button only opens the dialog, and nothing is deleted
  // until the dialog is confirmed. The dialog's description names what will go, so
  // the confirmation is informed rather than a blind "are you sure".
  const [confirmOpen, setConfirmOpen] = useState(false)
  const storedInfo = classifyStoredKeys()
  // No result line is rendered on the page: the page has a hard one-screen budget
  // and the line measured 22px, which pushed it 2px past the fold. The dialog
  // already reports the outcome — it shows its own saving -> done state and only
  // closes on success — and the count is stated in its description beforehand. An
  // action's confirmation belongs in the dialog that asked for it anyway.
  const doClear = async () => {
    const { unavailable } = clearStoredSettings()
    if (unavailable) return
    // The form is seeded from cfg at mount, so it has to be re-seeded from the
    // defaults or the controls keep showing the values that were just deleted.
    setForm({ ...DEFAULT_CONFIG })
    // The page renders from its own snapshot, not from the module array. Without this the
    // deleted profiles stayed on screen — the store was empty while the list still showed
    // every row, so the cleanup looked like it had not worked.
    syncProfiles()
    // The page's entry snapshot must follow, or leaving now would "restore" the profiles
    // that were just deleted.
    entryRef.current = { id: activeProfileId, cfg: { ...DEFAULT_CONFIG } }
    savedRef.current = true
    await reapplyConfig()
    setCompat(describeCompat(runCompatibilityCheck({ notifyResult: false }), await readHermesVersion()))
  }
  // ---- profile handlers -------------------------------------------------------
  // Each one mutates the module-level store through the shared operations, then refreshes
  // the page's snapshot so the list re-renders. Doing the two separately is what lets a
  // stale copy be rendered after an async operation.
  // Actual switch. Writes nothing: the outgoing draft is either saved explicitly or
  // dropped, and the incoming profile is only *shown* until 应用.
  const doSwitchNow = async (id) => {
    const changed = await showProfile(ctx, id)
    if (!changed) return
    setForm({ ...cfg })
    syncProfiles()
  }

  // Switching is where an unsaved draft is easy to lose, so it asks. Three answers:
  // 保存 (write the draft, then switch), 不保存 (switch, discard), 取消 (stay).
  const doSwitch = async (id) => {
    if (id === (previewingId || activeId)) return
    if (isDirty) {
      setPendingSwitch(id)
      return
    }
    await doSwitchNow(id)
  }

  const resolveSwitch = async (mode) => {
    const target = pendingSwitch
    setPendingSwitch('')
    if (!target) return
    if (mode === 'save') saveProfileSettings(ctx, shownProfileId(), normalized)
    await doSwitchNow(target)
  }

  // Opens a draft. Nothing is written yet: `commitName` creates it on 确定, and
  // 取消 simply leaves the draft uncommitted.
  // Also opens the list. Without it, clicking 另存为 with the list closed left only a
  // name field and no list — and with the list open it looked fine, which is why this
  // behaved differently depending on state nobody was tracking. Now the two states are
  // always entered together.
  const doSaveAs = () => {
    setNameDraft(nextProfileName())
    setNameError('')
    setEditMode('create')
    setProfilesOpen(true)
  }

  const doDuplicate = async (id) => {
    const source = profiles.find((p) => p.id === id)
    if (!source) return
    // Named after its source (「方案1 复制」) and inserted directly beneath it, so both the
    // name and the position say which profile this came from. 另存为 keeps the 方案N
    // draft — that one is a new configuration, not a copy, and still appends.
    await addProfile(ctx, copyNameOf(source.name), { copyOf: source, afterId: source.id })
    syncProfiles()
  }

  const doDelete = async (id) => {
    const result = await deleteProfile(ctx, id)
    if (!result.ok) {
      if (result.reason === 'last') notify('warning', '至少要保留一套配置方案。', TOAST_MS)
      return
    }
    setForm({ ...cfg })
    syncProfiles()
  }

  const commitName = async () => {
    if (editMode === 'create') {
      // Created only here, on 确定. The new profile carries the live form (including
      // edits the user has not saved into the outgoing profile) and becomes current,
      // which is what "save as" means.
      const result = await createProfileNamed(ctx, nameDraft, form)
      if (!result.ok) {
        setNameError(result.reason === 'duplicate' ? '这个名字已被使用' : '名称不能为空')
        return
      }
      setNameError('')
      setEditMode(null)
      setProfilesOpen(false)
      // 另存为 only CREATES a record. It deliberately does not switch to the new profile:
      // the row the user was editing stays the row being shown (still 使用中 if it was),
      // and the new one simply appears in the list. Switching here made the current row
      // report 预览 and — because rename acted on the applied id — renamed the wrong
      // profile one action later.
      syncProfiles()
      return
    }
    // The profile on screen, not the applied one. After a 切换 those differ, and using
    // the applied id renamed a profile the user was not looking at while the one they WERE
    // looking at kept its old name.
    const result = await renameProfile(ctx, shownProfileId(), nameDraft)
    if (!result.ok) {
      setNameError(result.reason === 'duplicate' ? '这个名字已被使用' : '名称不能为空')
      return
    }
    setNameError('')
    setEditMode(null)
    setProfilesOpen(false)
    syncProfiles()
  }

  const cancelName = () => {
    setNameError('')
    setEditMode(null)
    // The list was opened as part of entering this mode, so leaving the mode closes it.
    setProfilesOpen(false)
  }

  // Always listening, regardless of which overlay is open. Registered at mount so it is
  // the first pointerdown capture listener on the document — earlier than Radix's own
  // dismiss handler, which is what makes pointerOnAppMenu trustworthy.
  useEffect(() => {
    const remember = (e) => {
      pointerOnAppMenu = insideAppMenu(e.target)
      // Any right press starts a menu gesture, wherever it lands.
      if (e.button === 2) menuGestureAt = Date.now()
    }
    document.addEventListener('pointerdown', remember, true)
    return () => document.removeEventListener('pointerdown', remember, true)
  }, [])

  // Clicking anywhere outside the bar puts things back: the list closes and an
  // uncommitted name is dropped. Both are "I changed my mind" gestures, and having to
  // find a 取消 button for them is the sort of small friction that makes a dropdown
  // feel sticky.
  //
  // `mousedown` rather than `click`: a click fires after the button under the pointer
  // has already handled its own press, so closing on mousedown keeps the two from
  // fighting in the same frame.
  useEffect(() => {
    if (!profilesOpen && editMode === null && !rotationOpen) return undefined
    const onPointerDown = (e) => {
      // Primary button only. A right-click inside the name/rotation inputs exists to
      // open the context menu (paste a path, correct a typo); closing the overlay on
      // mousedown destroyed the input the menu was about to act on.
      if (e.button !== 0) return
      const target = e.target
      // Choosing an item in that menu (粘贴 / 全选 / 拷贝) also lands here, on a portal
      // node outside the overlay. The menu acts ON the input, so it must not dismiss what
      // contains it.
      //
      // The check uses the value recorded at the very start of the gesture, because by now
      // the menu may already be detached and `target.closest()` would say "not a menu".
      const onMenu = pointerOnAppMenu || insideAppMenu(target)
      pointerOnAppMenu = false
      if (onMenu) {
        // Hand focus back BEFORE the item's own handler runs, so 粘贴 targets the input
        // rather than the menu.
        const el = lastInputRef.current
        if (el && typeof el.focus === 'function' && el.isConnected) {
          try { el.focus() } catch { /* focus can fail on a detached node */ }
        }
        return
      }
      const inBar = barRef.current && target && typeof barRef.current.contains === 'function'
        && barRef.current.contains(target)
      const inRotation = rotationRef.current && target && typeof rotationRef.current.contains === 'function'
        && rotationRef.current.contains(target)
      // Each overlay only ignores clicks inside itself; a click in the other one closes it.
      if (!inBar) {
        if (profilesOpen) setProfilesOpen(false)
        if (editMode !== null) {
          setNameError('')
          setEditMode(null)
        }
      }
      if (!inRotation && rotationOpen) {
        settleInterval()
        settlePosition()
        setRotationOpen(false)
        // The name field restores its draft because reopening re-seeds it from the
        // profile. The paste field has no such seed, so an abandoned path would sit there
        // forever — the next time the panel opened it looked like leftover debris rather
        // than something the user typed a moment ago.
        setPathDraft('')
        setPathError('')
      }
    }
    // Both events, deliberately.
    //
    // Radix dismisses its menu on `pointerdown` in the CAPTURE phase, and pointerdown
    // fires BEFORE mousedown. Listening only to mousedown meant the menu was already gone
    // by the time our handler ran — so the item under the pointer was detached, the click
    // never reached it, and the popover's state was decided by an event whose target no
    // longer said "this is the menu". That is the「菜单能打开，点粘贴就消失」symptom.
    //
    // Registering both is safe: the handler is idempotent (it either returns for a menu
    // node or closes what is already closed).
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [profilesOpen, editMode, rotationOpen])

  // The interval field is allowed to be empty while you type in it, and the popover
  // closes on the first mousedown outside — which unmounts the input before its blur can
  // run. So the value is settled HERE, on every path that closes the overlay, instead of
  // relying on the blur event. `form` is reliable by this point: onChange has already
  // written the empty string.
  // The position box has the same problem as the interval field, only worse: closing the
  // popover unmounts the input, and a detached element never fires blur — so an edit made
  // and then followed by a click outside was simply discarded, with no feedback at all.
  const settlePosition = () => {
    const path = posEditRef.current
    if (!path) return
    const value = posDraftRef.current
    // Clear the ref too: the caller is usually a closure that will not re-run, and a stale
    // ref would let a second close commit the same row twice.
    posEditRef.current = ''
    setPosEdit('')
    if (String(value).replace(/[^0-9]/g, '') === '') return
    commitPosition(path, value)
  }

  // Opening a DIFFERENT row's box unmounts the current input in the same way, so the
  // previous edit has to be committed before the state moves on.
  const beginEditPosition = (path, entry) => {
    if (posEditRef.current && posEditRef.current !== path) settlePosition()
    posEditRef.current = path
    setPosEdit(path)
    setPosDraft(String(rotationEntryPosition(entry, form.positionX)))
  }

  const settleInterval = () => {
    const current = formRef.current.rotationIntervalMin
    const n = Number(current)
    if (current === '' || !Number.isFinite(n) || Math.floor(n) < ROTATION_MIN_MINUTES) {
      set('rotationIntervalMin', ROTATION_MIN_MINUTES)
    }
  }

  // ---- rotation list handlers --------------------------------------------------
  // Entries carry the optional per-file position; paths are what playback and the paste
  // field deal with. Keeping the two apart is what lets old string entries keep working.
  const rotationEntries = () => (Array.isArray(form.rotationPaths) ? form.rotationPaths : [])
  const rotationPaths = () => rotationEntries().map(rotationEntryPath).filter(Boolean)

  // Hand-picking a file is the same gesture as picking a profile: it changes what you are
  // LOOKING AT, not what is stored. 保存 records the choice, 应用 also makes it live for
  // good, and leaving without either puts the previous file back.
  //
  // It writes two things:
  //   runtime.rotationPath — what the timer and the media element follow right now;
  //   form.rotationStartPath — the profile field, so the choice survives a reload.
  // The stored CURSOR is updated too, because the next launch's 「每次启动」should move on
  // from the file you actually left it on.
  const pickRotationFile = (path) => {
    if (!path) return
    runtime.rotationPath = path
    setPlayingPath(path)
    set('rotationStartPath', path)
    writeRotationCursor(path)
  }

  // The per-file horizontal position. Kept in the row rather than as a slider: the list
  // already scrolls at 260px, and a slider per row would cut it to four visible entries.
  // Commits one entry's horizontal position.
  //
  // Two rules learned from a real bug (edit file A, edit file B, A reverted):
  //   - read the LIST from formRef, not from this render's closure — the closure can be a
  //     render older than the sibling row's edit, and writing it back undid that edit;
  //   - read the VALUE from the input element, not from `posDraft` state, for the same
  //     reason a re-render may not have landed yet.
  const commitPosition = (path, rawValue) => {
    const digits = String(rawValue ?? '').replace(/[^0-9]/g, '')
    setPosEdit('')
    if (digits === '') return
    const clamped = Math.min(100, Math.max(0, Math.round(Number(digits))))
    const list = Array.isArray(formRef.current.rotationPaths) ? formRef.current.rotationPaths : []
    const index = list.findIndex((entry) => rotationEntryPath(entry) === path)
    if (index < 0) return
    const next = list.map((entry, i) => (
      i === index ? { path, positionX: clamped } : entry
    ))
    set('rotationPaths', next)
  }

  // Adds the path currently in the field.
  const addRotationPath = () => {
    // Paths are pasted, not picked: the plugin SDK exposes no file dialog (only
    // openDir/revealPath on the host bridge), so a text field is the only way in.
    //
    // ONE path at a time, by design. A multi-line paste cannot be supported by this
    // field: it is a single-line <input>, and Chromium strips the newlines the moment the
    // text is inserted ("a\nb\nc" arrives as "abc"), so a list can only be read from
    // clipboardData at paste time — which was tried, worked, and was removed as not worth
    // the extra branch. Do not reintroduce it by splitting this value.
    const lines = String(pathDraft).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (!lines.length) { setPathError('先粘贴文件路径'); return }
    const existing = rotationPaths()
    const rejected = []
    const accepted = []
    for (const line of lines) {
      // Strip a file:// prefix so a URL copied from somewhere else still works.
      const clean = line.replace(/^file:\/\//, '')
      if (!isPlayable(clean)) { rejected.push(clean); continue }
      if (existing.includes(clean) || accepted.includes(clean)) continue
      accepted.push(clean)
    }
    if (!accepted.length) {
      setPathError(rejected.length ? '只支持 mp4 / webm / mov / png / jpg' : '这些已经在列表里了')
      return
    }
    setPathError(rejected.length ? `已跳过 ${rejected.length} 个不支持的文件` : '')
    // New entries are objects from the start, so a position can be added later without
    // rewriting the entry.
    set('rotationPaths', [...rotationEntries(), ...accepted.map((path) => ({ path }))])
    setPathDraft('')
  }

  const removeRotationPath = (index) => {
    const next = rotationEntries().filter((_, i) => i !== index)
    set('rotationPaths', next)
    if (!next.length) setPathError('')
  }

  // Same insertion rule as the profile list: remove first, then locate the target, and
  // insert before or after depending on which half of the row the pointer is over.
  const dropRotationPath = (targetIndex, after) => {
    const from = pathDrag
    setPathDrag(-1)
    setPathDrop(-1)
    setPathDropAfter(false)
    if (from < 0 || from === targetIndex) return
    const list = [...rotationEntries()]
    // Remember the target by PATH before removing the dragged one: after the splice every
    // index past `from` shifts, so the remembered index would point at the wrong row.
    // Compared by path because entries are objects and two of them are never identical.
    const targetValue = rotationEntryPath(list[targetIndex])
    const [moved] = list.splice(from, 1)
    const base = list.findIndex((entry) => rotationEntryPath(entry) === targetValue)
    const at = base < 0 ? list.length : Math.min(list.length, base + (after ? 1 : 0))
    list.splice(at, 0, moved)
    set('rotationPaths', list)
  }

  // Drop handling: rebuild the id order from the hovered row and hand the whole list to
  // reorderProfiles, which renumbers and persists in one write.
  const handleDrop = async (targetId, after) => {
    const from = dragId
    // Every state update happens after the write, in one batch. Clearing the drag visuals
    // first and then refreshing the list produced two renders per drop; the reorder itself
    // measures at ~0.01 ms, so it is cheaper to wait for it than to paint twice.
    const finish = () => {
      dragInFlight = false
      setDropTargetId('')
      setDropAfter(false)
      setDragId('')
    }
    if (!from) { finish(); return }
    const ids = profiles.map((p) => p.id)
    if (ids.indexOf(from) < 0) { finish(); return }
    // Remove first, then look the target up again: splicing the source out shifts every
    // index after it, so an index computed beforehand would land one slot off whenever
    // the row is dragged downwards.
    ids.splice(ids.indexOf(from), 1)
    const base = ids.indexOf(targetId)
    if (base < 0) { finish(); return }
    const insertAt = Math.min(ids.length, base + (after ? 1 : 0))
    ids.splice(insertAt, 0, from)
    await reorderProfiles(ctx, ids)
    syncProfiles()
    finish()
  }

  // Every control goes through here, so every control previews. A switch or colour
  // picker that only updated the form would look broken next to sliders that repaint
  // immediately — and the inconsistency is worse than either behaviour on its own.
  const set = (key, value) => {
    setForm((old) => ({ ...old, [key]: value }))
    previewConfig({ [key]: value })
  }
  // The record the page is editing. Comparing against it is what makes "unsaved" mean
  // something precise: a draft differs from the stored configuration of THIS profile.
  const recordOfShown = () => settingsOf(shownProfile())
  // Rotation with no files is not a state that can be saved: it would be a profile whose
  // wallpaper cannot play. The form silently reads as 'single' in that case, so the
  // comparison below sees no change, the dirty prompt never fires, and neither 保存 nor
  // 应用 can write an empty rotating profile.
  const effectivePlayMode = (form.playMode === 'rotate'
    && (!Array.isArray(form.rotationPaths) || form.rotationPaths.length === 0))
    ? 'single'
    : form.playMode

  // The form with the mode already resolved. Every comparison and every write goes
  // through this, not through `form`.
  //
  // The earlier attempt only short-circuited on the mode and then compared the raw form
  // in the loop below — so `form.playMode === 'rotate'` still differed from the record's
  // `single` one iteration later and the page reported an unsaved change anyway. One
  // normalized object removes that whole class of mistake.
  const normalized = {
    ...form,
    playMode: effectivePlayMode,
    // An old config may hold 0 (the field allowed it before the floor existed). Normalize
    // on the way out so the stored value is always usable.
    rotationIntervalMin: (() => {
      const n = Number(form.rotationIntervalMin)
      if (!Number.isFinite(n) || Math.floor(n) < ROTATION_MIN_MINUTES) return ROTATION_MIN_MINUTES
      return Math.min(ROTATION_MAX_MINUTES, Math.floor(n))
    })(),
    // One entry shape on the way to storage. Old records hold bare strings; they become
    // `{ path }` here so everything downstream (dirty check, export) sees one type.
    rotationPaths: rotationEntries()
      .map((entry) => {
        const path = rotationEntryPath(entry)
        if (!path) return null
        if (entry && typeof entry === 'object' && entry.positionX !== undefined) {
          const n = Number(entry.positionX)
          if (Number.isFinite(n)) return { path, positionX: Math.min(100, Math.max(0, Math.round(n))) }
        }
        return { path }
      })
      .filter(Boolean),
  }
  // A pinned file that is no longer in the list would keep the profile "changed" forever
  // and point at nothing, so it is dropped here rather than silently ignored downstream.
  if (normalized.rotationStartPath
      && !normalized.rotationPaths.some((entry) => entry.path === normalized.rotationStartPath)) {
    normalized.rotationStartPath = ''
  }

  const isDirty = (() => {
    const record = recordOfShown()
    return Object.keys(DEFAULT_CONFIG).some((k) => {
      // Loose comparison: the range and the number box round-trip through strings, so a
      // strict === would report "changed" for a value the user never touched.
      const a = normalized[k]
      const b = record[k]
      if (typeof a === 'number' || typeof b === 'number') return Number(a) !== Number(b)
      return String(a ?? '') !== String(b ?? '')
    })
  })()
  // Whether 应用 has anything left to do: a different profile is being shown, or the
  // shown record differs from what was applied on arrival. Saving the RUNNING profile
  // clears this by itself (that save re-renders and re-baselines), so the normal
  // edit-save path never leaves the page asking for a second click.
  const needsApply = isDirty
    ? false
    : (Boolean(previewingId)
      || Object.keys(DEFAULT_CONFIG).some((k) => {
        const entryVal = entryRef.current.cfg[k]
        const recordVal = recordOfShown()[k]
        if (typeof entryVal === 'number' || typeof recordVal === 'number') {
          return Number(entryVal) !== Number(recordVal)
        }
        return String(entryVal ?? '') !== String(recordVal ?? '')
      }))

  // The note beside the buttons. Defined after needsApply because it reads it, and kept
  // to one line because the span that shows it has a fixed width.
  const hintText = isDirty
    ? (previewingId ? '有改动未保存（应用后生效）' : '有改动未保存（保存后生效）')
    : (needsApply ? '点应用后切换生效' : '改动保存即生效')

  // 保存: writes the draft into the shown profile's record. Appearance and the active
  // profile stay as they are — 应用 is the only thing that changes what runs.
  // 保存: writes the draft into the shown profile's record.
  //
  // Saving the profile that is ALREADY running takes effect immediately: there is no
  // switch to defer, the user is editing the live configuration, and asking them to press
  // a second button to make their own edits visible would be busywork. Saving a profile
  // that is merely being previewed does not — that one still needs 应用, because applying
  // is what decides which profile runs.
  // Shared by 保存 and 应用: probe the rotation list when one is in use, and stop with a
  // dialog if anything fails. Resolves to true when it is safe to continue.
  const checkPlayableBeforeCommit = async (settings = normalized) => {
    if (brokenFilesSkipRef.current) {
      brokenFilesSkipRef.current = false
      return true
    }
    if (settings.playMode !== 'rotate') return true
    const list = (Array.isArray(settings.rotationPaths) ? settings.rotationPaths : [])
      .map(rotationEntryPath)
      .filter(Boolean)
    if (!list.length) return true
    setProbing(true)
    let failures = []
    try {
      const results = await probeRotationPaths(list)
      failures = results.filter((r) => !r.ok)
    } finally {
      setProbing(false)
    }
    if (!failures.length) return true
    // Ask rather than decide: the file may be on an unmounted drive, or the user may want
    // to keep it and fix it later. Both are legitimate.
    setBrokenFiles(failures)
    return false
  }

  // `rotationPaths` can be overridden for one call, for the case where the caller has a
  // list that is newer than this render's `normalized` (removing unplayable files).
  const save = async (rotationPaths) => {
    const paths = Array.isArray(rotationPaths) ? rotationPaths : normalized.rotationPaths
    const mode = (form.playMode === 'rotate' && (!Array.isArray(paths) || paths.length === 0))
      ? 'single'
      : form.playMode
    const settings = { ...normalized, playMode: mode, rotationPaths: paths }
    if (!(await checkPlayableBeforeCommit(settings))) return
    const id = shownProfileId()
    const isApplied = !previewId && id === activeProfileId
    // Write the effective mode, so an empty rotation list is stored as 单视频 rather than
    // as a rotating profile with nothing to rotate.
    saveProfileSettings(ctx, id, settings)
    // The buttons must show what was actually stored. Switching to 轮换 with an empty list
    // saves as 单视频, so leaving the page showing 轮换 selected would be a lie.
    if (mode !== form.playMode) {
      setForm((prev) => ({ ...prev, playMode: mode }))
    }
    if (isApplied) {
      // Render the record that was just written, and re-baseline the entry snapshot:
      // this change is live now, so leaving the page must not undo it.
      cfg = settingsOf(shownProfile())
      entryRef.current = { id, cfg: { ...cfg } }
      savedRef.current = true
      await reapplyConfig()
      notify('success', '已保存并生效。')
    } else {
      notify('success', '已保存到该方案，点「应用」后生效。')
    }
    syncProfiles()
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const apply = async () => {
    if (!(await checkPlayableBeforeCommit())) return
    await applyShown(ctx, shownProfileId(), normalized)
    // Re-baseline: from here the page's entry state is the newly applied one, so leaving
    // no longer undoes it.
    entryRef.current = { id: activeProfileId, cfg: { ...cfg } }
    savedRef.current = true
    setForm({ ...cfg })
    syncProfiles()
    setApplied(true)
    notify('success', '已应用。')
    setTimeout(() => setApplied(false), 2000)
  }

  // Rows are py-1.5 rather than py-3: with two extra section headings the page
  // has to stay inside one window height, and py-3 pushed the save button and the
  // footer past the fold. Any tighter (or with the headings dropped) it reads as
  // cramped, which is the other half of the brief.
  const row = (label, control, hint) => jsxs('div', {
    className: 'flex items-center justify-between gap-4 py-1.5',
    children: [
      jsxs('div', {
        className: 'min-w-0',
        children: [
          jsx('div', { className: 'text-sm font-medium', children: label }),
          hint ? jsx('div', { className: 'text-xs text-(--ui-text-tertiary)', children: hint }) : null,
        ],
      }),
      control,
    ],
  })

  const section = (icon, title, children) => jsxs('div', {
    className: 'flex flex-col gap-0.5 pt-0.5',
    children: [
      jsx('div', {
        className: 'pb-0.5 text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary)',
        children: `${icon} ${title}`,
      }),
      ...children,
    ],
  })

  const sliderRow = (label, key, opts, hint) => jsx(SliderRow, {
    key,
    label,
    hint,
    stored: Number(form[key]),
    ...opts,
    // Dragging previews: paint the candidate value without writing storage. The form
    // mirrors it so the readout and the slider stay together; only `onChange`
    // (on release) marks the value as committed.
    onPreview: (payload) => {
      const value = payload && typeof payload === 'object' ? payload.value : payload
      setForm((prev) => ({ ...prev, [key]: value }))
      previewConfig({ [key]: value })
    },
    onChange: (value) => set(key, value),
  })

  // ---- profiles section --------------------------------------------------------
  // Collapsed by default: the settings page has no vertical slack, and the list is
  // only interesting when the user is deliberately managing configurations.
  const SLOT_W = '58px'
  const slotButton = (label, onClick, extra) => jsx(Button, {
    size: 'xs',
    onClick,
    style: { width: SLOT_W },
    ...extra,
    children: label,
  }, label)

  const profileRow = (p) => {
    // The row being displayed. It equals the applied profile unless a switch is pending,
    // and claiming 使用中 for a preview would state something that is not true yet.
    const isShown = p.id === (previewingId || activeId)
    const isActive = p.id === activeId
    const isDragging = dragId === p.id
    const isTarget = dropTargetId === p.id && Boolean(dragId) && dragId !== p.id
    const showAfter = isTarget && dropAfter
    const showBefore = isTarget && !dropAfter
    // Inline styles carry the dynamic parts; Tailwind cannot generate a class from a
    // runtime value, and style property values are strings so no class is needed.
    // Both borders are always 2px (transparent when inactive) so the indicator does not
    // change the row's height and shift the list while dragging.
    const rowStyle = {
      borderTop: `2px solid ${showBefore ? 'var(--ui-text-tertiary)' : 'transparent'}`,
      borderBottom: `2px solid ${showAfter ? 'var(--ui-text-tertiary)' : 'transparent'}`,
      opacity: isDragging ? '0.4' : '1',
    }
    return jsxs('div', {
      key: p.id,
      draggable: true,
      onDragStart: (e) => {
        dragInFlight = true
        setDragId(p.id)
        // Firefox refuses to start a drag without data on the transfer.
        try { e.dataTransfer.setData('text/plain', p.id) } catch { /* ignore */ }
        e.dataTransfer.effectAllowed = 'move'
      },
      onDragOver: (e) => {
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        // Past the halfway point means "insert after this row", which is the only way to
        // reach the last position in the list.
        setDropAfter(rect.height > 0 && e.clientY - rect.top > rect.height / 2)
        setDropTargetId(p.id)
      },
      onDragLeave: () => setDropTargetId((cur) => (cur === p.id ? '' : cur)),
      onDrop: (e) => {
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        const after = rect.height > 0 && e.clientY - rect.top > rect.height / 2
        handleDrop(p.id, after)
      },
      onDragEnd: () => { dragInFlight = false; setDragId(''); setDropTargetId(''); setDropAfter(false) },
      className: 'flex items-center gap-2 px-1.5 py-1 cursor-grab select-none',
      style: rowStyle,
      title: '拖动可调整顺序',
      children: [
        jsx('span', { className: 'text-(--ui-text-tertiary) text-xs', children: '⠿' }),
        jsx('span', {
          className: `flex-1 min-w-0 truncate text-sm${isActive ? ' font-medium' : ''}`,
          style: { color: isActive ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)' },
          children: p.name,
        }),
        // Same three slots in every row: the active row swaps the first button for a
        // label, but keeps its width, so the buttons below each other stay aligned.
        isShown
          ? jsx('span', {
            className: 'text-(--ui-text-tertiary) text-xs',
            style: { width: SLOT_W, textAlign: 'center', display: 'inline-block' },
            // 预览 is the honest label between 切换 and 应用.
            children: previewingId ? '预览' : '使用中',
          })
          : slotButton('切换', () => doSwitch(p.id)),
        slotButton('复制', () => doDuplicate(p.id)),
        // The active profile cannot be deleted: it is the one being edited, and removing
        // it would silently change what the page is editing underneath the user. Deleting
        // one of the others is still fine.
        // Disabled for the active profile; no tooltip — a disabled button that explains
        // itself in a tooltip still reads as clickable, and the state is clear enough.
        slotButton('删除', () => doDelete(p.id), { disabled: isShown }),
      ],
    })
  }

  // ---- rotation list overlay ------------------------------------------------------
  // Floats, like the profile list: the settings page is laid out to fit one screen and a
  // file list appearing in flow would push everything below it.
  // `opacity` is set inline for the dragged row because Tailwind's opacity utilities the
  // app ships do not include the 40% step.
  const rotationList = () => jsxs('div', {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 'calc(100% + 4px)',
      zIndex: 3,
      maxHeight: '260px',
      overflowY: 'auto',
      scrollbarGutter: 'stable',
      background: 'var(--ui-bg-elevated)',
      border: '1px solid var(--ui-stroke-secondary)',
      borderRadius: '4px',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
    },
    children: [
      // Paste field. A file dialog is not available to plugins — the host bridge only
      // exposes openDir/revealPath — so paths come in as text, one per add.
      jsxs('div', {
        // Same padding as a profile row (px-1.5 py-1) and the same 26px control height,
        // so the two overlays have identical internal metrics.
        className: 'flex items-center gap-1.5 px-1.5 py-1',
        style: { borderBottom: '1px solid var(--ui-stroke-secondary)' },
        children: [
          jsx('div', {
            className: 'flex items-center flex-1 min-w-0',
            style: { height: '26px' },
            children: jsx(Input, {
              value: pathDraft,
              onChange: (e) => { setPathDraft(e.target.value); setPathError('') },
              // Same keys as the other two fields: Enter commits, Escape abandons. This
              // one had only Enter, so the only way out of a half-typed path was to click
              // away — which also closed the popover.
              onKeyDown: (e) => {
                if (e.key === 'Enter') addRotationPath()
                if (e.key === 'Escape') { setPathDraft(''); setPathError('') }
              },
              placeholder: '粘贴文件路径，回车添加',
              spellCheck: false,
              // Matches the profile name field exactly: 14px on a 20px line with 2px of
              // vertical padding inside a 26px box.
              style: {
                fontSize: '0.875rem',
                lineHeight: '20px',
                paddingTop: '2px',
                paddingBottom: '2px',
              },
            }),
          }),
          jsx(Button, {
            size: 'xs',
            onClick: () => addRotationPath(),
            style: { width: SLOT_W },
            children: '添加',
          }),
        ],
      }),
      rotationPaths().length
        ? jsx('div', {
          className: 'flex flex-col',
          children: [
            // Column legend. Without it the percentage column reads as a mystery number:
            // nothing on screen says it is that file's horizontal framing.
            jsxs('div', {
              className: 'flex items-center gap-1.5 px-1.5 py-1 text-xs text-(--ui-text-tertiary)',
              style: { borderTop: '1px solid var(--ui-stroke-secondary)' },
              children: [
                jsx('span', {
                  style: { flex: 1, minWidth: 0 },
                  children: '点击文件名可立即播放；右侧数字是该文件单独的水平位置',
                }),
                jsx('span', { style: { width: '44px', textAlign: 'right', flexShrink: 0 } }),
                jsx('span', { style: { width: '58px', flexShrink: 0 } }),
              ],
            }),
            ...rotationEntries().map((entry, index) => {
            // Old records hold bare strings; everything below works from the path and asks
            // rotationEntryPosition() for the fallback.
            const path = rotationEntryPath(entry)
            if (!path) return null
            const isPlaying = Boolean(path) && path === playingPath
            const isDragging = pathDrag === index
            const isTarget = pathDrop === index && pathDrag >= 0 && pathDrag !== index
            const showBefore = isTarget && !pathDropAfter
            const showAfter = isTarget && pathDropAfter
            return jsxs('div', {
              key: `${index}-${path}`,
              draggable: true,
              // Records where the press actually landed, before the browser decides to
              // start a drag. See rowDownTarget.
              onMouseDown: (e) => { rowDownTarget = e.target },
              onDragStart: (e) => {
                // Dragging inside the position box must select digits, not move the row.
                // A press that began on an input cannot be a row drag, whatever the
                // browser hands over as the drag source.
                const from = rowDownTarget
                rowDownTarget = null
                const fromField = Boolean(from && (
                  from.tagName === 'INPUT' || from.tagName === 'TEXTAREA'
                  || (typeof from.closest === 'function' && from.closest('input, textarea'))
                ))
                if (fromField) {
                  e.preventDefault()
                  return
                }
                setPathDrag(index)
                try { e.dataTransfer.setData('text/plain', String(index)) } catch { /* ignore */ }
                e.dataTransfer.effectAllowed = 'move'
              },
              onDragOver: (e) => {
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setPathDropAfter(rect.height > 0 && e.clientY - rect.top > rect.height / 2)
                setPathDrop(index)
              },
              onDragLeave: () => setPathDrop((cur) => (cur === index ? -1 : cur)),
              onDrop: (e) => {
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                const after = rect.height > 0 && e.clientY - rect.top > rect.height / 2
                dropRotationPath(index, after)
              },
              onDragEnd: () => { setPathDrag(-1); setPathDrop(-1); setPathDropAfter(false) },
              // Same row geometry as a profile row: px-1.5 py-1, text-sm.
              // `select-none` belongs on the row (so dragging does not select the label),
              // but it INHERITS into descendants — including the position input, where it
              // makes the text unselectable. The input re-enables selection for itself.
              className: 'flex items-center gap-1.5 px-1.5 py-1 cursor-grab select-none',
              style: {
                borderTop: `2px solid ${showBefore ? 'var(--ui-text-tertiary)' : 'transparent'}`,
                borderBottom: `2px solid ${showAfter ? 'var(--ui-text-tertiary)' : 'transparent'}`,
                opacity: isDragging ? '0.4' : '1',
              },
              title: '拖动可调整播放顺序',
              children: [
                jsx('span', { className: 'text-(--ui-text-tertiary) text-xs shrink-0', children: '⠿' }),
                // Which file is playing right now. Its own fixed slot so every row's
                // filename starts at the same x whether the marker is there or not.
                jsx('span', {
                  className: 'text-xs shrink-0',
                  style: {
                    width: '10px',
                    color: isPlaying ? 'var(--ui-accent)' : 'transparent',
                  },
                  'aria-hidden': isPlaying ? undefined : 'true',
                  title: isPlaying ? '正在播放' : undefined,
                  children: '▶',
                }),
                // The order number, because playback order is the whole point of this list.
                jsx('span', {
                  className: 'text-(--ui-text-tertiary) text-sm tabular-nums shrink-0',
                  style: { width: '16px', textAlign: 'right' },
                  children: String(index + 1),
                }),
                // Clicking the name plays that file now. Same gesture as picking a profile:
                // it previews until 保存 records it or 应用 makes it stick.
                jsx('span', {
                  className: 'flex-1 min-w-0 truncate text-sm cursor-pointer',
                  style: {
                    color: isPlaying ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)',
                    fontWeight: isPlaying ? '600' : '400',
                  },
                  title: `${path}（点击播放此文件）`,
                  onClick: () => pickRotationFile(path),
                  children: path.split('/').pop() || path,
                }),
                // Per-file horizontal position. A number rather than a slider: the list
                // scrolls at 260px and a slider per row would leave four visible entries.
                posEdit === path
                  ? jsx(Input, {
                    value: posDraft,
                    autoFocus: true,
                    // Clamped as you type, like the slider box: 0–100 is the whole range
                    // of object-position, and showing 999 until blur looks like a bug.
                    // Same rule as the slider box: no paste interception, filter in
                    // onChange. Intercepting replaced the whole value, which deleted the
                    // digits already there even when nothing was selected.
                    onChange: (e) => {
                      const raw = e.target.value
                      const digits = raw.replace(/[^0-9]/g, '')
                      const next = digits === '' ? '' : String(Math.min(100, Number(digits)))
                      if (next !== raw) e.target.value = next
                      setPosDraft(next)
                    },
                    onClick: (e) => e.stopPropagation(),
                    // Kept out of the row's drag, so a click-drag that begins on the digits
                    // selects them instead of picking the row up.
                    //
                    // NOTE: this is NOT the fix for right-click-to-paste. A controlled
                    // three-way experiment (identical inputs, the only variable being a
                    // draggable ancestor) showed all three cases pasting correctly, so a
                    // draggable row is not what breaks the menu. Left in place because it
                    // is right for selection; do not cite it as the paste fix.
                    draggable: false,
                    // Belt and braces: whatever else ran, take focus back so the menu's
                    // paste command has a target.
                    onContextMenu: (e) => {
                      e.currentTarget.focus()
                    },
                    // The row decides from rowDownTarget; stopping propagation here would
                    // ALSO stop the row from recording where the press began, which is the
                    // signal that keeps a text selection from starting a row drag.
                    onDragStart: (e) => { e.preventDefault(); e.stopPropagation() },
                    // Enter commits by blurring, so the value is written exactly once.
                    // Committing on Enter AND on blur fired twice from two different
                    // renders: the second call carried an older list and undid the
                    // sibling row's edit.
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') e.currentTarget.blur()
                      // Escape abandons: clear the draft FIRST, so the blur that follows
                      // cannot commit the value the user just cancelled. Restoring the
                      // original number matters too — without it the box reopened showing
                      // the rejected edit, which reads as "Escape did nothing".
                      if (e.key === 'Escape') {
                        // Clear the draft ref BEFORE anything can read it: the outside-click
                        // handler commits from these refs and may run before the re-render
                        // that would have synced them. An empty draft makes settlePosition
                        // a no-op, which is what "cancelled" has to mean.
                        setPosDraft(String(rotationEntryPosition(entry, form.positionX)))
                        posDraftRef.current = ''
                        posEditRef.current = ''
                        setPosEdit('')
                      }
                    },
                    // A blur caused by the context menu opening must not commit: that
                    // unmounted the input and left 粘贴 with nothing to act on. Any other
                    // blur (click elsewhere, Enter, opening another row) still commits.
                    onBlur: (e) => {
                      if (Date.now() - menuGestureAt < MENU_GESTURE_MS) return
                      commitPosition(path, e.currentTarget.value)
                    },
                    style: {
                      width: '44px',
                      fontSize: '0.75rem',
                      lineHeight: '16px',
                      padding: '2px 4px',
                      textAlign: 'right',
                      flexShrink: 0,
                      // Counteracts the row's select-none, which otherwise reaches this
                      // input and makes its text impossible to select or drag-select.
                      userSelect: 'text',
                    },
                  })
                  : jsx('span', {
                    className: 'text-xs tabular-nums shrink-0 cursor-pointer text-(--ui-text-tertiary)',
                    style: { width: '44px', textAlign: 'right' },
                    title: '该文件单独的画面水平位置，点击修改',
                    onClick: (e) => {
                      e.stopPropagation()
                      beginEditPosition(path, entry)
                    },
                    children: `${rotationEntryPosition(entry, form.positionX)}%`,
                  }),
                jsx(Button, {
                  size: 'xs',
                  onClick: () => removeRotationPath(index),
                  style: { width: SLOT_W },
                  children: '移除',
                }),
              ],
            })
            }),
          ],
        })
        : jsx('div', {
          // Inside the overlay, so a plain line is right — the bordered box belongs to the
          // row outside, where it stands in for the single-video input.
          className: 'px-1.5 py-1 text-xs text-(--ui-text-tertiary)',
          children: '列表为空，把文件路径粘贴到上面添加。',
        }),
      // Shuffle and interval in one footer row, so the overlay stays compact.
      jsxs('div', {
        className: 'flex items-center gap-1.5 px-1.5 py-1',
        style: { borderTop: '1px solid var(--ui-stroke-secondary)' },
        children: [
          jsx('span', { className: 'text-sm text-(--ui-text-secondary)', children: '随机播放' }),
          jsx(Switch, {
            checked: Boolean(form.rotationShuffle),
            onCheckedChange: (v) => set('rotationShuffle', v),
          }),
          // 「每次启动」sits next to 随机播放 because the two are independent: shuffle only
          // changes WHICH file gets picked, startup only changes WHEN. Either, both, or
          // neither is valid.
          jsx('span', {
            className: 'text-sm text-(--ui-text-secondary)',
            style: { marginLeft: '12px' },
            // Names WHEN and HOW OFTEN: "每次启动" alone reads like a label for the
            // neighbouring control rather than a mode that changes what happens.
            children: '启动时切换一次',
          }),
          jsx(Switch, {
            checked: Boolean(form.rotationOnStartup),
            onCheckedChange: (v) => set('rotationOnStartup', v),
          }),
          jsx('span', {
            className: 'text-sm text-(--ui-text-secondary)',
            style: { marginLeft: 'auto' },
            children: '每',
          }),
          jsx(Input, {
            // In 「每次启动」mode the list advances once per launch and never on a timer, so
            // an editable interval would be a control that has no effect.
            disabled: Boolean(form.rotationOnStartup),
            title: form.rotationOnStartup
              ? '已选「启动时切换一次」：应用每次启动时换一个文件，运行期间不按间隔切换'
              : undefined,
            value: String(form.rotationIntervalMin ?? ''),
            onChange: (e) => {
              // Numbers only: a stray letter would make Number() NaN and the timer would
              // silently fall back to the default interval.
              const digits = e.target.value.replace(/[^0-9]/g, '')
              // Empty stays empty WHILE typing. Forcing it to 1 here would fight the
              // user: clear the field, type "5", and the caret sits after the 1 that was
              // re-inserted — you get 15. The floor is applied on blur, below.
              if (digits === '') { set('rotationIntervalMin', ''); return }
              // Clamped on the way in, so neither 0 nor 99999 can be stored.
              set('rotationIntervalMin', Math.min(
                ROTATION_MAX_MINUTES,
                Math.max(ROTATION_MIN_MINUTES, Number(digits)),
              ))
            },
            // The field is never allowed to stay empty once you leave it. An empty interval
            // has no meaning, and silently becoming the 10-minute default is worse than
            // settling on the floor.
            // Reads the ELEMENT, not `form`. Clearing the field then clicking away
            // happens faster than a re-render, so `form.rotationIntervalMin` can still be
            // the old "10" here — the guard then sees a valid value and does nothing,
            // leaving the field empty. The DOM always knows what is actually on screen.
            onBlur: (e) => {
              const typed = String((e.currentTarget && e.currentTarget.value) || '')
                .replace(/[^0-9]/g, '')
              const n = Number(typed)
              if (typed === '' || !Number.isFinite(n) || Math.floor(n) < ROTATION_MIN_MINUTES) {
                set('rotationIntervalMin', ROTATION_MIN_MINUTES)
              }
            },
            // The bounds are enforced in code above. `type="text"` rather than "number"
            // on purpose: a number input draws a spinner inside the field, and that
            // spinner plus the component's own 10px padding each side ate the space the
            // digits needed — "1440" was clipped even at 56px wide.
            type: 'text',
            inputMode: 'numeric',
            style: {
              // 64px with tight padding holds four digits at 14px comfortably.
              width: '64px',
              fontSize: '0.875rem',
              lineHeight: '20px',
              padding: '2px 4px',
              textAlign: 'center',
              // The Input component already paints disabled at 50% opacity; the explicit
              // cursor keeps it from looking like a field you simply failed to click.
              cursor: form.rotationOnStartup ? 'not-allowed' : undefined,
            },
          }),
          jsx('span', { className: 'text-sm text-(--ui-text-secondary)', children: '分钟' }),
        ],
      }),
      pathError
        ? jsx('div', {
          className: 'px-1.5 pb-1 text-xs',
          style: { color: 'var(--ui-red)' },
          children: pathError,
        })
        : null,
    ],
  })

  // ---- profiles bar --------------------------------------------------------------
  //
  // Three fixed-width slots, always in the same place. Their labels change with the mode
  // (重命名/确定, 管理/取消) but the slots do not move: a bar whose buttons resize as the
  // state changes makes the user chase the control they were about to click.
  //
  // `width` is set in px rather than left to the label, because Chinese labels here are
  // 2–3 characters and padding alone would still produce three different widths.
  const profilesBar = jsxs('div', {
    className: 'flex flex-col',
    // Positioning context for the overlay and the error pill.
    style: { position: 'relative' },
    ref: barRef,
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 min-w-0',
        children: [
          jsx('span', {
            className: 'text-xs font-semibold uppercase tracking-wide text-(--ui-text-tertiary) shrink-0',
            // 🗂️ rather than 💾: the save button owns the floppy disk. No count either —
            // "方案 3" read as "profile three", not "three profiles".
            children: '🗂️ 方案列表',
          }),
          // A fixed 26px slot holding either the name or the field. The app's Input
          // defaults to text-xs/leading-4 with py-1.5 (a ~30px box), while the name is
          // text-sm (a ~20px line): swapping them changed both the type size and the
          // bar's height, and the height change could tip the page over the fold and pop
          // a scrollbar — so the whole page jumped. Both children are now text-sm/leading-5
          // inside the same 26px box, and the input's padding is reduced to fit it exactly
          // (20px line + 4px padding + 2px border = 26px).
          jsx('div', {
            className: 'flex items-center flex-1 min-w-0',
            style: { height: '26px' },
            children: editingName
              ? jsx(Input, {
                value: nameDraft,
                onChange: (e) => { setNameDraft(e.target.value); setNameError('') },
                onKeyDown: (e) => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') cancelName()
                },
                // Inline styles, not classes. The component sets text-xs/leading-4/py-1.5
                // itself, and although cn() is tailwind-merge (so a later class would win
                // during merge), relying on merge order for a visual match is fragile —
                // an inline style beats any class, unconditionally.
                // 20px line + 2+2px padding + 1+1px border = 26px, the container height.
                style: {
                  fontSize: '0.875rem',
                  lineHeight: '20px',
                  paddingTop: '2px',
                  paddingBottom: '2px',
                },
                placeholder: '方案名称',
              })
              : jsx('span', {
                className: 'text-sm leading-5 truncate min-w-0',
                style: { color: 'var(--ui-text-primary)' },
                children: shownProfile()?.name || '方案1',
              }),
          }),
          jsxs('div', {
            className: 'flex items-center gap-1 shrink-0',
            children: [
              // The labels swap in place: 确定 takes the 重命名 slot and 取消 takes the
              // 收起 slot, so nothing moves and the row keeps reading left to right as
              // "the main action, then the way out, then 另存为".
              editingName
                ? slotButton('确定', commitName)
                : slotButton('重命名', () => {
                  setNameDraft(shownProfile()?.name || '')
                  setNameError('')
                  setEditMode('rename')
                  // Opening the list shows the other names while editing, which is the
                  // information you need to avoid a collision.
                  setProfilesOpen(true)
                }),
              // 另存为 now sits before 管理, so the resting row reads
              // 重命名 · 另存为 · 管理 — the same order as the rotation row (management on
              // the right). While naming, 确定 / 取消 take the first two slots so the pair
              // stays adjacent; the third keeps 另存为 in place, disabled.
              editingName
                ? slotButton('取消', cancelName)
                : slotButton('另存为', doSaveAs),
              editingName
                ? slotButton('另存为', doSaveAs, { disabled: true })
                : slotButton(profilesOpen ? '收起' : '管理', () => {
                  setProfilesOpen((v) => { const next = !v; if (next) { settleInterval(); settlePosition(); setRotationOpen(false) } return next })
                }),
            ],
          }),
          nameError
            ? jsx('span', {
              style: {
                position: 'absolute',
                right: 0,
                bottom: 'calc(100% + 4px)',
                padding: '2px 8px',
                borderRadius: '4px',
                // --ui-bg-quaternary is color-mix(... 4% ...): 96% transparent, unreadable
                // over video. --ui-bg-elevated is opaque and is what popovers use.
                background: 'var(--ui-bg-elevated)',
                border: '1px solid var(--ui-stroke-secondary)',
                color: 'var(--ui-red)',
                whiteSpace: 'nowrap',
                zIndex: 4,
                pointerEvents: 'none',
              },
              className: 'text-xs',
              children: nameError,
            })
            : null,
        ],
      }),
      // An overlay, not a flow element. In flow, opening the list made the page taller
      // than the window, a scrollbar appeared, the content got narrower, and every row
      // re-wrapped. Floating it means opening changes nothing.
      //
      // It opens DOWNWARD: the bar now sits under the enable switch near the top of the
      // page, so upward would overflow the container and get clipped.
      profilesOpen
        ? jsx('div', {
          style: {
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(100% + 4px)',
            zIndex: 3,
            maxHeight: '176px',
            overflowY: 'auto',
            // Reserve the scrollbar's width even when it is not shown, so a long list
            // does not re-wrap every row as it appears.
            scrollbarGutter: 'stable',
            background: 'var(--ui-bg-elevated)',
            border: '1px solid var(--ui-stroke-secondary)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
          },
          children: profileList.map(profileRow),
        })
        : null,
    ],
  })

  return jsxs('div', {
    className: 'mx-auto flex h-full max-w-2xl flex-col gap-1 overflow-y-auto px-5 py-4',
    // Reserve the scrollbar gutter for good. Without it, the moment content grows past
    // the fold the scrollbar appears, the content box narrows, and every row re-wraps —
    // which is exactly the "UI changed again" the user saw.
    style: { scrollbarGutter: 'stable' },
    children: [
      jsx('div', { className: 'pb-0.5 text-xl font-semibold', children: '✨ 灵动舞台' }),
      jsxs('p', {
        className: 'max-w-xl pb-0.5 text-(--ui-text-secondary) text-sm leading-relaxed',
        // Two explicit lines rather than one long string: at this width the text
        // wrapped mid-phrase, splitting "越明显" across lines. A deliberate break
        // reads better and does not depend on the exact container width.
        children: [
          '把界面变成一层薄纱：视频在最底下，所有面板共用同一套配色。',
          jsx('br', {}),
          '数值越低画面越透 —— 越好看，也越考验文字可读性。',
        ],
      }),

      section('⚙️', '基础', [
        row('启用灵动舞台', jsx(Switch, { checked: form.enabled, onCheckedChange: (v) => set('enabled', v) }), '关闭后会恢复 Hermes 原本的界面外观'),
        // The profile bar sits directly under the enable switch: it is what the user
        // reaches for first ("which configuration am I on"), and as an overlay it costs
        // no vertical space here.
        profilesBar,
        // One row, two faces. The mode switch and the source control share the row so
        // adding rotation costs no vertical space — the page has none to spare.
        jsxs('div', {
          className: 'flex items-start justify-between gap-4 py-1.5',
          // The overlay belongs to the CONTROL COLUMN, not to the whole row: the row is
          // taller than the button (the mode buttons sit under their label on the left),
          // so anchoring here left the panel floating well below the button it belongs to.
          // Anchored to the column, 100% is the bottom of the button row and the 4px gap
          // matches the profile overlay's gap under its bar.
          ref: rotationRef,
          children: [
            jsxs('div', {
              className: 'min-w-0 shrink-0',
              children: [
                jsx('div', { className: 'text-sm font-medium', children: '播放方式' }),
                // A two-way switch, not a select: there are exactly two modes and both
                // are worth seeing at once.
                jsxs('div', {
                  className: 'flex items-center gap-0.5 pt-1',
                  children: [
                    jsx(Button, {
                      size: 'xs',
                      variant: form.playMode === 'single' ? 'default' : 'ghost',
                      onClick: () => set('playMode', 'single'),
                      children: '单视频',
                    }),
                    jsx(Button, {
                      size: 'xs',
                      variant: form.playMode === 'rotate' ? 'default' : 'ghost',
                      onClick: () => set('playMode', 'rotate'),
                      children: '轮换',
                    }),
                  ],
                }),
              ],
            }),
            jsxs('div', {
              className: 'flex-1 min-w-0',
              style: { position: 'relative' },
              children: [
                form.playMode === 'rotate'
                  ? jsxs('div', {
                  className: 'flex items-center gap-2 min-w-0',
                  children: [
                    // An empty list renders the SAME box as the single-video input, with
                    // muted placeholder text. A bare span here made the two modes look like
                    // two different kinds of control on the same row.
                    jsx('div', {
                      className: rotationPaths().length
                        ? 'flex items-center flex-1 min-w-0 text-sm truncate'
                        : 'flex items-center flex-1 min-w-0 text-xs leading-4 text-muted-foreground',
                      style: rotationPaths().length
                        ? { color: 'var(--ui-text-primary)' }
                        : {
                          height: '29.5px',
                          padding: '6px 10px',
                          border: '1px solid var(--ui-stroke-secondary)',
                          borderRadius: '2.5px',
                          boxSizing: 'border-box',
                        },
                      children: rotationPaths().length
                        ? `${rotationPaths().length} 个文件${form.rotationShuffle ? ' · 随机' : ''}${
          form.rotationOnStartup
            ? ' · 启动时切换一次'
            : ` · 每 ${form.rotationIntervalMin} 分钟`
        }`
                        : '还没有添加文件',
                    }),
                    jsx(Button, {
                      size: 'xs',
                      onClick: () => {
                        // Only one overlay may be open: two panels floating over the same
                        // page at once is unreadable, and both are anchored near each
                        // other.
                        setRotationOpen((v) => {
                        const next = !v
                        // Closing settles the interval: see settleInterval.
                        if (!next) { settleInterval(); settlePosition() }
                        else setProfilesOpen(false)
                        return next
                      })
                      },
                      // 管理, matching the profile bar: both buttons open a panel that
                      // manages a list, and the same word for the same job keeps the two
                      // rows readable as one interface. Same 58px slot width too.
                      style: { width: SLOT_W },
                      children: rotationOpen ? '收起' : '管理',
                    }),
                  ],
                })
                : jsx(Input, {
                  value: form.mediaPath,
                  onChange: (e) => set('mediaPath', e.target.value),
                  placeholder: '留空则使用插件自带视频',
                  spellCheck: false,
                }),
                rotationOpen && form.playMode === 'rotate'
                  ? rotationList()
                  : null,
              ],
            }),
          ],
        }),
      ]),

      section('🎨', '外观', [
        sliderRow('视频可见度', 'opacity', { min: 0, max: 1, step: 0.01, kind: 'alpha' }, '视频层本身的亮度，0% 等于隐藏视频'),
        sliderRow('画面水平位置', 'positionX', { min: 0, max: 100, step: 1, kind: 'plain' }, '视频比窗口窄时，决定露出哪一段'),
        sliderRow('面板不透明度', 'sidebarAlpha', { min: 0, max: 1, step: 0.01, kind: 'alpha' }, '整窗底板浓度，0% 时面板完全透明'),
        sliderRow('气泡不透明度', 'bubbleAlpha', { min: 0, max: 1, step: 0.01, kind: 'alpha' }, '气泡、卡片、输入框与终端共用'),
        row('面板颜色', jsx('input', { type: 'color', value: form.sidebarColor, onChange: (e) => set('sidebarColor', e.target.value) }), '只取色相，亮度会自动压到可读区间'),
        row('文字阴影', jsx(Switch, { checked: form.textShadow, onCheckedChange: (v) => set('textShadow', v) }), '给压在视频上的文字加一层深色描边；面板内的文字不受影响'),
      ]),

      // One row: 保存 / 应用 on the left, 检查兼容性 / 清理配置 on the right, each pair with
      // its own note underneath. Splitting the diagnostics into a separate row made them
      // look like page furniture rather than the controls they are.
      jsxs('div', {
        className: 'flex items-start justify-between gap-6 pt-2',
        children: [
          jsxs('div', {
            className: 'flex flex-col',
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Button, {
                    onClick: () => save(),
                    // 保存 holds its width with an invisible longer label so the button
                    // does not twitch when the confirmation replaces it.
                    children: jsxs('span', {
                      className: 'relative inline-flex items-center justify-center',
                      children: [
                        jsx('span', {
                          className: saved ? 'invisible' : undefined,
                          'aria-hidden': saved ? 'true' : undefined,
                          children: '💾 保存',
                        }),
                        saved
                          ? jsx('span', {
                            className: 'absolute inset-0 inline-flex items-center justify-center',
                            children: '✓ 已保存',
                          })
                          : null,
                      ],
                    }),
                  }),
                  jsx(Button, {
                    onClick: apply,
                    'data-hlw-apply': needsApply || isDirty ? '1' : undefined,
                    children: jsxs('span', {
                      className: 'relative inline-flex items-center justify-center',
                      children: [
                        jsx('span', {
                          className: applied ? 'invisible' : undefined,
                          'aria-hidden': applied ? 'true' : undefined,
                          children: '🚀 应用',
                        }),
                        applied
                          ? jsx('span', {
                            className: 'absolute inset-0 inline-flex items-center justify-center',
                            children: '✓ 已应用',
                          })
                          : null,
                      ],
                    }),
                  }),
                ],
              }),
              // Its own row, so the text can be as long as it needs to be and the buttons
              // above never move as its length changes.
              jsx('span', {
                className: 'text-xs text-(--ui-text-tertiary)',
                style: { marginTop: '6px' },
                children: hintText,
              }),
            ],
          }),
          jsxs('div', {
            className: 'flex flex-col',
            // Right-aligned so the pair hugs the page edge, matching the build stamp below.
            style: { alignItems: 'flex-end' },
            children: [
              jsxs('div', {
                className: 'flex items-center gap-2',
                children: [
                  jsx(Button, { onClick: runCheck, children: '🔍 检查兼容性' }),
                  jsx(Button, {
                    onClick: () => setConfirmOpen(true),
                    'data-hlw-danger': '1',
                    children: '🧹 清理配置',
                  }),
                ],
              }),
              compat
                ? jsx('span', {
                  className: `text-xs ${compat.cls}`,
                  style: { marginTop: '6px' },
                  title: compat.long,
                  children: compat.short,
                })
                : null,
            ],
          }),
        ],
      }),

      // Files that failed the pre-save probe. Three answers, because all three are
      // reasonable: the file may be on an unmounted drive (keep it), or it may be junk
      // (drop it), or the user may want to go and look (cancel).
      jsx(ConfirmDialog, {
        open: Boolean(brokenFiles),
        onClose: () => setBrokenFiles(null),
        onConfirm: () => {
          // Drop the failures and continue with what is left.
          //
          // The comparison must go through rotationEntryPath: entries are objects
          // ({ path, positionX }) since per-file positions landed, so `bad.has(entry)`
          // was testing an object against a set of PATH STRINGS — always false. Every
          // row survived, the list never changed, and the toast still claimed N files
          // were removed. That is exactly what "移除 but nothing happened" looked like.
          const bad = new Set((brokenFiles || []).map((r) => r.path))
          const entries = Array.isArray(form.rotationPaths) ? form.rotationPaths : []
          const kept = entries.filter((entry) => !bad.has(rotationEntryPath(entry)))
          setBrokenFiles(null)
          set('rotationPaths', kept)
          // Continue the save that this dialog interrupted. Handing `kept` over
          // explicitly is required: `save()` reads `normalized`, which is computed
          // during render — a setState has not landed yet, so it would write the list
          // with the broken files still in it.
          brokenFilesSkipRef.current = true
          Promise.resolve().then(async () => {
            await save(kept)
            // After the save, so the count is not immediately overwritten by 「已保存」.
            notify('warning', `已移除 ${bad.size} 个无法播放的文件`, TOAST_MS)
          })
        },
        title: '有无法播放的文件',
        description: [
          `轮换列表里有 ${(brokenFiles || []).length} 个文件读不出来：`,
          ...(brokenFiles || []).slice(0, 6).map((r) => `· ${r.path.split('/').pop()}（${r.reason}）`),
          ...((brokenFiles || []).length > 6 ? [`· 其余 ${(brokenFiles || []).length - 6} 个…`] : []),
          '',
          '点「移除这些文件」会把它们从列表里删掉；',
          '点「仍然保存」则保留，等你之后自行处理。',
        ].join('\n'),
        confirmLabel: '移除这些文件',
        secondaryAction: {
          label: '仍然保存',
          onClick: () => {
            // Force the write through, skipping the probe this one time.
            brokenFilesSkipRef.current = true
            setBrokenFiles(null)
            Promise.resolve().then(() => save())
          },
        },
        cancelLabel: '取消',
      }),
      // Three answers for the unsaved-draft case: 保存 writes the draft then switches,
      // 不保存 drops it and switches, 取消 stays put. ConfirmDialog supports exactly
      // this shape through secondaryAction.
      jsx(ConfirmDialog, {
        open: Boolean(pendingSwitch),
        onClose: () => setPendingSwitch(''),
        onConfirm: () => resolveSwitch('save'),
        title: '当前方案有未保存的调整',
        description: '要先把这些调整保存到当前方案，再切换到另一个方案吗？\n\n点「不保存」会丢弃这次的调整。',
        confirmLabel: '保存并切换',
        secondaryAction: { label: '不保存', onClick: () => { resolveSwitch('discard') } },
        cancelLabel: '取消',
      }),
      jsx(ConfirmDialog, {
        open: confirmOpen,
        onClose: () => setConfirmOpen(false),
        onConfirm: doClear,
        destructive: true,
        title: '清理全部配置？',
        // The dialog renders this with whitespace-pre-line, so the line breaks do
        // survive here (they would not in a notification).
        description: [
          `将删除本插件在 Hermes 设置存储中的 ${storedInfo.owned.length} 条记录：`,
          `命名空间 hermes.plugin.${ID}.`,
          '',
          // The count is of storage keys, which does not tell the user what they lose.
          // Name the loss explicitly: this clears every saved profile, not just the
          // current one.
          `⚠️ 会清掉全部 ${profileList.length} 套方案配置 —— 不只是当前这一套。`,
          '删除后立即恢复默认设置，被清掉的方案无法恢复。',
          '',
          '其他插件与 Hermes 自身的设置不会被触碰。',
          '如需保留，请先点「取消」，或把方案导出备份。',
        ].join('\n'),
        confirmLabel: '确认清理',
        doneLabel: '已清理',
        cancelLabel: '取消',
      }),
      jsx('div', {
        // text-right alone is enough: the parent is a flex column, so this block
        // stretches to the full width and its text sits against the right edge —
        // no ml-auto or wrapper needed.
        className: 'text-right text-xs text-(--ui-text-tertiary)',
        // The slug stays on the element (attribute + tooltip) so it can still be
        // read back to confirm which build is live, without cluttering the label.
        title: BUILD,
        'data-build': BUILD,
        children: drift
          ? `📅 构建日期 ${BUILD_DATE} · 版本 v${VERSION} · 适配 Hermes ${TESTED_HERMES.version} ⚠️ 当前 ${drift.running || '未知'}`
          : `📅 构建日期 ${BUILD_DATE} · 版本 v${VERSION} · 适配 Hermes ${TESTED_HERMES.version}`,
      }),
    ],
  })
}

export default {
  id: ID,
  name: '灵动舞台 · Dynamic Backdrop',
  register(ctx) {
    // Take over from any previously loaded instance. Only the timers are stopped —
    // the media element, stylesheet and tokens are shared and the new instance
    // adopts them, so the handover is seamless rather than a teardown/rebuild.
    try {
      const previous = window[INSTANCE_KEY]
      if (previous && typeof previous.stop === 'function') previous.stop()
    } catch {
      // A broken predecessor must not prevent this one from starting.
    }
    window[INSTANCE_KEY] = { stop: stopCycle, token: cfg.mediaToken }

    runtime.ctx = ctx
    readConfig(ctx)
    // A migration only exists in memory until it is written. Persist it immediately:
    // otherwise the next load migrates again from the same flat keys (harmless) but any
    // change the user makes in between is saved against a record that was never stored,
    // and the two views diverge.
    if (runtime.migrated) saveConfig(ctx)
    resolveDefaultPath().then(() => {
      const result = runCompatibilityCheck({ notifyResult: true })
      if (result.level !== 'blocked') {
        // Seed BEFORE the heartbeat. Writing the beat first made this window look like a
        // sibling of itself: seedRotation read its own fresh beat and skipped the advance,
        // so 「启动时切换一次」never fired at all. The beat has to be the sign that some
        // OTHER window is already up, so it is published only after this one has decided.
        // Seeding first also keeps the first frame on a rotation file rather than briefly
        // showing the single file and then switching.
        seedRotation()
        startHeartbeat()
        upsertMedia()
        observeLayout()
        startRotation()
      }
    })
    // The packaged Desktop may expose desktopPluginsRoot a little after the
    // plugin registry mounts. Retry without resetting an already-playing video.
    setTimeout(() => refreshPlugin().catch(() => {}), 1000)
    setTimeout(() => refreshPlugin().catch(() => {}), 3000)
    // Skipped while a row is being dragged. The tick re-applies CSS variables and
    // re-measures targets; landing in the middle of a drag (or just after release, when
    // React is already re-rendering the list) is what made the drop feel like it stalled.
    runtime.refreshInterval = setInterval(() => {
      if (dragInFlight) return
      // The one place that cannot miss the transition. Relying on the settings component's
      // unmount cleanup was not enough: whether that runs depends on how the host swaps
      // routes, and a preview left behind means the wallpaper shows a profile the store
      // does not name as active.
      if (previewId && !isOwnRoute()) {
        previewId = ''
        cfg = settingsOf(activeProfile())
      }
      refreshPlugin().catch(() => {})
    }, 2000)

    ctx.register({
      id: 'settings-page',
      area: ROUTES_AREA,
      title: '灵动舞台',
      data: { path: '/dynamic-backdrop-settings' },
      render: () => jsx(SettingsPage, { ctx }),
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      // codicon names must exist in the app's own codicon font — an unknown name
      // renders as nothing at all. `sparkle` is present (checked against the
      // shipped stylesheet, which defines 649 codicon-* glyphs).
      data: { path: '/dynamic-backdrop-settings', label: '灵动舞台', codicon: 'sparkle' },
    })
    ctx.register({
      id: 'commands',
      area: PALETTE_AREA,
      data: {
        label: '打开灵动舞台设置',
        keywords: ['dynamic-backdrop', 'hermes-dynamic-backdrop', '灵动舞台', '舞台', '壁纸', '皮肤'],
        run: () => host.navigate('/dynamic-backdrop-settings'),
      },
    })
    // Mints a new media token, which changes the URL and therefore forces the
    // <video> to re-read the file from disk. This is the deliberate way to pick up a
    // replaced file at the same path; keeping it off the automatic path is what stops
    // a reload loop from turning into flicker.
    ctx.register({
      id: 'reload-media',
      area: PALETTE_AREA,
      data: {
        label: '重新加载背景视频',
        keywords: ['dynamic-backdrop', '灵动舞台', '视频', '重载', 'reload', 'media'],
        run: async () => {
          cfg = { ...cfg, mediaToken: Date.now().toString(36) }
          saveConfig(ctx)
          await reapplyConfig()
          notify('success', '已重新加载背景视频')
        },
      },
    })
    ctx.register({
      id: 'compatibility-check',
      area: PALETTE_AREA,
      data: {
        label: '检查灵动舞台兼容性',
        keywords: ['dynamic-backdrop', 'hermes-dynamic-backdrop', '灵动舞台', '兼容性', 'compatibility'],
        run: async () => {
          // Same formatter as the settings row, so the two can never disagree. The
          // notification is deliberately one line: the host collapses whitespace.
          const result = runCompatibilityCheck({ notifyResult: false })
          const desc = describeCompat(result, await readHermesVersion())
          notify(desc.kind, desc.long)
        },
      },
    })
  },
}
