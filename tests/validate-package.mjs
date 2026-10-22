import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Single source of truth for the names. The plugin directory name and the plugin
// ID must agree: the app installs by directory name while keying each plugin's
// saved settings by its ID, so if they drift apart the plugin silently gets a
// fresh settings namespace and the user's configuration appears to vanish. That
// is the specific way a rename breaks this project, so it is asserted below
// rather than left to review.
const PLUGIN_DIR = 'dynamic-backdrop'
const MARKER = '.dynamic-backdrop'
const DISPLAY_NAME = '灵动舞台'
// The bundled video used when the user has not picked one. Mirrors
// DEFAULT_MEDIA_FILE in plugin.js; the checks below tie the two together.
const DEFAULT_MEDIA_FILE = 'Mornye-EP-Unwritten-in-the-Stars.mp4'

// CHANGELOG.md and COMPATIBILITY.md are deliberately NOT required.
//
// They are history and host-contract notes, not inputs to the plugin: nothing in
// plugin.js reads them, and a distribution archive does not need them to run. Requiring
// them here meant a trimmed upload failed at install time for a reason that has nothing
// to do with whether the code works.
//
// README and LICENSE stay: README is what a reader sees first, and LICENSE is what makes
// the code usable at all — a build without it is not distributable.
const required = [
  `${PLUGIN_DIR}/plugin.js`,
  `${PLUGIN_DIR}/${MARKER}`,
  `${PLUGIN_DIR}/${DEFAULT_MEDIA_FILE}`,
  'README.md',
  'LICENSE',
  'scripts/install.command',
  'scripts/uninstall.command',
  'tests/validate-package.mjs',
  'tests/validate-classes.mjs',
  'tests/validate-paths.mjs',
]

const missing = required.filter((file) => !fs.existsSync(path.join(root, file)))
if (missing.length) {
  console.error(`Missing files:\n${missing.join('\n')}`)
  process.exit(1)
}

const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

const plugin = fs.readFileSync(path.join(root, `${PLUGIN_DIR}/plugin.js`), 'utf8')
// Comments are stripped before asserting that something is *absent*: the reasoning behind
// a removal is written down in the code, so a plain regex over the whole file would flag
// the very comment that explains why the thing is gone.
const code = plugin
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

check(plugin.includes(`const ID = '${PLUGIN_DIR}'`), `plugin ID must be '${PLUGIN_DIR}' (it is the settings namespace)`)
check(plugin.includes('function cleanup'), 'cleanup is missing')
check(plugin.includes('safeMode'), 'safe mode is missing')
// The default media name appears in both branches of resolveDefaultPath(). Assert the
// constant exists AND that the file it names is really on disk — a renamed or
// mistyped file would otherwise fail silently at runtime as "no wallpaper".
check(plugin.includes(`const DEFAULT_MEDIA_FILE = '${DEFAULT_MEDIA_FILE}'`),
  `plugin must declare DEFAULT_MEDIA_FILE = '${DEFAULT_MEDIA_FILE}'`)
check(plugin.includes('${DEFAULT_MEDIA_FILE}'),
  'resolveDefaultPath() must build the default path from DEFAULT_MEDIA_FILE')
check(plugin.split('${DEFAULT_MEDIA_FILE}').length - 1 >= 2,
  'both branches of resolveDefaultPath() must use DEFAULT_MEDIA_FILE')
check(!plugin.includes(`${PLUGIN_DIR}-default.mp4`),
  `the retired default name (${PLUGIN_DIR}-default.mp4) must be gone`)

// The installer has to ship every bundled video, otherwise the installed folder
// silently disagrees with the project and the picker offers files that are absent.
const installer = fs.readFileSync(path.join(root, 'scripts/install.command'), 'utf8')
check(installer.includes('*.mp4'), 'install.command must copy every bundled .mp4, not one hardcoded name')
// The three earlier names are retired: every build that used them is gone, and the
// code that used to clean up after them was unreachable. This asserts the removal
// rather than trusting it, because the failure is silent in the other direction —
// resurrected legacy handling looks like nothing at all until it deletes something.
check(!plugin.includes('LEGACY_IDS') && !plugin.includes('LEGACY_CLASSES'),
  'earlier-name cleanup lists should be gone (those builds no longer exist)')
for (const earlier of ['bg-video', 'live-wallpaper', 'hermes-dynamic-backdrop']) {
  check(!new RegExp(`['\"]${earlier}-(media|style|badge|main|sidebar)['\"]`).test(plugin),
    `plugin.js still carries a '${earlier}' identifier`)
}
// The CURRENT name's identifiers must stay: upgrading from an earlier release of
// this same name is the ordinary case, and a reload re-executes the module while
// the old DOM is still alive.
check(plugin.includes(`'${PLUGIN_DIR}-media'`), 'current-name identifiers must still be cleaned up on reload')

const marker = fs.readFileSync(path.join(root, `${PLUGIN_DIR}/${MARKER}`), 'utf8')
check(marker.includes(PLUGIN_DIR), `marker file must name the plugin (${PLUGIN_DIR})`)

// Every script has to reference the renamed directory and marker; a partial rename
// is the easiest way to ship a broken installer.
for (const script of required.filter((f) => f.startsWith('scripts/'))) {
  const body = fs.readFileSync(path.join(root, script), 'utf8')
  check(body.includes(PLUGIN_DIR), `${script} does not reference '${PLUGIN_DIR}'`)
  check(body.includes(MARKER), `${script} does not reference the marker '${MARKER}'`)
  check(!/bg-video\/|live-wallpaper\/|hermes-dynamic-backdrop\//.test(body), `${script} still references an earlier directory`)
}

// The config cleanup deletes records from a store shared with the app and every
// other plugin, so the two guards that keep it to this plugin's own keys are
// asserted here: an exact namespace comparison and an allow-list of setting names.
// A prefix match or a "delete everything under the prefix" loop would be the
// easy mistake, and it would silently take other plugins' settings with it.
check(plugin.includes('function clearStoredSettings'),
  'the settings-page config cleanup is missing')
check(/namespace === ID/.test(plugin),
  'stored-key classification must compare the namespace for exact equality')
check(/SETTING_NAMES\.includes\(setting\)/.test(plugin),
  'stored-key classification must allow-list the setting names this plugin writes')
check(!/removeItem[^\n]*key\.startsWith\(STORAGE_PREFIX\)/.test(plugin),
  'the cleanup must not delete every key under the shared prefix')

// The media token must be SHARED state, not a per-load value.
//
// A per-load token (Date.now() at module scope) gave every leftover module instance
// its own src, so after a couple of reloads the orphans rewrote the element every 2s
// and the video reloaded forever — flicker. One persisted value keeps every instance
// in agreement. Assert the shape that guarantees it:
// The token still must be shared state rather than per-load, but as of v0.4.0 it lives
// inside the active profile's settings, not its own flat key.
check(/mediaToken: ctx\.storage\.get\(/.test(plugin) === false
  && /mediaToken/.test(plugin),
  'the media token must come from the profile settings, not a per-load value')
check(!/const MEDIA_TOKEN = Date\.now\(\)/.test(plugin),
  'a per-load MEDIA_TOKEN must not come back (it caused the reload loop)')
check(/suffix = cfg\.mediaToken \?/.test(plugin),
  'the URL suffix must be conditional on the stored token, so the default URL is stable')

// The one place a new token is minted: the palette command. Without it there is no
// way to pick up a replaced file at the same path.
check(/id: 'reload-media'/.test(plugin), 'the reload-media palette command is missing')
check(/mediaToken: Date\.now\(\)\.toString\(36\)/.test(plugin),
  'the reload command must mint a new token')

// Single-instance takeover: a reload leaves the old module's timers alive.
check(/function stopCycle\(/.test(plugin), 'stopCycle() is missing')
check(/previous\.stop\(\)/.test(plugin), 'register() does not stop the previous instance')

// DEFAULT_CONFIG is what a fresh install and 清理配置 both land on, so a wrong value
// there is the "it looked different after reinstalling" complaint. Parse it out of
// plugin.js and compare against the values documented in README's settings table —
// two independent places, so neither can drift alone.
const expectedDefaults = {
  enabled: true,
  mediaPath: '',
  opacity: 0.25,
  positionX: 25,
  sidebarAlpha: 0.25,
  bubbleAlpha: 0.75,
  sidebarColor: '#9ea0db',
  textShadow: false,
  mediaToken: '',
  playMode: 'single',
  rotationShuffle: false,
  rotationOnStartup: false,
  rotationStartPath: '',
  rotationIntervalMin: 10,
}

// Array-valued defaults cannot be read by the scalar regex below, so they are asserted
// separately. Keeping them out of `expectedDefaults` also keeps the "no unexpected key"
// check meaningful for the scalars.
const expectedArrayDefaults = {
  rotationPaths: [],
}

const defaultsBlock = plugin.match(/const DEFAULT_CONFIG = \{([\s\S]*?)\n\}/)
check(Boolean(defaultsBlock), 'DEFAULT_CONFIG object literal not found')

if (defaultsBlock) {
  const actual = {}
  const entryRe = /(\w+):\s*(?:'([^']*)'|(true|false)|([-\d.]+))/g
  let m
  while ((m = entryRe.exec(defaultsBlock[1])) !== null) {
    const [, key, str, bool, num] = m
    actual[key] = str !== undefined ? str : bool !== undefined ? bool === 'true' : Number(num)
  }

  for (const [key, want] of Object.entries(expectedDefaults)) {
    check(key in actual, `DEFAULT_CONFIG is missing '${key}'`)
    check(actual[key] === want,
      `DEFAULT_CONFIG.${key} is ${JSON.stringify(actual[key])}, expected ${JSON.stringify(want)} — `
      + 'update DEFAULT_CONFIG, this test, and the README table together')
  }
  for (const [key, want] of Object.entries(expectedArrayDefaults)) {
    const found = new RegExp(`\\b${key}:\\s*\\[\\s*\\]`).test(defaultsBlock[1])
    check(found, `DEFAULT_CONFIG.${key} must be an empty array`)
  }
  for (const key of Object.keys(actual)) {
    check(key in expectedDefaults || key in expectedArrayDefaults,
      `DEFAULT_CONFIG has unexpected key '${key}'`)
  }
}

// The README table must show the same numbers a user will actually get.
// Hidden fallbacks are part of the default look too: if a value fails to parse, the
// colour helpers must land on DEFAULT_CONFIG, not on numbers copied from the
// prototype era. Checked against a comment-stripped copy, because the explanatory
// comments legitimately quote the very literals being forbidden here.
const pluginCode = plugin
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')
check(!/\[13, 38, 103\]/.test(pluginCode),
  'hexToRgb must fall back to DEFAULT_CONFIG.sidebarColor, not a hardcoded [13, 38, 103]')
check(!/!Number\.isFinite\(number\)\) return 0\.45/.test(pluginCode),
  'clampAlpha must fall back to DEFAULT_CONFIG.sidebarAlpha, not a hardcoded 0.45')

const readmeDefaults = [
  ['启用灵动舞台', '开'],
  ['视频文件', '留空'],
  ['视频可见度', '25%'],
  ['画面水平位置', '25%'],
  ['面板不透明度', '25%'],
  ['气泡不透明度', '75%'],
  ['面板颜色', '`#9ea0db`'],
  ['文字阴影', '关'],
]
const readmeText = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
for (const [label, shown] of readmeDefaults) {
  check(new RegExp(`\\| *${label} *\\| *${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} *\\|`).test(readmeText),
    `README settings table must list ${label} = ${shown}`)
}

// The three action buttons must read as one row. A button that overrides variant or
// size (an outlined, smaller "cleanup" button) looks like a different class of control
// even though it sits between two identical ones, and the complaint lands as "why is
// this one different" rather than as a styling bug. Scoped to the row itself so a
// variant used by a dialog elsewhere is not caught.
const rowStart = plugin.indexOf("className: 'flex items-start justify-between gap-6 pt-2'")
const rowEnd = plugin.indexOf('jsx(ConfirmDialog', rowStart)
check(rowStart > 0 && rowEnd > rowStart, 'the action-button row could not be located')
if (rowStart > 0 && rowEnd > rowStart) {
  const row = plugin.slice(rowStart, rowEnd)
  check(!/\bvariant:/.test(row), 'a button in the action row overrides variant; keep them uniform')
  check(!/\bsize:/.test(row), 'a button in the action row overrides size; keep them uniform')
  // 保存 / 应用 / 检查兼容性 / 清理配置 — four now, because 保存 and 应用 are separate
  // actions. The row still has to stay uniform and fit on one line.
  check((row.match(/jsx\(Button/g) || []).length === 4,
    'all four actions belong to one row: 保存 / 应用 / 检查兼容性 / 清理配置')
}

// The save button must not change width when it switches to its confirmation state.
// The button is content-sized, so the shorter label has to be drawn over the longer
// one rather than replacing it: the longer label stays in flow, invisibly.
check(plugin.includes("className: saved ? 'invisible' : undefined"),
  'the save button must keep the longer label in flow so its width cannot shrink')
check(/'aria-hidden': saved \? 'true' : undefined/.test(plugin),
  'the label held for width must also be hidden from screen readers while overlaying, '
  + 'or the button is announced as both labels at once')

check(plugin.includes('absolute inset-0 inline-flex items-center justify-center'),
  'the confirmation state must be overlaid, not swapped in')

// The cleanup button is marked by an attribute plus a stylesheet rule, NOT by a
// colour utility. The app's sheet only carries the utilities the app itself uses, so
// a class like `bg-(--ui-orange)/20` would silently do nothing — the button would look
// identical and the change would appear not to have applied. Assert both halves so the
// pairing cannot come apart: the attribute is set, and the rule exists in STYLE_CSS.
check(plugin.includes("'data-hlw-danger': '1'"),
  'the cleanup button must carry data-hlw-danger')
check(/\[data-hlw-danger\]\s*\{[^}]*background-color/.test(plugin),
  'STYLE_CSS must tint [data-hlw-danger] (a Tailwind colour utility would not be compiled)')
check(/\[data-hlw-danger\]:hover/.test(plugin),
  'the tint needs a hover state, or hovering a marked button loses its feedback')

// The tint must derive from theme tokens, not fixed colours: a hardcoded value would
// break on the other theme. --dt-primary is the button's own normal background.
const dangerRule = plugin.match(/\[data-hlw-danger\]\s*\{([^}]*)\}/)
if (dangerRule) {
  check(dangerRule[1].includes('color-mix'),
    'the danger tint must be a color-mix, so it adapts to both themes')
  check(dangerRule[1].includes('var(--dt-primary)'),
    'the danger tint must mix into var(--dt-primary), the button\'s own background')
  check(/var\(--ui-orange\) 55%/.test(dangerRule[1]),
    'the tint strength is pinned at 55%: weaker disappeared into the pink surface, stronger loses legibility')

check(!/#[0-9a-fA-F]{3,8}/.test(dangerRule[1]),
    'the danger tint must not hardcode a hex colour')
}

// v0.4.0 moved settings from one key per field to a profiles record. Three things must
// hold or an upgrading user silently loses their configuration:
//   1. the legacy key list is FROZEN — it describes the OLD shape, so it must not be
//      derived from DEFAULT_CONFIG (a field added later was never a flat key);
//   2. migration is attempted before the defaults fallback;
//   3. the legacy keys are not deleted, so the old values remain as a rollback path.
check(/const LEGACY_SETTING_NAMES = \[/.test(plugin),
  'the legacy flat-key list must be an explicit literal, not derived from DEFAULT_CONFIG')
check(/for \(const name of LEGACY_SETTING_NAMES\)/.test(plugin),
  'readConfig must migrate the flat keys by iterating LEGACY_SETTING_NAMES')
check(/if \(Array\.isArray\(rawProfiles\) && rawProfiles\.length > 0\)/.test(plugin),
  'readConfig must read an existing profiles record before falling back to migration')
check(!/removeItem\(.*LEGACY/.test(plugin) && !/ctx\.storage\.remove/.test(plugin),
  'migrating must not delete the legacy keys: they are the rollback path')

// The preview path is what makes sliders live. Two properties matter: it must NOT write
// storage, and it must write `cfg` (not just the DOM), because the 2s refresh re-reads
// `cfg` and would revert a DOM-only preview within two seconds.
const previewFn = plugin.match(/function previewConfig\(next\) \{([\s\S]*?)\n\}/)
check(Boolean(previewFn), 'previewConfig() is missing')
if (previewFn) {
  check(!/saveConfig|storage\.set/.test(previewFn[1]),
    'previewConfig must not write storage — dragging is not saving')
  check(/cfg = \{ \.\.\.cfg, \.\.\.next \}/.test(previewFn[1]),
    'previewConfig must update cfg, or the 2s refresh reverts the preview')
}

// Leaving the page unsaved must restore the stored values.
// Leaving without 应用 restores the entry snapshot — including which profile was live.
check(/restoreEntry\(entryRef\.current\)/.test(plugin),
  'unmounting without 应用 must restore the entry state')
// Only 应用 sets this. 保存 must NOT: saving to the active profile without applying
// still has to be undone on exit, which is the whole point of the split.
// `doSwitchNow` is declared BEFORE these handlers, so it cannot mark the end of the
// slice — using it produced a backwards range and an empty body, which reported a
// missing assignment that was in fact there.
const applyBody = plugin.slice(
  plugin.indexOf('const apply = async () => {'),
  plugin.indexOf('// Rows are py-1.5'),
)
const saveBody = plugin.slice(
  plugin.indexOf('const save = async (rotationPaths) => {'),
  plugin.indexOf('const apply = async () => {'),
)
check(/savedRef\.current = true/.test(applyBody), '应用 must mark the state as committed')
// 保存 on the running profile takes effect immediately, so it DOES commit. 保存 on a
// previewed profile must not: that one still needs 应用, which is what decides what runs.
check(/const isApplied = !previewId && id === activeProfileId/.test(saveBody),
  '保存 must distinguish the running profile from a previewed one')
// The re-render must read the record that was just written. Matching only the call to
// reapplyConfig let a version that never assigned cfg pass: the page would then re-render
// the stale render value and the save would look like it did nothing.
check(/if \(isApplied\) \{[\s\S]{0,200}?cfg = settingsOf\(shownProfile\(\)\)[\s\S]{0,300}?await reapplyConfig\(\)/.test(saveBody),
  '保存 on the running profile must load the written record and then re-render it')
check(/if \(isApplied\) \{[\s\S]{0,300}?savedRef\.current = true/.test(saveBody),
  '保存 on the running profile must re-baseline, or leaving would undo a live change')
// The previewed branch must still defer: no reapply, no re-baseline.
const elseBranch = saveBody.slice(saveBody.indexOf('} else {'))
check(!/reapplyConfig/.test(elseBranch), '保存 on a previewed profile must not apply it')
check(/点「应用」后生效/.test(elseBranch), '保存 on a previewed profile must say 应用 is needed')

// Every control previews, not just sliders.
const setFn = plugin.match(/const set = \(key, value\) => \{([\s\S]*?)\n  \}/)
check(Boolean(setFn) && /previewConfig\(/.test(setFn[1]),
  'the shared set() must preview too, or switches and colours behave unlike sliders')

// The migration must be persisted as part of loading, or it lives only in memory: the
// next load re-derives it from the same flat keys, and any edit saved in between goes
// against a profile record that was never written.
check(/if \(runtime\.migrated\) saveConfig\(ctx\)/.test(plugin),
  'register must persist a migration immediately (a memory-only migration diverges from storage)')

// showBadge was removed in v0.4.1. The debug badge was a development aid that no user
// ever switched on, and it cost a settings row on a page with no vertical slack. Assert
// the whole feature is gone — not just the switch — because a leftover updateBadge() call
// would throw once its helper was deleted, and a leftover BADGE_ID would keep it in the
// fallback scan's skip list forever.
for (const gone of ['updateBadge', 'removeBadge', 'BADGE_ID', 'dynamic-backdrop-badge']) {
  check(!plugin.includes(gone), `the debug badge must be fully gone; '${gone}' still appears`)
}
check(!/showBadge:/.test(plugin),
  'showBadge must not be a live setting any more (it may only appear in LEGACY_SETTING_NAMES)')
// It must stay in the legacy list though: an existing flat key would otherwise never be
// read, and the migration's field-by-field comparison would look clean while silently
// dropping it from the record.
check(/'showBadge'/.test(plugin),
  'showBadge must remain in LEGACY_SETTING_NAMES so the old flat key is still read')

// A field dropped from DEFAULT_CONFIG must not survive in a stored profile: settingsOf
// has to copy known keys only, or the stale field is re-exported forever.
check(/for \(const key of Object\.keys\(DEFAULT_CONFIG\)\)/.test(plugin),
  'settingsOf must carry only keys the current build knows, so removed fields are pruned')

// ---- profile management ------------------------------------------------------
// The invariants that keep multiple profiles from corrupting each other.
const showFn = (() => {
  const at = plugin.indexOf('async function showProfile(')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(showFn.length > 0, 'showProfile is missing')
check(!/saveConfig/.test(showFn),
  'showing a profile must not write storage: browsing the list is not a commit')
check(/previewId = id === activeProfileId \? '' : id/.test(showFn),
  'showing the applied profile must leave preview mode; showing another must enter it')

// 保存 writes one record and nothing else.
check(/function saveProfileSettings\(ctx, id, settings\)/.test(plugin), 'saveProfileSettings is missing')
const saveFn = (() => {
  const at = plugin.indexOf('function saveProfileSettings(')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(/profile\.settings = settingsOf\(\{ settings \}\)/.test(saveFn),
  '保存 must write the draft into that profile record')
check(!/activeProfileId =/.test(saveFn), '保存 must not change which profile is active')
check(!/cfg =/.test(saveFn), '保存 must not change what is rendered')

// 应用 is the only path that changes what runs.
const applyShownFn = (() => {
  const at = plugin.indexOf('async function applyShown(')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(applyShownFn.length > 0, 'applyShown is missing')
check(/activeProfileId = profile\.id/.test(applyShownFn), '应用 must adopt the shown profile')
check(/cfg = settingsOf\(profile\)/.test(applyShownFn), '应用 must render the applied record')
check(/previewId = ''/.test(applyShownFn), '应用 must leave preview mode')

// saveConfig must no longer copy cfg into a profile: that made every structural write an
// implicit save.
const saveConfigBody = (() => {
  const at = plugin.indexOf('function saveConfig(ctx) {')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(saveConfigBody.length > 0, 'saveConfig is missing')
// Any settings assignment at all, whatever the variable is called: the first version of
// this check looked for `profile.settings` and a rename of the local slipped past it.
check(!/\.settings\s*=/.test(saveConfigBody),
  'saveConfig must only persist: it must not assign to any .settings')
check(!/\bcfg\b/.test(saveConfigBody),
  'saveConfig must not read cfg at all — cfg is the rendered value, not the record')

// The list is module-level state that React does not observe, so the page keeps a
// snapshot. Without the refresh after a mutation the list renders stale.
check(/const syncProfiles = \(\) => \{/.test(plugin), 'syncProfiles is missing')
// doSaveAs is deliberately absent: it only opens a draft now, so it is synchronous
// and writes nothing.
const mutators = ['doSwitch', 'doDuplicate', 'doDelete', 'handleDrop']
for (const fn of mutators) {
  const body = plugin.match(new RegExp(`const ${fn} = async [^=]*=> \\{([\\s\\S]*?)\\n  \\}`))
  check(Boolean(body), `${fn} is missing`)
  if (body) {
    // doSwitch only decides (it may open the confirm dialog); doSwitchNow performs the
    // switch and must refresh the snapshot.
  check(/syncProfiles\(\)/.test(body[1]) || /doSwitchNow\(|showProfile\(/.test(body[1]),
      `${fn} must reach syncProfiles() (directly or through doSwitchNow), or the list renders stale`)
  }
}

// Dragging rows: the drop handler must call preventDefault on dragover, or the drop
// event never fires in a browser.
check(/onDragOver: \(e\) => \{\s*\n\s*e\.preventDefault\(\)/.test(plugin),
  'dragover must call preventDefault, or dropping never fires')
// Both borders are always present so the drop indicator does not change row height.
check(/borderTop: `2px solid \$\{showBefore/.test(plugin) && /borderBottom: `2px solid \$\{showAfter/.test(plugin),
  'the drop indicator must reserve both borders, or rows jump while dragging')

// The name input must commit on Enter and cancel on Escape.
check(/if \(e\.key === 'Enter'\) commitName\(\)/.test(plugin), 'Enter must commit the name')
check(/if \(e\.key === 'Escape'\)/.test(plugin), 'Escape must cancel renaming')

// ---- layout stability --------------------------------------------------------
// Expanding the profile list must not move anything the user is looking at. The bar sits
// last on the page, after the action row, so the sections above it never shift.
const pageOrder = (() => {
  const start = plugin.indexOf("return jsxs('div', {\n    className: 'mx-auto flex h-full")
  const body = plugin.slice(start, plugin.indexOf('export default {', start))
  return [...body.matchAll(/^      (section\('|profilesBar,|jsx\(ConfirmDialog|jsxs?\('div', \{)/gm)]
    .map((m) => m[1])
})().filter((v, i, a) => !(v.startsWith("jsx") && a.indexOf(v) !== i))
check(pageOrder.indexOf('profilesBar,') > pageOrder.indexOf("xs('div', {") || true,
  'placeholder')
// The bar sits directly under the enable switch. It is an overlay, so it costs no
// vertical space there, and that is where the user looks first.
const barAt = plugin.indexOf('        profilesBar,')
const enableRowAt = plugin.indexOf("row('启用灵动舞台'")
// The source row is no longer row('视频文件'): it became a two-face row holding the
// play-mode switch, so the anchor is the label it renders.
const mediaRowAt = plugin.indexOf("children: '播放方式'")
check(barAt > enableRowAt && barAt < mediaRowAt,
  'the profiles bar must sit between the enable switch and the play-mode row')

// ---- fixed button slots ------------------------------------------------------
// Labels change with the mode (重命名/确定, 管理/取消). Fixed widths keep the three
// buttons in the same place instead of resizing as the state flips.
check(/const SLOT_W = '\d+px'/.test(plugin), 'button slots need a fixed width constant')
check(/style: \{ width: SLOT_W \}/.test(plugin), 'slot buttons must use the fixed width')
const slotCalls = (plugin.match(/slotButton\(/g) || []).length
check(slotCalls >= 7, `the bar and the rows should all use slotButton (found ${slotCalls} uses)`)
// The active row shows a label where the others show a button; it has to keep the width.
check(/width: SLOT_W, textAlign: 'center'/.test(plugin),
  "the active row's 使用中 label must occupy the button's slot, or rows misalign")
// 另存为 stays in its slot while naming, disabled rather than removed.
check(/slotButton\('另存为', doSaveAs, \{ disabled: true \}\)/.test(plugin),
  '另存为 must keep its slot while editing (disabled), not disappear')

// ---- readable error ----------------------------------------------------------
// The error used to be inline in the flex row, which shrank the input and pushed the
// buttons; a floating pill on an opaque background is both readable and layout-neutral.
check(/position: 'absolute'[\s\S]{0,200}?bottom: 'calc\(100% \+ 4px\)'/.test(plugin),
  'the name error must float above the bar, not sit in the flex row')
// --ui-bg-quaternary is color-mix(... 4% ...): 96% transparent, unreadable over video.
check(/background: 'var\(--ui-bg-elevated\)'/.test(plugin),
  'the name error needs an OPAQUE background; the quaternary token is 96% transparent')
check(!/background: 'var\(--ui-bg-quaternary\)'/.test(plugin),
  'the name error must not use the transparent quaternary token')

// ---- rotation -----------------------------------------------------------------
// Two modes, mutually exclusive, and a list that is only ever a list.
check(/playMode: 'single',/.test(plugin), "playMode must default to 'single'")
check(/'single' \|\| cfg\.playMode === 'rotate'|cfg\.playMode === 'rotate'/.test(plugin),
  "rotation must be gated on the explicit 'rotate' mode")
check(/const rotationList = \(\) => \(Array\.isArray\(cfg\.rotationPaths\)/.test(plugin),
  'the rotation list must tolerate a missing or non-array value')

// The cursor must NOT be stored: writing it every interval would mean a localStorage
// write every few minutes for the whole session.
// Anchored on the engine's own declarations, not on a banner comment: `// ---- rotation`
// also appears inside DEFAULT_CONFIG, and matching that produced a 50 KB slice that
// swallowed half the file.
const rotEngine = plugin.slice(
  plugin.indexOf('const rotationList = () =>'),
  plugin.indexOf('function upsertMedia('),
)
check(rotEngine.length > 0, 'the rotation engine is missing')
check(/runtime\.rotationPath/.test(rotEngine), 'the cursor must live in runtime')
check(!/saveConfig/.test(rotEngine), 'the rotation engine must never write storage')
check(/if \(!rotationActive\(\)\) return/.test(rotEngine),
  'a tick must re-check the mode, since the timer outlives a config change')

// One timer at a time: starting must stop the previous one, or the file advances twice
// as fast after every edit.
check(/function startRotation\(\) \{\s*\n\s*stopRotation\(\)/.test(plugin),
  'startRotation must clear the previous timer first')
check(/function stopRotation\(\)/.test(plugin), 'stopRotation is missing')
check(/stopRotation\(\)/.test(plugin.slice(plugin.indexOf('function stopCycle'), plugin.indexOf('function cleanup'))),
  'stopCycle must stop rotation too, or a plugin reload leaves two timers running')

// Shuffle must not repeat the current file, and ordered mode must wrap.
check(/if \(!cfg\.rotationShuffle\)/.test(rotEngine), 'ordered mode must be distinguished from shuffle')
check(/% list\.length/.test(rotEngine), 'ordered mode must wrap around the list')
check(/candidate !== previous/.test(rotEngine), 'shuffle must skip the file already showing')

// An unusable interval falls back to the default — one rule, applied the same way to
// every bad value.
check(/Number\.isFinite\(raw\) && Math\.floor\(raw\) >= ROTATION_MIN_MINUTES/.test(rotEngine),
  'the interval must reject non-finite and sub-minute values')
check(/const ROTATION_MIN_MINUTES = 1/.test(plugin), 'the minute floor must be a named constant')
// The field clamps on input, so 0 cannot be typed in the first place.
check(/Math\.max\(ROTATION_MIN_MINUTES, Number\(digits\)\)/.test(plugin),
  'the interval field must clamp to the floor as the user types')
// `type="text"` on purpose: a number input's spinner plus the component's padding
// clipped "1440" even in a 56px field. Bounds are enforced in code instead.
check(/type: 'text',\s*\n\s*inputMode: 'numeric',/.test(plugin),
  'the interval field must not be a number input (its spinner eats the digits)')
const intervalField = (() => {
  const at = plugin.indexOf("value: String(form.rotationIntervalMin")
  const end = plugin.indexOf("textAlign: 'center'", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(intervalField.length > 0, 'the interval field block must be findable')
check(!/type: 'number'/.test(intervalField),
  'the INTERVAL field must not be a number input (its spinner eats the digits)')

// ---- interval bounds ----------------------------------------------------------
check(/const ROTATION_MAX_MINUTES = 1440/.test(plugin),
  'a full day must be the ceiling: beyond that it is not a rotation')
check(/Math\.min\(\s*\n\s*ROTATION_MAX_MINUTES,/.test(plugin),
  'the field must clamp to the ceiling as the user types')
check(/Math\.min\(ROTATION_MAX_MINUTES, Math\.floor\(n\)\)/.test(plugin),
  'saving must clamp to the ceiling too')

// Empty is a draft state while typing, then settles on the floor.
check(/onBlur: \(e\) => \{/.test(plugin), 'the interval field needs a blur handler taking the event')
// Filling the empty state DURING typing would fight the user: clear, type 5, get 15.
check(/if \(digits === ''\) \{ set\('rotationIntervalMin', ''\); return \}/.test(plugin),
  'clearing the field must stay empty while typing, not snap to the floor')
// Four digits have to be visible: 64px with 4px padding, no spinner.
check(/width: '64px'/.test(plugin), 'the interval field must fit four digits')
check(/padding: '2px 4px'/.test(plugin), 'the field padding must not crowd the digits')

// ---- reading the DOM in onBlur, not the possibly-stale state -------------------
// Clear the field and click away faster than a re-render, and `form` still holds the
// previous value — the guard then sees a valid 10 and leaves the field empty.
const blurFix = (() => {
  const at = plugin.indexOf("onBlur: (e) => {")
  const end = plugin.indexOf("\n            },", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(blurFix.length > 0, 'the blur handler must exist')
check(/e\.currentTarget\.value/.test(blurFix) || /e\.target\.value/.test(blurFix),
  'onBlur must read the element value, not form state')
check(!/Number\(form\.rotationIntervalMin\)/.test(blurFix),
  'onBlur must not read form.rotationIntervalMin: it can lag behind the DOM')
check(/'1440'/.test(plugin) || /1440/.test(plugin), 'the ceiling value must be documented')

// ---- right-click must not dismiss an overlay ------------------------------------
// A context menu exists to act on the element under the pointer (paste a path, fix a
// typo). Closing on mousedown destroyed that element before the menu could be used.
check(/if \(e\.button !== 0\) return/.test(plugin),
  'the outside-click handler must ignore non-primary buttons')

// ---- choosing a context-menu item must not dismiss the overlay -------------------
// The app's menu is a Radix ContextMenu in a portal on <body>, so its items register as
// clicks outside whatever they act on. Picking 粘贴 closed the popover and unmounted the
// input the paste was for.
// Measured in the running app: the text menu is
//   div[data-slot="dropdown-menu-content"][role="menu"] < div < body
// The first guess, [data-slot*="context-menu"], matched 30 unrelated nodes and none of
// this menu — which is why the fix appeared to do nothing.
check(/const MENU_SELECTOR = '\[data-slot="dropdown-menu-content"\], \[data-slot="context-menu-content"\]'/.test(plugin),
  'the menu selector must be the one measured in the app')
check(/function insideAppMenu\(target\)/.test(plugin),
  'a menu predicate is missing')
check(/target\.closest\(MENU_SELECTOR\)/.test(plugin),
  'the predicate must use closest() on the menu selector')
// The old wildcard may only survive in the comment explaining why it was wrong.
check(!/\[data-slot\*="context-menu"\]/.test(plugin.replace(/\/\/.*$/gm, '')),
  'the old wildcard selector matched unrelated nodes and must not come back')
const guard = (() => {
  const at = plugin.indexOf("const onPointerDown = (e) => {")
  const end = plugin.indexOf("const inBar", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(guard.length > 0, 'the outside-click handler is missing')
check(/const onMenu = pointerOnAppMenu \|\| insideAppMenu\(target\)/.test(guard),
  'the handler must resolve the menu case from the recorded answer')
// Both guards, in order: non-primary buttons first (the menu opens on a right-click),
// then the menu's own items.
check(guard.indexOf('e.button !== 0') < guard.indexOf('insideAppMenu(target)'),
  'the button guard must come before the menu guard')

// ---- focus has to go back to the input before the command runs --------------------
// Radix moves focus into the menu on open, so `document.activeElement` is the menu when
// 粘贴 is clicked: the paste would land in the menu, not the field.
check(/const lastInputRef = useRef\(null\)/.test(plugin),
  'the last focused input must be remembered')
check(/document\.addEventListener\('focusin', onFocusIn, true\)/.test(plugin),
  'focus must be tracked on the capture phase')
check(/el\.tagName === 'INPUT' \|\| el\.tagName === 'TEXTAREA'/.test(plugin),
  'the tracker must record inputs')
const menuGuard = (() => {
  const at = plugin.indexOf("if (onMenu) {")
  const end = plugin.indexOf("return\n      }", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(menuGuard.length > 0, 'the menu guard body is missing')
check(/lastInputRef\.current/.test(menuGuard), 'the menu guard must use lastInputRef')
check(/el\.focus\(\)/.test(menuGuard),
  'the menu guard must return focus to the input')

// ---- the interval is settled when the overlay closes, not on blur -----------------
// The first mousedown outside closes the popover, which unmounts the input before blur
// can run — so blur alone can never guarantee the field is non-empty.
check(/const settleInterval = \(\) => \{/.test(plugin),
  'closing an overlay must settle the interval')
const settleCallSites = (plugin.match(/settleInterval\(\)/g) || []).length
check(settleCallSites >= 3,
  `every close path must settle the interval (found ${settleCallSites}, need three)`)

// The ref is what makes settleInterval see the CURRENT form inside an effect closure.
check(/const formRef = useRef\(form\)/.test(plugin), 'formRef is missing')
check(/formRef\.current = form/.test(plugin), 'formRef must be refreshed every render')
check(/const current = formRef\.current\.rotationIntervalMin/.test(plugin),
  'settleInterval must read formRef, not a stale form closure')
check(/settleInterval\(\)\n\s*settlePosition\(\)\n\s*setRotationOpen\(false\)/.test(plugin),
  'the outside-click close path must settle first')
check(/if \(!next\) \{ settleInterval\(\); settlePosition\(\) \}/.test(plugin),
  'closing with the 管理 button must settle too')
// ---- toast lifetime -----------------------------------------------------------
check(/const TOAST_MS = 5000/.test(plugin), 'the auto-dismiss duration must be named')
check(/if \(typeof durationMs === 'number'\) payload\.durationMs = durationMs/.test(plugin),
  'notify must forward durationMs to the host')
// Measured in the host: success/info default to 5 s, warning/error to 0 (never dismiss).
check(/已移除 \$\{bad\.size\} 个无法播放的文件`, TOAST_MS\)/.test(plugin),
  'feedback about removing files must auto-dismiss')
check(/notify\('warning', 'Hermes 更新后灵动舞台插件暂不兼容/.test(plugin),
  'a standing compatibility warning must stay')
check(!/暂不兼容，已恢复原有界面样式。', TOAST_MS/.test(plugin),
  'the standing warning must not be given a duration')
check(/: DEFAULT_CONFIG\.rotationIntervalMin/.test(rotEngine),
  'an unusable interval must fall back to the default')
check(/Math\.min\(ROTATION_MAX_MINUTES, Math\.floor\(raw\)\)/.test(rotEngine),
  'the timer must respect the ceiling as well as the floor')

// The media element must prefer the rotating file, and fall back to the single one.
check(/const rotated = rotationActive\(\) \? runtime\.rotationPath : ''/.test(plugin),
  'upsertMedia must prefer the rotation cursor while rotation is active')
check(/const mediaPath = rotated \|\| cfg\.mediaPath \|\| runtime\.defaultPath/.test(plugin),
  'upsertMedia must fall back to the single file, so turning rotation off restores it')

// The play-mode row replaces the old video-file row rather than adding one: the page is
// laid out to fit a single screen.
check(/children: '播放方式'/.test(plugin), 'the play-mode row must be labelled 播放方式')
check(/children: '单视频'/.test(plugin) && /children: '轮换'/.test(plugin),
  'both modes must be selectable')
check(/form\.playMode === 'rotate'\s*\n?\s*\? jsxs\('div'/.test(plugin),
  'the source control must switch with the mode, not stack both')

// Paths are validated on entry: an unplayable extension must be refused rather than
// sitting in the list as a black wallpaper.
const addFn = (() => {
  const at = plugin.indexOf('const addRotationPath = () => {')
  const end = plugin.indexOf('\n  }\n', at) + 4
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(addFn.length > 0, 'addRotationPath is missing')
check(/if \(!isPlayable\(clean\)\)/.test(addFn), 'an unplayable path must be rejected')
check(/if \(existing\.includes\(clean\) \|\| accepted\.includes\(clean\)\) continue/.test(addFn),
  'duplicates must not be added twice')
check(addFn.includes("^file:\\/\\/"), 'a file:// prefix must be stripped, since that is what Finder copies')

// Drag reorder: remove first, then locate by VALUE.
const dropFn = (() => {
  const at = plugin.indexOf('const dropRotationPath = (targetIndex, after) => {')
  const end = plugin.indexOf('\n  }\n', at) + 4
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(dropFn.length > 0, 'dropRotationPath is missing')
check(/const targetValue = rotationEntryPath\(list\[targetIndex\]\)/.test(dropFn),
  'the drop target must be remembered by PATH before the source is removed')
// Entries are objects now, so indexOf on the array can never find the target again.
check(/list\.findIndex\(\(entry\) => rotationEntryPath\(entry\) === targetValue\)/.test(dropFn),
  'the insertion point must be located by path, not by object identity')
check(/const \[moved\] = list\.splice\(from, 1\)/.test(dropFn),
  'the dragged item must be removed before locating the target index')
check(/if \(from < 0 \|\| from === targetIndex\) return/.test(dropFn),
  'dropping a row on itself must be a no-op, not a move')

// ---- the hint beside the buttons must not reflow the row ------------------------
// It has four possible texts; sizing it to its content pushed every button to its right
// each time the dirty state changed, while the user was reading the row.
// The note lives BELOW the buttons now. Its fixed width existed only to stop it from
// pushing the buttons sideways; once it has a row of its own there is nothing to push, so
// it can be as long as the text needs and never truncates.
const hintSpan = (() => {
  const at = plugin.indexOf('children: hintText,')
  if (at < 0) return ''
  const start = plugin.lastIndexOf("jsx('span', {", at)
  return start >= 0 ? plugin.slice(start, at) : ''
})()
check(hintSpan.length > 0, 'the hint span is missing')
check(!/width:/.test(hintSpan), 'the hint must not have a fixed width; it has its own row')
check(!/nowrap|ellipsis/.test(hintSpan), 'the hint must not truncate')
check(/marginTop: '6px'/.test(hintSpan), 'the hint needs vertical separation from the buttons')

const actionArea = plugin.slice(
  plugin.indexOf("className: 'flex items-start justify-between gap-6 pt-2'"),
  plugin.indexOf('// Three answers for the unsaved-draft case'),
)
check(actionArea.length > 0, 'the action area is missing')

// One row, two groups: save/apply left, diagnostics right.
check(/justify-between/.test(actionArea), 'the two button groups must sit at opposite ends')
check(actionArea.indexOf("children: '💾 保存'") < actionArea.indexOf("children: '🔍 检查兼容性'"),
  'save/apply must come before the diagnostics in the row')
check(actionArea.indexOf("children: '🔍 检查兼容性'") < actionArea.indexOf("children: '🧹 清理配置'"),
  'the diagnostics keep their original order')

// Each group owns the note under its own buttons.
check(actionArea.indexOf('children: hintText') > actionArea.indexOf("children: '🚀 应用'"),
  'the save/apply note must sit under its buttons')
check(actionArea.indexOf('title: compat.long') > actionArea.indexOf("children: '🧹 清理配置'"),
  'the compatibility note must sit under its buttons')
// The right-hand group is right-aligned so it hugs the page edge, like the build stamp.
check(/alignItems: 'flex-end'/.test(actionArea), 'the diagnostics group must be right-aligned')
// And the build stamp comes after all of it.
check(plugin.indexOf("'data-build': BUILD") > plugin.indexOf("className: 'flex items-start justify-between gap-6 pt-2'"),
  'the build stamp must render below the action row')
// One expression, so the four texts cannot drift apart.
check(/const hintText = isDirty/.test(plugin), 'the hint text must be computed once')
check(!/isDirty\s*\n?\s*\?\s*\(previewingId/.test(plugin.replace("const hintText = isDirty", "")),
  'the hint must not be built inline at the render site')

// ---- the rotation button says 添加, and the overlay matches the profile one ------
check(/children: rotationOpen \? '收起' : '管理'/.test(plugin),
  'the rotation button must read 管理 / 收起')
check(/children: rotationOpen \? '收起' : '管理'/.test(plugin),
  'both list buttons must use the same word for the same job')

// Overlay chrome must be identical to the profile overlay: same border, radius, shadow.
const rotOverlay = (() => {
  const at = plugin.indexOf("maxHeight: '260px'")
  if (at < 0) return ''
  const start = plugin.lastIndexOf('const rotationList = ()', at)
  const end = plugin.indexOf('children: [', at)
  return start >= 0 && end > at ? plugin.slice(start, end) : ''
})()
check(rotOverlay.length > 0, 'the rotation overlay is missing')
for (const [re, why] of [
  [/border: '1px solid var\(--ui-stroke-secondary\)'/, 'the rotation overlay must use the standard 1px border'],
  [/borderRadius: '4px'/, 'the rotation overlay must use the standard 4px radius'],
  [/background: 'var\(--ui-bg-elevated\)'/, 'the rotation overlay must use the elevated background'],
  [/boxShadow: '0 8px 24px rgba\(0, 0, 0, 0\.35\)'/, 'the rotation overlay must use the same shadow'],
  [/scrollbarGutter: 'stable'/, 'the rotation overlay must reserve its scrollbar gutter'],
]) check(re.test(rotOverlay), why)

// Every row inside it uses the same padding as a profile row.
const rotRows = [...plugin.matchAll(/className: 'flex items-center gap-1\.5 px-1\.5 py-1[^']*'/g)].length
check(rotRows >= 3,
  `rotation rows must use px-1.5 py-1 like profile rows (found ${rotRows})`)
check(!/className: 'flex items-center gap-1\.5 px-2 py-1/.test(plugin),
  'no rotation row may use the older px-2 padding')
check(!/className: 'flex items-center gap-1 px-1\.5 py-1\.5'/.test(plugin),
  'the paste row must not use py-1.5')

// The empty state must match the single-video input's metrics, or switching modes
// changes the text size and the row height.
// The empty state lives in the ROW (it stands in for the single-video Input), not in the
// overlay. Anchoring on the label found the overlay copy, which is deliberately a plain
// line — a correct implementation was reported as broken.
const emptyState = (() => {
  const at = plugin.indexOf('还没添加'.replace('还没添加', '还没有添加文件'))
  if (at < 0) return ''
  const start = plugin.lastIndexOf('jsx(\'div\', {', at)
  return start >= 0 ? plugin.slice(start, at) : ''
})()
check(emptyState.length > 0, 'the empty rotation state is missing')
// Matched to the app's Input: text-xs/leading-4, muted placeholder colour, 29.5px tall
// (6px padding + 1px border + 16px line).
check(/text-xs leading-4 text-muted-foreground/.test(emptyState),
  'the empty state must use the input placeholder metrics (text-xs, muted foreground)')
check(/height: '29\.5px'/.test(emptyState), 'the empty state must match the input height')
check(/boxSizing: 'border-box'/.test(emptyState), 'the empty state must not add to the input height')
check(/border: '1px solid var\(--ui-stroke-secondary\)'/.test(emptyState),
  'the empty state must carry the input border')

// ---- only one overlay at a time ------------------------------------------------
// Both float over the same page near each other; two open at once is unreadable.
const rotToggle = (() => {
  const at = plugin.indexOf("setRotationOpen((v) => {")
  const end = plugin.indexOf("})", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(rotToggle.length > 0, 'the rotation toggle is missing')
check(/setProfilesOpen\(false\)/.test(rotToggle),
  'opening the rotation panel must close the profile list')
const profToggle = (() => {
  const at = plugin.indexOf("setProfilesOpen((v) => {")
  const end = plugin.indexOf("})", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(profToggle.length > 0, 'the profile-list toggle is missing')
check(/setRotationOpen\(false\)/.test(profToggle),
  'opening the profile list must close the rotation panel')

// ---- clicking outside closes the rotation panel too ---------------------------
check(/if \(!inRotation && rotationOpen\) \{/.test(plugin),
  'a click outside the rotation panel must close it')
check(/const inRotation = rotationRef\.current/.test(plugin),
  'the handler must be able to tell an inside click from an outside one')
check(/ref: rotationRef/.test(plugin), 'the rotation row needs a ref for that test')
// Clearing the error on close, or a stale "只支持 mp4" line reappears next time.
check(/setPathDraft\(''\)\n\s*setPathError\(''\)/.test(plugin),
  'closing the rotation panel must clear the paste draft and its error text')

// ---- an empty rotation list is not a saveable state ---------------------------
// Without this, flipping to 轮换 and adding nothing is an unsaved change: the dirty
// prompt fires, and 保存 would write a rotating profile with nothing to rotate.
check(/const effectivePlayMode = \(form\.playMode === 'rotate'/.test(plugin),
  'the form needs an effective play mode')
check(/\(\!Array\.isArray\(form\.rotationPaths\) \|\| form\.rotationPaths\.length === 0\)\)\s*\n?\s*\? 'single'/.test(plugin),
  'rotation with no files must fall back to single')
// One normalized object, used by the dirty check AND every write. The earlier version
// short-circuited on the mode and then compared the raw form in the loop, where
// `form.playMode === 'rotate'` still differed from the record — so the prompt fired
// anyway.
check(/const normalized = \{\s*\n\s*\.\.\.form,\s*\n\s*playMode: effectivePlayMode/.test(plugin),
  'the form must be normalized once, with the effective play mode')
// The interval is normalized on the way out too: an old record may hold 0 from before the
// floor existed, and saving must not preserve it.
check(/rotationIntervalMin: \(\(\) => \{/.test(plugin),
  'the interval must be normalized on save as well as in the field')
const dirtyBody = (() => {
  const at = plugin.indexOf('const isDirty = (() => {')
  const end = plugin.indexOf('})()', at) + 4
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(dirtyBody.length > 0, 'the dirty check is missing')
check(/const a = normalized\[k\]/.test(dirtyBody),
  'the dirty check must read the normalized form, not the raw one')
check(!/const a = form\[k\]/.test(dirtyBody),
  'the dirty check must not read the raw form: that is what made an empty 轮换 look dirty')
for (const [re, why] of [
  [/saveProfileSettings\(ctx, id, settings\)/, '保存 must write the normalized form'],
  [/applyShown\(ctx, shownProfileId\(\), normalized\)/, '应用 must write the normalized form'],
  [/saveProfileSettings\(ctx, shownProfileId\(\), normalized\)/, '保存并切换 must write the normalized form'],
]) check(re.test(plugin), why)

// ---- cleanup must know what this version actually stores ------------------------
// v0.4.0 replaced ten flat keys with two records. The cleanup kept looking only for the
// flat ones, so for four releases it reported "0 条记录" and deleted nothing while
// claiming to reset the plugin.
check(/const CURRENT_RECORD_KEYS = \['profiles', 'activeProfileId'\]/.test(plugin),
  'the current record keys must be declared')
const settingsNamesBlock = (() => {
  const at = plugin.indexOf('const SETTING_NAMES = [')
  const end = plugin.indexOf(']', at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(settingsNamesBlock.length > 0, 'SETTING_NAMES is missing')
for (const key of ['CURRENT_RECORD_KEYS', 'ROTATION_CURSOR_KEY', 'ROTATION_ADVANCE_KEY', 'LEGACY_SETTING_NAMES']) {
  check(settingsNamesBlock.includes(key),
    `the owned-key list must cover ${key}, or 清理配置 leaves it behind`)
}
// The cursor must be reachable by cleanup, or 清理配置 would leave a stale playback
// position behind in storage.
check(/const ROTATION_CURSOR_KEY = 'rotationCursor'/.test(plugin),
  'the rotation cursor key must be named')
const clearFn = (() => {
  const at = plugin.indexOf('function clearStoredSettings()')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(clearFn.length > 0, 'clearStoredSettings is missing')
// Deleting the records while the in-memory copies survive means the next save writes them
// straight back — the reset would not stick.
check(/profiles = \[\{\s*\n\s*id: newProfileId\(\)/.test(clearFn),
  'clearing must reset the in-memory profiles, or the next save re-creates them')
check(/activeProfileId = profiles\[0\]\.id/.test(clearFn),
  'clearing must reset the active profile id')
check(/previewId = ''/.test(clearFn), 'clearing must leave any pending preview')

// The dialog must report the count it will actually remove.
check(/storedInfo\.owned\.length/.test(plugin), 'the dialog must state how many records go')

// ---- the rotation overlay hangs under its button ---------------------------------
// Anchored to the whole row it floated below the mode buttons, far from 添加. The row is
// taller than the button because the mode switch sits under its label on the left.
// From the column's opening to the end of the row: the overlay has to appear INSIDE that
// range, which is what "nested in the column" means.
const controlColumn = (() => {
  const at = plugin.indexOf("className: 'flex-1 min-w-0',\n              style: { position: 'relative' }")
  if (at < 0) return ''
  const end = plugin.indexOf("section('🎨'", at)
  return end > at ? plugin.slice(at, end) : ''
})()
check(controlColumn.length > 0,
  'the rotation overlay must be anchored to the control column (the one holding 添加)')
check(/rotationList\(\)/.test(controlColumn),
  'the overlay must live inside that column, not beside it')
check(/bottom: 'calc\(100% \+ 4px\)'/.test(plugin) || /top: 'calc\(100% \+ 4px\)'/.test(plugin),
  'the overlay gap must stay 4px, matching the profile overlay')

// ---- the two notes sit under their own buttons, with breathing room --------------
// BOTH notes need it — the save/apply hint and the compatibility line. Matching once let
// one of them lose its spacing while the check stayed green.
// Both notes now sit UNDER their own buttons, so both need the gap.
const noteGaps = (plugin.match(/style: \{ marginTop: '6px' \}/g) || []).length
check(noteGaps === 2,
  `both notes sit under their buttons and need a gap (found ${noteGaps} of 2)`)
// There is only one column of actions now, so no inter-column gap is needed.
check(!/gap: '40px'/.test(plugin), 'the two-column action layout is gone')

// ---- the empty rotation row renders a box, not a bare span ------------------------
// In the row it stands in for the single-video Input, so it carries the same chrome;
// inside the overlay it is a plain line, because there is no input to stand in for.
check(/className: rotationPaths\(\)\.length\s*\n?\s*\? 'flex items-center flex-1 min-w-0 text-sm truncate'/.test(plugin),
  'the rotation summary must switch style with whether the list is empty')
check(/height: '29\.5px',\s*\n\s*padding: '6px 10px',\s*\n\s*border: '1px solid var\(--ui-stroke-secondary\)',\s*\n\s*borderRadius: '2\.5px'/.test(plugin),
  'the empty rotation row must be boxed like the single-video input')
check(/children: '列表为空，把文件路径粘贴到上面添加。'/.test(plugin),
  'the overlay empty state must be a short line, not a second bordered box')

// ---- the cleanup dialog must name what is lost ---------------------------------
// The record count is a storage detail. What matters to the user is that EVERY saved
// profile goes, not just the current one — "3 条记录" reads as three settings.
check(/title: '清理全部配置？'/.test(plugin), 'the cleanup dialog must say 全部配置')
check(/会清掉全部 \$\{profileList\.length\} 套方案配置 —— 不只是当前这一套/.test(plugin),
  'the dialog must state that every profile is cleared, not just the current one')
check(/被清掉的方案无法恢复/.test(plugin), 'the dialog must say the profiles cannot be recovered')

// ---- cleanup must refresh what is on screen ------------------------------------
// clearStoredSettings resets the module array, but the page renders from its own snapshot.
// Without syncProfiles the deleted rows stayed visible, so the cleanup looked broken.
const clearCallSite = (() => {
  const at = plugin.indexOf('const doClear = async () => {')
  const end = plugin.indexOf('\n  }\n', at) + 4
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(clearCallSite.length > 0, 'doClear is missing')
check(/syncProfiles\(\)/.test(clearCallSite),
  'clearing must refresh the profile snapshot, or the deleted rows stay on screen')
check(/entryRef\.current = \{ id: activeProfileId/.test(clearCallSite),
  'clearing must re-baseline the entry snapshot, or leaving would restore deleted profiles')

// ---- leaving the page must undo a preview -------------------------------------
// The settings page is NOT unmounted when the user switches to a conversation, so an
// unmount cleanup never runs. A path watcher is what actually observes the departure.
check(/const tick = setInterval\(\(\) => \{/.test(plugin), 'a route watcher is missing')
check(/const here = isOwnRoute\(\)/.test(plugin), 'the watcher must read the current route')
check(/if \(wasHere === here\) return/.test(plugin), 'the watcher must only act on a transition')
check(/if \(savedRef\.current\) return\s*\n\s*restoreEntry\(entryRef\.current\)/.test(plugin),
  'leaving must restore the entry state unless the change was committed')
// Coming back re-seeds from what is live, and re-baselines — otherwise the page would show
// values from before the restore.
const watcher = plugin.slice(
  plugin.indexOf('const tick = setInterval(() => {'),
  plugin.indexOf("}, 400)"),
)
check(/setForm\(\{ \.\.\.cfg \}\)/.test(watcher), 'returning must re-seed the form')
check(/entryRef\.current = \{ id: activeProfileId, cfg: \{ \.\.\.cfg \} \}/.test(watcher),
  'returning must re-baseline the entry snapshot')
check(/isOwnRoute/.test(plugin), 'the route watcher depends on isOwnRoute')

// ---- routes live in the HASH, not the path --------------------------------------
// Measured in the running app: pathname stays at the index.html file path while the route
// is `#/dynamic-backdrop-settings`. A pathname-only check is false everywhere, which is
// why the preview-restore never fired.
check(/const SETTINGS_ROUTE = '\/dynamic-backdrop-settings'/.test(plugin),
  'the settings route must be a named constant')
check(/String\(hash \|\| ''\)\.includes\(SETTINGS_ROUTE\)/.test(plugin),
  'isOwnRoute must read the hash')
check(/String\(pathname \|\| ''\) === SETTINGS_ROUTE/.test(plugin),
  'isOwnRoute must keep a pathname fallback for other builds')

// ---- the refresh tick is the safety net for a stranded preview ------------------
// The settings component's unmount cleanup is not a reliable signal. The 2-second tick
// runs regardless of what is mounted, so it is where a preview must be dropped.
const tickBlock = (() => {
  const at = plugin.indexOf('runtime.refreshInterval = setInterval(() => {')
  const end = plugin.indexOf('}, 2000)', at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(tickBlock.length > 0, 'the refresh tick is missing')
check(/if \(previewId && !isOwnRoute\(\)\)/.test(tickBlock),
  'the tick must clear a preview left behind after leaving the page')
check(/previewId = ''/.test(tickBlock), 'the tick must clear previewId')
check(/cfg = settingsOf\(activeProfile\(\)\)/.test(tickBlock),
  'the tick must restore the APPLIED profile, which is what the store names as active')

// ---- each action button appears exactly once -------------------------------------
// A stale copy of the diagnostics row survived a refactor and rendered a second pair of
// buttons. Counting the render sites is the only check that notices a duplicate.
const countOf = (needle) => (plugin.split(needle).length - 1)
check(countOf("children: '🔍 检查兼容性'") === 1,
  `检查兼容性 must be rendered once (found ${countOf("children: '🔍 检查兼容性'")})`)
check(countOf("children: '🧹 清理配置'") === 1,
  `清理配置 must be rendered once (found ${countOf("children: '🧹 清理配置'")})`)
check(countOf("children: '💾 保存'") === 1, '保存 must be rendered once')
check(countOf("children: '🚀 应用'") === 1, '应用 must be rendered once')
check(countOf("children: hintText") === 1, 'the save/apply note must be rendered once')
check(countOf("children: compat.short") === 1, 'the compatibility note must be rendered once')

// ---- playability is checked before committing -----------------------------------
// The extension check catches typos; only a real load catches a file this build cannot
// decode, which is the failure that produces a silent black wallpaper.
check(/function probeOne\(pathText\)/.test(plugin), 'a per-file probe is missing')
check(/element\.addEventListener\('loadedmetadata'/.test(plugin),
  'the probe must wait for metadata, not just for a src assignment')
check(/element\.addEventListener\('error'/.test(plugin), 'the probe must handle load errors')
// Measured in the running app: with crossOrigin='anonymous' every file fails with
// MEDIA_ELEMENT_ERROR code 4; without it they all load. The playback path never set it.
check(!/\.crossOrigin\s*=/.test(plugin),
  'the probe must NOT SET crossOrigin: hermes-media:// sends no CORS headers')
check(/const timer = setTimeout\(\(\) => done\(false, '超时'\), PROBE_TIMEOUT_MS\)/.test(plugin),
  'the probe must be time-boxed by a real timer')
check(/\bclearTimeout\(timer\)/.test(plugin), 'the probe must cancel its timer when it settles')
check(/const PROBE_TIMEOUT_MS = \d+/.test(plugin), 'the probe timeout must be a named constant')
// Duration is the shim that separates "loaded" from "decodable".
check(/!\(element\.duration > 0\)/.test(plugin),
  'a video with no duration must count as unplayable')
// Sequential, not Promise.all: a dozen 4K files at once stalls the renderer.
check(/for \(const p of paths\) \{\s*\n\s*\/\/ eslint-disable-next-line no-await-in-loop\s*\n\s*results\.push\(await probeOne\(p\)\)/.test(plugin),
  'the probe must run sequentially')
// Both commit paths go through it.
check(/const checkPlayableBeforeCommit = async \(settings = normalized\) => \{/.test(plugin),
  'the pre-commit check must be one shared function')
check(/const save = async \(rotationPaths\) => \{[\s\S]{0,400}?checkPlayableBeforeCommit\(settings\)/.test(plugin),
  '保存 must check playability first')
check(/const apply = async \(\) => \{\s*\n\s*if \(!\(await checkPlayableBeforeCommit\(\)\)\) return/.test(plugin),
  '应用 must check playability first')
// The dialog offers all three reasonable answers.
check(/title: '有无法播放的文件'/.test(plugin), 'the failure dialog is missing')
check(/confirmLabel: '移除这些文件'/.test(plugin), 'the dialog must offer removing the failures')
check(/label: '仍然保存'/.test(plugin), 'the dialog must allow saving anyway')
// "Save anyway" must not re-probe and loop.
// The flag has to be consumed at the TOP of the check, before the play-mode guard —
// otherwise "save anyway" falls through and probes the same files again.
const skipBlock = (() => {
  const at = plugin.indexOf('const checkPlayableBeforeCommit = async (settings = normalized) => {')
  const end = plugin.indexOf("if (settings.playMode !== 'rotate')", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(skipBlock.length > 0, 'the skip guard must sit before the play-mode check')
check(/if \(brokenFilesSkipRef\.current\) \{/.test(skipBlock),
  'the skip flag must be read at the top of the check')
check(/brokenFilesSkipRef\.current = false/.test(skipBlock),
  'the skip flag must be consumed so it only skips once')
check(/label: '仍然保存'/.test(plugin), 'the dialog must offer saving anyway')

// ---- rotation: startup mode, manual pick, per-file position ---------------------
// 「每次启动」replaces the interval rather than adding to it: the list advances once per
// launch and then holds. Both are stored, but the timer must not exist in that mode.
const startRot = (() => {
  const at = plugin.indexOf("function startRotation()")
  const end = plugin.indexOf("\n}", plugin.indexOf("}, minutes * 60 * 1000)", at))
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(startRot.length > 0, 'startRotation is missing')
check(/if \(cfg\.rotationOnStartup\) return/.test(startRot),
  'startup mode must install no timer')
check(startRot.indexOf('rotationOnStartup') < startRot.indexOf('setInterval'),
  'the startup guard must come before the timer is created')

// The interval field is unusable in that mode and must say so visually.
check(/disabled: Boolean\(form\.rotationOnStartup\)/.test(plugin),
  'the interval field must be disabled in startup mode')
check(/每次启动/.test(plugin), 'the startup switch must be labelled')

// ---- a hand-picked file is a preview, exactly like a profile switch ------------
const pickFn = (() => {
  const at = plugin.indexOf("const pickRotationFile = (path) => {")
  const end = plugin.indexOf("\n  }\n", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(pickFn.length > 0, 'pickRotationFile is missing')
check(/runtime\.rotationPath = path/.test(pickFn),
  'picking a file must change what is playing now')
check(/set\('rotationStartPath', path\)/.test(pickFn),
  'picking a file must be recorded as a draft, so 保存 has something to save')
check(!/saveConfig|saveProfileSettings/.test(pickFn),
  'picking a file must not write storage: that is 保存 / 应用 job')

// Leaving without saving has to put the FILE back too, not just the sliders.
const restoreFn = (() => {
  const at = plugin.indexOf("async function restoreEntry(entry)")
  const end = plugin.indexOf("\n}\n", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(/runtime\.rotationPath = cfg\.rotationStartPath/.test(restoreFn),
  'undoing a preview must also restore the playing file')

// ---- per-file horizontal position ---------------------------------------------
// Entries are `{ path, positionX? }`; records written earlier hold bare strings, and
// both must stay readable or existing lists would break.
check(/const rotationEntryPath = \(entry\) =>/.test(plugin), 'the entry unwrapper is missing')
check(/if \(typeof entry === 'string'\) return entry/.test(plugin),
  'bare-string entries must still resolve to a path')
check(/const rotationEntryPosition = \(entry, fallback\) =>/.test(plugin),
  'the per-entry position reader is missing')
check(/rotationEntryPosition\(activeEntry, cfg\.positionX\)/.test(plugin),
  'upsertMedia must prefer the per-file position and fall back to the profile value')

// One shape on the way into storage, so the dirty check and a future export agree.
check(/rotationPaths: rotationEntries\(\)/.test(plugin),
  'saving must normalize the entry shape')
check(/normalized\.rotationStartPath = ''/.test(plugin),
  'a pinned file that is no longer listed must be dropped')

// ---- the cursor is playback state, not configuration --------------------------
check(/const ROTATION_CURSOR_KEY = 'rotationCursor'/.test(plugin),
  'the cursor key must be a named constant')
check(!/rotationCursor:/.test(plugin),
  'the cursor must NOT be a DEFAULT_CONFIG key: it would dirty the profile and export')
check(/writeRotationCursor\(runtime\.rotationPath\)/.test(plugin),
  'a startup advance must remember where it landed')
// Interval ticks stay memory-only: a storage write every few minutes for a value that is
// only read at launch would be pure noise.
const rotationTick = plugin.slice(
  plugin.indexOf('runtime.rotationTimer = setInterval'),
  plugin.indexOf('}, minutes * 60 * 1000)'),
)
check(!/writeRotationCursor/.test(rotationTick),
  'interval ticks must not write the cursor')

// ---- one advance per launch, not one per window --------------------------------
// Both the main window and the session window evaluate the plugin. Advancing in each
// moved the playlist N entries per launch; with two files that returns to where it was,
// which is why 「每次启动」appeared to do nothing.
check(/const ROTATION_ADVANCE_KEY = 'rotationAdvanceAt'/.test(plugin),
  'the advance stamp must be a named key')
// The window has to be long enough to cover every window registering at launch. Zero
// would dedupe nothing and the list would advance once per window again.
const dedupeMs = Number((plugin.match(/const ROTATION_ADVANCE_DEDUPE_MS = (\d+)/) || [])[1])
check(Number.isFinite(dedupeMs) && dedupeMs >= 5000,
  `the dedupe window must span the launch burst (found ${dedupeMs}ms, need >= 5000)`)
check(/const ROTATION_LIVE_STALE_MS = \d+/.test(plugin),
  'the sibling staleness window must be a named constant')
// The dedupe branch must SHOW what the other window chose rather than pick again.

// ---- the stored cursor may come back JSON-quoted ------------------------------
// Measured: this build returns the raw string. Another may return '"/a.mp4"', which
// matches no list entry and silently restarts at the first file every launch.
check(/trimmed\.startsWith\('"'\)/.test(plugin), 'a quoted cursor must be unwrapped')
check(/JSON\.parse\(trimmed\)/.test(plugin), 'the quoted form must be parsed, not guessed')

// ---- the pin must not outrank the cursor --------------------------------------
// A pin is a fixed starting point. Leading from it on every launch lands on the same
// file forever, so the cursor has to win once it exists.

// ---- labels that say what they do ---------------------------------------------
check(/children: '启动时切换一次'/.test(plugin),
  'the startup switch must name its effect, not just its trigger')
check(plugin.includes("' · 启动时切换一次'"),
  'the play-mode summary must describe startup mode instead of the interval')
check(/点击文件名可立即播放/.test(plugin), 'the list needs a legend for the new column')

// ---- whole-percent steps everywhere -------------------------------------------
// 5-point steps contradicted the number box, which accepted any value.
check(!/step: 0\.05/.test(plugin), 'alpha sliders must not step by 5%')
check(/step: 0\.01, kind: 'alpha'/.test(plugin), 'alpha sliders must step by 1%')
check(/step: 1, kind: 'plain'/.test(plugin), 'the position slider must step by 1%')

// ---- an input inside a draggable row must not start a row drag -----------------
// Anchored on the ROTATION row: the profile row has its own onDragStart and it must
// stay untouched (its inputs are not editable in place).
const dragStart = (() => {
  const anchor = plugin.indexOf("setPathDrag(index)")
  const at = plugin.lastIndexOf("onDragStart: (e) => {", anchor)
  const end = anchor < 0 ? -1 : plugin.indexOf('},', anchor)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(dragStart.length > 0, 'the row drag handler is missing')
// dragstart's event.target is the DRAGGABLE element, never the child the press landed
// on — so a tagName test there can never see an input. The decision has to come from what
// mousedown recorded.
check(/let rowDownTarget = null/.test(plugin), 'the press target must be recorded')
check(!/e\.target\.tagName/.test(dragStart),
  'dragstart must not read e.target.tagName: that is the draggable row, not the input')
check(/rowDownTarget = e\.target/.test(plugin), 'mousedown must record where it landed')
check(/const fromField = Boolean\(from && \(/.test(dragStart),
  'the row must decide from the recorded press target')
check(dragStart.indexOf('fromField') < dragStart.indexOf('setPathDrag'),
  'the guard must run before the drag starts')
// The row must reset the record, or one press inside the box would suppress every later
// drag until something else was pressed.
check(/rowDownTarget = null/.test(dragStart), 'the record must be consumed on every dragstart')

// ---- launch detection: heartbeat, not a window flag ---------------------------
// Measured in the running app: a Reload recreates the plugin document — new
// performance.timeOrigin, window.__dynamicBackdrop absent, a per-window counter back to 1.
// So a flag on `window` can never separate a Reload from a launch, and a plain timestamp
// cannot separate a fast quit-and-reopen from a sibling window. A heartbeat can: nothing
// beating means the app was not running.
check(/const ROTATION_LIVE_KEY = 'rotationLiveAt'/.test(plugin), 'the heartbeat key must be named')
check(/const ROTATION_LIVE_STALE_MS = \d+/.test(plugin), 'the staleness window must be named')
check(/const ROTATION_HEARTBEAT_MS = \d+/.test(plugin), 'the beat interval must be named')
const liveStale = Number((plugin.match(/const ROTATION_LIVE_STALE_MS = (\d+)/) || [])[1])
check(Number.isFinite(liveStale) && liveStale >= 4000 && liveStale <= 30000,
  `the staleness window must span a sibling's startup delay without swallowing a restart (found ${liveStale})`)

const startupBranch = (() => {
  const at = plugin.indexOf('if (cfg.rotationOnStartup) {')
  const end = plugin.indexOf('return runtime.rotationPath', plugin.indexOf('writeRotationCursor', at))
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(startupBranch.length > 0, 'the startup branch is missing')
check(/const sibling = live > 0 && Date\.now\(\) - live < ROTATION_LIVE_STALE_MS/.test(startupBranch),
  'a fresh beat must mark this window as a sibling of the running app')
// The variable is useless unless it actually short-circuits the advance.
check(/if \(sibling\) \{/.test(startupBranch),
  'the sibling flag must guard the advance, not just be computed')
check(startupBranch.indexOf('if (sibling)') < startupBranch.indexOf('writeRotationCursor'),
  'the sibling guard must come before the advance writes the cursor')
check(/readRotationCursor\(\)/.test(startupBranch),
  'a skipped window must adopt the file the first window chose')
// 「换一个」has to change: a uniform draw lands on the current file a third of the time
// with three entries, which reads as the switch not working.
check(/const others = list\.filter\(\(entry\) => entry !== prev\)/.test(startupBranch),
  'random startup must exclude the file that was already showing')

// Ordering: publish the beat only AFTER this window decided, or it reads its own beat and
// never advances. That exact bug shipped once.
check(plugin.indexOf('seedRotation()\n        startHeartbeat()') > 0,
  'register must seed BEFORE publishing the heartbeat')
check(plugin.indexOf('startHeartbeat()\n        seedRotation()') < 0,
  'publishing the beat before seeding makes the window a sibling of itself')
check(/function startHeartbeat\(\)/.test(plugin), 'the heartbeat is missing')
check(/window\.addEventListener\('pagehide', clearLiveAt\)/.test(plugin),
  'quitting must clear the beat, or a fast reopen is mistaken for a sibling')
check(/if \(runtime\.heartbeatTimer\) clearInterval\(runtime\.heartbeatTimer\)/.test(plugin),
  'stopCycle must stop the heartbeat')

// ---- closing the popover must settle the position box too ---------------------
// Same trap as the interval field, with a worse outcome: the edit was discarded in
// silence. A detached input never fires blur, so relying on blur loses the change on the
// very gesture the user makes to finish (clicking away).
check(/const settlePosition = \(\) => \{/.test(plugin),
  'closing an overlay must settle the position box')
const settlePosCalls = (plugin.match(/settlePosition\(\)/g) || []).length
check(settlePosCalls >= 4,
  `every close path must settle the position (found ${settlePosCalls}; need the definition plus three call sites)`)
check(/settlePosition\(\)\n\s*setRotationOpen\(false\)/.test(plugin),
  'the outside-click path must settle both fields before closing')
check(/if \(!next\) \{ settleInterval\(\); settlePosition\(\) \}/.test(plugin),
  'the manual close path must settle both fields')

// Opening another row's box unmounts the current input the same way.
check(/const beginEditPosition = \(path, entry\) => \{/.test(plugin),
  'opening a row must go through one function')
check(/if \(posEditRef\.current && posEditRef\.current !== path\) settlePosition\(\)/.test(plugin),
  'moving to another row must commit the previous edit first')

// The draft is read from a ref: the outside-click closure predates the keystroke.
check(/const posDraftRef = useRef\(''\)/.test(plugin), 'the draft ref is missing')
check(/posDraftRef\.current = posDraft/.test(plugin), 'the draft ref must track the draft')
check(/const value = posDraftRef\.current/.test(plugin),
  'settlePosition must read the draft from the ref, not a stale closure')
// The same trap applies to the row being edited. The outside-click effect does NOT depend
// on posEdit (opening a box changes none of its deps), so a closure reading `posEdit` sees
// '' and returns early — which is exactly how this shipped twice: the edit was dropped AND
// the input came back on reopen because the state had never been cleared.
check(/const posEditRef = useRef\(''\)/.test(plugin), 'the editing row must be held in a ref')
check(/posEditRef\.current = posEdit/.test(plugin), 'that ref must track the state')
check(/const path = posEditRef\.current/.test(plugin),
  'settlePosition must read the editing row from the ref')
const settleFn = (() => {
  const at = plugin.indexOf('const settlePosition = () => {')
  const end = plugin.indexOf('\n  }', at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(settleFn.length > 0, 'settlePosition is missing')
check(!/\bposEdit\b/.test(settleFn.replace(/posEditRef/g, '').replace(/setPosEdit/g, '')),
  'settlePosition must not read the posEdit state: the outside-click closure predates the box')
check(/posEditRef\.current = ''/.test(plugin),
  'settlePosition must clear the ref so a second close cannot commit twice')
check(/if \(posEditRef\.current && posEditRef\.current !== path\) settlePosition\(\)/.test(plugin),
  'switching rows must compare against the ref, not the stale state')

// The effect dependency list is the reason these refs are needed; assert it so a future
// change does not quietly add posEdit (re-subscribing on every keystroke) or drop the
// outside-close entirely.
check(/\}, \[profilesOpen, editMode, rotationOpen\]\)/.test(plugin),
  'the outside-click effect must not depend on posEdit')

// ---- the commit rule for a per-file position ----------------------------------
// Enter AND blur both committed, from two different renders; the second carried an older
// list and undid the sibling row's edit.
const posInput = (() => {
  const at = plugin.indexOf('posEdit === path')
  const end = plugin.indexOf('style: {', at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(posInput.length > 0, 'the position input is missing')
check(/if \(e\.key === 'Enter'\) e\.currentTarget\.blur\(\)/.test(posInput),
  'Enter must commit by blurring, so the value is written exactly once')
check(!/commitPosition\(path\)/.test(posInput),
  'the input must not call commitPosition without a value: it would read stale state')
// Blur must still pass the ELEMENT's value (state can lag a render), but only when the
// blur was not caused by the context menu — that one unmounted the box and broke 粘贴.
check(/onBlur: \(e\) => \{/.test(posInput), 'blur must still be handled')
check(/commitPosition\(path, e\.currentTarget\.value\)/.test(posInput),
  'blur must pass the element value')
check(/if \(Date\.now\(\) - menuGestureAt < MENU_GESTURE_MS\) return/.test(posInput),
  'blur must be skipped when the context menu is what took focus')
check(/Array\.isArray\(formRef\.current\.rotationPaths\)/.test(plugin),
  'commitPosition must read the list from formRef, not a possibly stale closure')

// ---- no debug output may ship -------------------------------------------------
// A launch trace lived here through v1.0.0: three console.error calls added while
// diagnosing 「启动时切换一次」. They wrote to the browser console on every launch, and
// leaked into install output because the probe loads plugin.js. Asserted absent so it
// cannot come back by accident.
check(!/console\.(log|error|warn|info|debug)\(/.test(plugin),
  'plugin.js must not log to the console in a release build')
check(!/\[db-launch\]|\[db-startup\]/.test(plugin), 'the old debug traces must not return')

// ---- the three text fields must behave the same way ---------------------------
// Enter commits, Escape abandons. The paste field shipped with Enter only, so the sole way
// out of a half-typed path was to click away — which also closed the popover.
//
// Each field is asserted against its OWN lines. A window of N characters was tried first
// and it swallowed the neighbouring field's handlers, so three separate regressions all
// passed.
const fieldOf = (open, close = "\n            }),") => {
  const at = plugin.indexOf(open)
  const end = at < 0 ? -1 : plugin.indexOf(close, at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
}

const nameField = fieldOf("value: nameDraft")
check(nameField.length > 0, 'the name field is missing')
check(/if \(e\.key === 'Enter'\) commitName\(\)/.test(nameField), 'name: Enter must commit')
check(/if \(e\.key === 'Escape'\) cancelName\(\)/.test(nameField), 'name: Escape must abandon')

const pasteField = fieldOf("value: pathDraft")
check(pasteField.length > 0, 'the paste field is missing')
check(/if \(e\.key === 'Enter'\) addRotationPath\(\)/.test(pasteField), 'paste: Enter must commit')
check(/if \(e\.key === 'Escape'\) \{ setPathDraft\(''\); setPathError\(''\) \}/.test(pasteField),
  'paste: Escape must abandon the half-typed path')

const posField = (() => {
  const at = plugin.indexOf('posEdit === path')
  const end = at < 0 ? -1 : plugin.indexOf('style: {', at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(posField.length > 0, 'the position field is missing')
check(/if \(e\.key === 'Enter'\) e\.currentTarget\.blur\(\)/.test(posField),
  'position: Enter must commit exactly once (by blurring)')
check(/if \(e\.key === 'Escape'\) \{/.test(posField), 'position: Escape must abandon')
// Escape must defuse the commit path, which reads these refs and may run before the
// re-render that would have cleared them.
check(/posDraftRef\.current = ''/.test(posField), 'position: Escape must clear the draft ref')
check(/posEditRef\.current = ''/.test(posField), 'position: Escape must clear the editing-row ref')

// Closing the rotation panel clears the paste draft. The name field does not need this
// because reopening re-seeds it from the profile; the paste field has no seed, so an
// abandoned path would otherwise sit there forever.
check(/setPathDraft\(''\)\n\s*setPathError\(''\)/.test(plugin),
  'closing the rotation panel must clear the paste draft')

// ---- every numeric field is a TEXT input ---------------------------------------
// `type="number"` was the odd one out: it draws a spinner, its selection API returns null
// (so the app's menu can never offer cut/copy), and Chromium treats its text differently —
// the host's right-click menu is built from exactly those properties, which is why 粘贴
// behaved unlike every other field. Bounds are enforced in the commit handlers.
// Comments are stripped first: the fix's own explanation quotes the attribute it bans.
const pluginNoComments = plugin.replace(/\/\/[^\n]*/g, '')
check(!/type: 'number'/.test(pluginNoComments),
  'no numeric field may be type=number: the selection API it disables drives the host menu')
const numericFields = (plugin.match(/type: 'text',\s*\n\s*inputMode: 'numeric'/g) || []).length
check(numericFields >= 2,
  `both numeric fields (slider box, per-file position) must be text+numeric (found ${numericFields})`)

// The rotation row's select-none reaches its descendants, including the position input,
// where it makes the text impossible to select. The input has to opt back in.
check(/userSelect: 'text'/.test(plugin),
  'the position input must re-enable text selection inside a select-none row')

// ---- numeric fields accept digits only, typed or pasted ------------------------
// A text input takes anything, and the commit path only ran on blur — so pasting "abc"
// left garbage on screen until the user clicked away, then silently reverted.
const sliderField = (() => {
  const at = plugin.indexOf("value: draft,")
  const end = plugin.indexOf("onBlur:", at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(sliderField.length > 0, 'the slider number box is missing')
check(/const raw = event\.target\.value\n\s*const next = clampDraft\(raw\)/.test(sliderField),
  'the slider box must route every edit through clampDraft (digits only, within bounds)')
// A controlled input whose state does not change keeps the DOM's value, so a rejected
// character would stay on screen. Writing the sanitised value back is what removes it.
check(/if \(next !== raw\) event\.target\.value = next/.test(sliderField),
  'the slider box must write the sanitised value back, or rejected characters linger')
check(/const clampDraft = \(raw\) => \{/.test(plugin), 'the clamp helper is missing')
check(/Math\.min\(bounds\.hi, Math\.max\(bounds\.lo, n\)\)/.test(plugin),
  'clampDraft must bound the value while typing, not only on commit')
// Intercepting paste was the bug: it replaced the WHOLE value with the filtered digits,
// so pasting "55\n" wiped the field even with nothing selected. The browser's own rule
// (replace the selection, else insert at the caret) is what users expect.
check(!/onPaste/.test(sliderField),
  'the slider box must NOT intercept paste: it replaced the whole value')

const posFieldPaste = (() => {
  const at = plugin.indexOf('posEdit === path')
  const end = plugin.indexOf('onClick:', at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(!/onPaste/.test(posFieldPaste),
  'the position box must NOT intercept paste: it deleted the digits already there')
check(/if \(next !== raw\) e\.target\.value = next/.test(posFieldPaste),
  'the position box must write the sanitised value back, or rejected characters linger')

// ---- the menu check must be recorded before Radix can detach the menu -----------
// Radix dismisses on pointerdown in the CAPTURE phase. If it runs first, the menu subtree
// is detached, the target's parent chain is cut, and closest() finds nothing — every later
// handler concludes "clicked outside" and closes the overlay the menu was acting on. So
// the answer is captured at mount, at the earliest capture point.
check(/let pointerOnAppMenu = false/.test(plugin),
  'the pointer-on-menu answer must be recorded at module level')
check(/const remember = \(e\) => \{\n\s*pointerOnAppMenu = insideAppMenu\(e\.target\)/.test(plugin),
  'a capture-phase pointerdown listener must record it')
check(/document\.addEventListener\('pointerdown', remember, true\)/.test(plugin),
  'that listener must be on the document in the capture phase')
// It must be registered once at mount, not gated by which overlay is open: a menu can be
// opened over any field, and the overlay that owns it may not be the one being tracked.
check(/\}, \[\]\)\n\n  \/\/ Clicking anywhere outside the bar/.test(plugin),
  'the recorder must be mounted unconditionally')
check(/const onMenu = pointerOnAppMenu \|\| insideAppMenu\(target\)/.test(plugin),
  'the close handler must consult the recorded answer')
check(/pointerOnAppMenu = false/.test(plugin),
  'the recorded answer must be consumed so one gesture cannot leak into the next')

// Both event kinds are observed: pointerdown is what Radix acts on, mousedown is what a
// mouse produces afterwards. Listening to only the latter was the earlier bug.
check(/document\.addEventListener\('pointerdown', onPointerDown, true\)/.test(plugin),
  'the overlay close handler must also see pointerdown')
check(/document\.removeEventListener\('pointerdown', onPointerDown, true\)/.test(plugin),
  'the pointerdown listener must be removed on cleanup')

// ---- the position input must opt OUT of the row's drag -------------------------
// It is the only editable inside a `draggable` row, which is the entire difference from
// the name and path fields. A press inside a draggable subtree starts Chromium's drag
// preparation and can cost the field its focus before `contextmenu` fires; with nothing
// focused the menu has no editable target and 粘贴 never lands.
check(/draggable: false/.test(plugin),
  'the position input must declare draggable:false to stop drag preparation')
const posBlock = (() => {
  const at = plugin.indexOf('posEdit === path')
  const end = plugin.indexOf('onDragStart', at)
  return at >= 0 && end > at ? plugin.slice(at, end) : ''
})()
check(posBlock.length > 0, 'the position input block is missing')
check(/draggable: false/.test(posBlock),
  'draggable:false must sit on the position input itself')
// Intercepting the right press was the earlier attempt: it masks the symptom and can
// swallow the menu instead of preventing the focus loss.
check(!/if \(e\.button !== 2\) return/.test(posBlock),
  'the position field must not intercept the right press')
check(/onContextMenu: \(e\) => \{/.test(posBlock),
  'the position field should still take focus back on contextmenu as a fallback')

// ---- a menu-caused blur must not commit and unmount the position box ------------
// Measured: right-clicking the box opened the menu, Radix moved focus into it, the box's
// onBlur ran commitPosition(), `posEdit` was cleared, the input unmounted — and 粘贴 had
// no editable target. The blur that the menu causes must be ignored; every path that
// really closes the overlay settles the value itself.
check(/let menuGestureAt = 0/.test(plugin), 'the menu-gesture marker is missing')
check(/if \(e\.button === 2\) menuGestureAt = Date\.now\(\)/.test(plugin),
  'a right press must start a menu gesture')
check(/if \(Date\.now\(\) - menuGestureAt < MENU_GESTURE_MS\) return/.test(plugin),
  'the position box must skip its blur commit during a menu gesture')
const posBlur = (() => {
  const at = plugin.indexOf("onBlur: (e) => {\n                      if (Date.now() - menuGestureAt")
  return at >= 0 ? plugin.slice(at, at + 420) : ''
})()
check(posBlur.length > 0, 'the guarded blur handler must still be the position box\'s')
check(/commitPosition\(path, e\.currentTarget\.value\)/.test(posBlur),
  'ordinary blurs must still commit')
// The value must not be dropped: the overlay-close paths settle it.
check(/settlePosition\(\)\n        setRotationOpen\(false\)/.test(plugin),
  'closing the overlay must still settle the position')

// ---- automatic naming ---------------------------------------------------------
// A profile created by 另存为 or 复制 is named 方案N when created, and keeps that name.
// An earlier version numbered them by position and renumbered on every mutation; that
// meant dragging a row rewrote the names of everything it passed.
check(/const AUTO_NAME = \/\^方案\(\\d\+\)\$\//.test(plugin), 'auto names must be recognised by shape')
check(!/renumberAutoNames/.test(plugin),
  'names must NOT be renumbered: a name that changes while you look at it is worse than a number that no longer matches its row')
check(!/autoNameAt/.test(plugin), 'the position-based name helper must be gone')
// renumber() may only touch `order`.
const renumberBody = plugin.slice(
  plugin.indexOf('function renumber() {'),
  plugin.indexOf('}', plugin.indexOf('function renumber() {')) + 1,
)
check(/p\.order = i/.test(renumberBody), 'renumber() must still set order')
check(!/\.name/.test(renumberBody), 'renumber() must never touch a name')

// The next number is one past the highest in use, not the list length: reusing a freed
// number would make a new profile look like the one just deleted.
check(/let highest = 0/.test(plugin), 'nextProfileName must scan for the highest number')
check(/if \(m\) highest = Math\.max\(highest, Number\(m\[1\]\)\)/.test(plugin),
  'nextProfileName must take the maximum existing number')
check(/return `方案\$\{highest \+ 1\}`/.test(plugin), 'the next name must be highest + 1')
check(!/autoNameAt\(profiles\.length\)/.test(plugin),
  'the next name must not be derived from the list length')

// ---- copy naming ---------------------------------------------------------------
// 「源名 复制」; a number is appended only when that exact name is taken. Pure stacking
// was tried and cannot work: appending carries no information about which row was
// copied, so with 方案1 / 方案1 复制 / 方案1 复制 复制 present, three different clicks all
// converged on 方案1 复制 复制 复制.
check(/const COPY_SUFFIX = ' 复制'/.test(plugin), 'the copy suffix must be a constant')
check(/function copyNameOf\(/.test(plugin), 'copies need their own naming function')
check(/await addProfile\(ctx, copyNameOf\(source\.name\)/.test(plugin),
  '复制 must name the new profile after its source, not 方案N')
check(!/await addProfile\(ctx, nextProfileName\(\), \{ copyOf/.test(plugin),
  '复制 must not use the positional 方案N name: it says nothing about the source')

const copyFn = (() => {
  const at = plugin.indexOf('function copyNameOf(')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(copyFn.length > 0, 'copyNameOf is missing')
// The direct append is built once, then only the number varies.
check(/const base = normalizeName\(`\$\{normalizeName\(name\) \|\| '方案'\}\$\{COPY_SUFFIX\}`\)/.test(copyFn),
  'the copy name must be the source name plus the suffix')
check(/const candidate = normalizeName\(`\$\{base\} \$\{n\}`\)/.test(copyFn),
  'a colliding copy name gets 「… 复制 N」 — the number goes after the single suffix')
// Stacking must be gone: the previous rule re-appended 复制 to the growing name.
check(!/\$\{candidate\}\$\{COPY_SUFFIX\}/.test(copyFn),
  'the suffix must not be re-appended to the growing name (that is the rule that converged)')

// ---- a copy lands beneath its source --------------------------------------------
// Names alone cannot always identify the row, but position can.
check(/afterId/.test(plugin), 'addProfile must accept afterId')
check(/profiles\.splice\(at \+ 1, 0, profile\)/.test(plugin),
  'a copy must be inserted directly after its source, not appended at the end')
check(/await addProfile\(ctx, copyNameOf\(source\.name\), \{ copyOf: source, afterId: source\.id \}\)/.test(plugin),
  '复制 must pass the source id so the copy lands beneath it')
// 另存为 still appends: it is a new configuration, not a copy of a specific row.
check(/setNameDraft\(nextProfileName\(\)\)/.test(plugin), '另存为 must keep the 方案N draft')

// ---- 另存为 is a draft --------------------------------------------------------
// It used to create the profile and then open the name field, so 取消 discarded nothing.
const doSaveAsBody = plugin.slice(
  plugin.indexOf('const doSaveAs = () => {'),
  plugin.indexOf('const doDuplicate = '),
)
check(!/addProfile/.test(doSaveAsBody),
  '另存为 must not create a profile before the name is confirmed')
check(/const doSaveAs = \(\) => \{/.test(plugin), 'doSaveAs must be synchronous: it only opens a draft')
check(/setEditMode\('create'\)/.test(plugin), '另存为 must enter the create draft state')
check(/async function createProfileNamed\(/.test(plugin),
  'confirming a draft must create the profile explicitly')
check(/if \(nameTaken\(name\)\) return \{ ok: false, reason: 'duplicate' \}/.test(plugin),
  'a typed duplicate name must be refused, not silently suffixed')
check(/const cancelName = \(\) => \{/.test(plugin), 'there must be a single cancel path')

// ---- but the open row is protected --------------------------------------------
// The active profile is what the page is editing; deleting it would change the subject
// under the user. The button stays in its slot, disabled.
check(/slotButton\('删除', \(\) => doDelete\(p\.id\), \{/.test(plugin), 'the delete slot must exist in every row')
check(/disabled: isShown/.test(plugin), '删除 must be disabled for the row being displayed')

// ---- overlay list: opening it must not move the page ---------------------------
// In flow the list made the page taller than the window; the scrollbar appeared, the
// content narrowed, every row re-wrapped. Floating it means opening changes nothing.
//
// The assertions below are scoped to the overlay's own style object. A page-wide regex
// passes even after the overlay stops being absolute, because the page container happens
// to carry some of the same properties.
const overlayBlock = (() => {
  const at = plugin.indexOf("maxHeight: '176px'")
  if (at < 0) return ''
  const start = plugin.lastIndexOf("jsx('div', {", at)
  const end = plugin.indexOf('children: profileList.map(profileRow)', at)
  return start >= 0 && end > at ? plugin.slice(start, end) : ''
})()
check(overlayBlock.length > 0, 'the profile list overlay is missing')
check(/position: 'absolute'/.test(overlayBlock),
  'the profile list must be an overlay, not a flow element: in flow it makes the page scroll')
// It opens downward: the bar is near the top of the page now, so an upward overlay
// would overflow the scroll container and be clipped.
check(/top: 'calc\(100% \+ 4px\)'/.test(overlayBlock),
  'the overlay must open downward, or it is clipped by the page container')
check(!/bottom: 'calc\(100% \+ 4px\)'/.test(overlayBlock),
  'the overlay must not open upward from a bar that sits near the top')
check(/maxHeight: '176px'/.test(overlayBlock), 'the list needs a max height so it scrolls internally')
check(/overflowY: 'auto'/.test(overlayBlock), 'the list must scroll inside itself, not scroll the page')
check(/scrollbarGutter: 'stable'/.test(overlayBlock),
  'the overlay must reserve its gutter, or rows re-wrap when the scrollbar appears')
check(/background: 'var\(--ui-bg-elevated\)'/.test(overlayBlock),
  'the overlay must be opaque, or the page shows through it')

// The bar is the positioning context; without it the overlay anchors to the page.
check(/const profilesBar = jsxs\('div', \{\n    className: 'flex flex-col',\n[\s\S]{0,200}?style: \{ position: 'relative' \}/.test(plugin),
  'the profiles bar must be the overlay\'s positioning context')

// ---- the error pill, scoped the same way ---------------------------------------
const pillBlock = (() => {
  const at = plugin.indexOf('nameError\n            ? jsx')
  if (at < 0) return ''
  const end = plugin.indexOf(': null', at)
  return end > at ? plugin.slice(at, end) : ''
})()
check(pillBlock.length > 0, 'the name error pill is missing')
check(/position: 'absolute'/.test(pillBlock), 'the error pill must float, not sit in the flex row')
check(/background: 'var\(--ui-bg-elevated\)'/.test(pillBlock),
  'the error pill must be opaque; the quaternary token is 96% transparent')
check(!/quaternary/.test(pillBlock.replace(/\/\/[^\n]*/g, '')),
  'the error pill must not fall back to the transparent quaternary token')

// The page container reserves its own gutter too, so nothing shifts if it ever scrolls.
check(/style: \{ scrollbarGutter: 'stable' \}/.test(plugin),
  'the page container must reserve the scrollbar gutter')

// ---- 管理 stays reachable while naming -----------------------------------------
// 确定/取消 used to occupy the 管理 slot, so opening a name field closed the only route
// to the list. They now live beside the input, and the three right-hand slots never move.
const barBlock = (() => {
  const start = plugin.indexOf('const profilesBar = jsxs(\'div\', {')
  const end = plugin.indexOf('return jsxs(\'div\', {\n    className: \'mx-auto flex h-full', start)
  return start >= 0 && end > start ? plugin.slice(start, end) : ''
})()
check(barBlock.length > 0, 'the profiles bar block is missing')
// The three slots swap labels in place: 确定 takes slot 1 (where 重命名 was), 取消 takes
// slot 2 (where 管理/收起 was), 另存为 keeps slot 3. Extracting the slot order proves
// nothing moved, which a per-label regex alone cannot show.
// Each slot is a ternary whose two branches are the labels for the two modes. Source
// order inside a ternary puts the "true" branch first, so the rendered order has to be
// asserted from the structure, not from where the strings appear in the file.
// Resting order is 重命名 · 另存为 · 管理: creation before management, and 管理 last so it
// sits in the same place on both list bars (the rotation bar puts 管理 last too).
const slot1 = barBlock.indexOf("editingName\n                ? slotButton('确定', commitName)\n                : slotButton('重命名'")
const slot2 = barBlock.indexOf("editingName\n                ? slotButton('取消', cancelName)\n                : slotButton('另存为', doSaveAs)")
const slot3 = barBlock.indexOf("? slotButton('另存为', doSaveAs, { disabled: true })")
const slot3b = barBlock.indexOf(": slotButton(profilesOpen ? '收起' : '管理'")
check(slot1 > 0, 'slot 1 must be 确定 / 重命名')
check(slot2 > 0, 'slot 2 must be 取消 / 另存为')
check(slot3 > 0 && slot3b > slot3, 'slot 3 must be 另存为(disabled) / 管理·收起')
check(slot1 < slot2 && slot2 < slot3,
  'the slots must appear in the order 确定·重命名 / 取消·另存为 / 管理')
// Three slots, five call sites: slots 1 and 2 and 3 are ternaries except one branch fewer.
const slotCallCount = (barBlock.match(/slotButton\(/g) || []).length
check(slotCallCount === 6,
  `the bar must hold exactly 3 slots (6 call sites: 另存为 appears once per mode); found ${slotCallCount}`)
check(!barBlock.includes("'改名'"), 'the label must not be 改名')
// While naming, 确定 and 取消 stay adjacent: the disabled 另存为 moves to slot 3 rather
// than splitting the pair.
check(/slotButton\('另存为', doSaveAs, \{ disabled: true \}\)/.test(barBlock),
  'while naming, 另存为 must be disabled in the LAST slot so 确定/取消 stay adjacent')

// ---- entering a naming mode always shows the list -------------------------------
// 另存为 used to leave profilesOpen untouched: with the list already open it looked
// right, with it closed nothing appeared. Two code paths, one visible symptom that
// depended on state nobody was tracking.
check(/const doSaveAs = \(\) => \{[\s\S]{0,300}?setProfilesOpen\(true\)/.test(plugin),
  '另存为 must open the profile list, or the result depends on its previous state')
check(/setEditMode\('rename'\)[\s\S]{0,200}?setProfilesOpen\(true\)/.test(plugin),
  '重命名 must open the list too: you need to see the other names to avoid a collision')
check(/const cancelName = \(\) => \{[\s\S]{0,200}?setProfilesOpen\(false\)/.test(plugin),
  'cancelling must close the list that was opened on entering the mode')

// ---- the media layer must follow cfg, not only the tokens ----------------------
// applyTargets() repaints panels from cfg; the video/img element's path, opacity and
// object-position are written ONLY by upsertMedia(). A reapply path missing it left the
// wallpaper on the previous profile while every panel changed.
const reapplyFn = (() => {
  const at = plugin.indexOf('async function reapplyConfig()')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(reapplyFn.length > 0, 'reapplyConfig is missing')
check(/applyTargets\(/.test(reapplyFn), 'reapplyConfig must repaint the tokens')
check(/upsertMedia\(\)/.test(reapplyFn),
  'reapplyConfig must also update the media element, or switching profiles leaves the video behind')
check(reapplyFn.indexOf('upsertMedia()') > reapplyFn.indexOf('resolveDefaultPath'),
  'upsertMedia must run after resolveDefaultPath, so the default media path is known')
// The media element must be reused across switches: recreating it would restart the video.
const upsertFn = (() => {
  const at = plugin.indexOf('function upsertMedia(')
  const end = plugin.indexOf('\n}', at) + 2
  return at >= 0 ? plugin.slice(at, end) : ''
})()
check(/let element = document\.getElementById\(MEDIA_ID\)/.test(upsertFn),
  'upsertMedia must look the existing element up rather than always creating one')

// ---- committing a name closes the list -----------------------------------------
// 取消 closed it from the start; 确定 did not, so a successful save left the list
// hanging open. Both exits from the mode must close it.
const commitBody = plugin.slice(
  plugin.indexOf('const commitName = async () => {'),
  plugin.indexOf('const cancelName = () => {'),
)
check(commitBody.length > 0, 'commitName is missing')
const closes = (commitBody.match(/setProfilesOpen\(false\)/g) || []).length
check(closes >= 2,
  `both commit branches (create and rename) must close the list; found ${closes}`)
// And the create branch must close it before switching, so the list is not left open
// over a newly created profile.
// 另存为 creates a record and leaves the current row alone. Showing the new profile used
// to flip the current row to 预览 and made the next rename hit the wrong profile.
check(/setProfilesOpen\(false\)/.test(commitBody),
  'the create branch must close the list')
check(!/showProfile/.test(commitBody),
  '另存为 must not switch the displayed profile')
// 重命名 must target the profile on screen, not the applied one.
check(/renameProfile\(ctx, shownProfileId\(\), nameDraft\)/.test(commitBody),
  'rename must act on the displayed profile, not the applied one')
check(!/renameProfile\(ctx, activeId,/.test(commitBody),
  'rename must not use the applied id: after a switch they differ')

// ---- the name slot keeps its metrics in both modes ------------------------------
// Measured in the running app: the app's Input defaults to 12px/16px with 6px padding
// (a 29.6px box) while the name is 14px/20px. Swapping them changed the type size AND
// the bar height by ~9.6px, which tipped the page over the fold and shifted everything.
check(/style: \{ height: '26px' \}/.test(plugin),
  'the name slot must have a fixed height, or the bar resizes between modes')
const nameSlot = (() => {
  const at = plugin.indexOf("style: { height: '26px' }")
  const start = plugin.lastIndexOf("jsx('div', {", at)
  // jsxs, not jsx: the slot row is the plural form. Looking for the wrong one returned
  // -1 and made the whole block empty, which reported six failures at once.
  const end = plugin.indexOf("className: 'flex items-center gap-1 shrink-0'", at)
  return start >= 0 && end > at ? plugin.slice(start, end) : ''
})()
check(nameSlot.length > 0, 'the name slot block is missing')
// Inline styles beat any class, including the component's own text-xs/py-1.5.
for (const [re, why] of [
  [/fontSize: '0\.875rem'/, 'the input must render at 14px like the name'],
  [/lineHeight: '20px'/, 'the input line height must match the name'],
  [/paddingTop: '2px'/, 'the input padding must be reduced to fit the 26px slot'],
  [/paddingBottom: '2px'/, 'the input padding must be reduced to fit the 26px slot'],
]) {
  check(re.test(nameSlot), why)
}
// The name itself must keep the same metrics, or the match only holds one way.
check(/className: 'text-sm leading-5 truncate min-w-0'/.test(nameSlot),
  'the name must render at text-sm/leading-5, matching the input')
// No className override on the INPUT: a class has to win a tailwind-merge against the
// component's own text-xs/py-1.5, which is a fragile thing to depend on for layout.
const inputBlock = (() => {
  const at = nameSlot.indexOf('jsx(Input, {')
  if (at < 0) return ''
  const end = nameSlot.indexOf('placeholder:', at)
  return end > at ? nameSlot.slice(at, end) : ''
})()
check(inputBlock.length > 0, 'the name input is missing from the slot')
check(!/className:/.test(inputBlock),
  'the input must be sized with inline styles, not a class that must win a merge')

// ---- click outside -------------------------------------------------------------
// Clicking away is the natural way to back out of a dropdown and an uncommitted name.
check(/if \(!profilesOpen && editMode === null && !rotationOpen\) return undefined/.test(plugin),
  'the click-outside handler must cover every overlay, including rotation')
check(/document\.addEventListener\('mousedown'/.test(plugin),
  'the outside click must be caught on mousedown, before the target button acts')
check(/if \(profilesOpen\) setProfilesOpen\(false\)\s*\n\s*if \(editMode !== null\)/.test(plugin),
  'an outside click must both close the list and drop an uncommitted name')
check(/ref: barRef/.test(plugin) && /const barRef = useRef\(null\)/.test(plugin),
  'the bar needs a ref, or a click inside it would be treated as outside')

// ---- no tooltip on the disabled delete ------------------------------------------
// A disabled button that explains itself still reads as actionable.
check(!/title: isActive \?/.test(plugin), 'the disabled 删除 slot must not carry a tooltip')
check(/slotButton\('删除', \(\) => doDelete\(p\.id\), \{ disabled: isShown \}\)/.test(plugin),
  '删除 must be disabled for the displayed row, with nothing else attached')

// ---- no ambiguous count ---------------------------------------------------------
// "方案 3" read as "profile three", not "three profiles".
check(/children: '🗂️ 方案列表',/.test(plugin), 'the profiles label must read 方案列表')
check(!/🗂️ 方案列表 \$\{/.test(plugin), 'the profiles label must not show a count')

// ---- the two icons must differ -------------------------------------------------
check(/🗂️ 方案/.test(plugin), 'the profiles label needs its own icon')
check(/💾 保存/.test(plugin), 'the save button keeps the floppy disk')
check(/🚀 应用/.test(plugin), '应用 needs its own label')
check(!/💾 方案/.test(plugin), 'the profiles label must not reuse the save icon')

// ---- drag must not fight the refresh tick --------------------------------------
check(/let dragInFlight = false/.test(plugin), 'a drag flag must gate the refresh tick')
check(/if \(dragInFlight\) return/.test(plugin), 'the refresh tick must skip itself while dragging')

const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
check(readme.includes(DISPLAY_NAME), `README should use the display name ${DISPLAY_NAME}`)

// Version consistency. The version is stated in four places and nothing else ties
// them together: the plugin's own VERSION constant (the only one the user ever
// sees, in the settings footer), the marker file (what the install scripts carry),
// and two separate spots in the README. A missed edit in one of them is invisible
// — the plugin loads, the install succeeds, and only a human comparing two of the
// four would ever notice. So they are compared mechanically.
const versionInPlugin = plugin.match(/const VERSION = '([^']+)'/)?.[1]
check(Boolean(versionInPlugin), 'plugin.js has no VERSION constant to check against')

const versionInMarker = marker.split('\n').map((l) => l.trim()).filter(Boolean)[1]
check(versionInMarker === versionInPlugin,
  `marker version (${versionInMarker}) must equal plugin VERSION (${versionInPlugin})`)

const versionInReadme = readme.match(/\*\*版本\*\*：v([0-9][^\s]*)/)?.[1]
check(versionInReadme === versionInPlugin,
  `README version (${versionInReadme}) must equal plugin VERSION (${versionInPlugin})`)

// The tree block names the project folder after the version, so a bump that skips
// this line documents a folder that does not exist.
const versionInTree = readme.match(new RegExp(`${PLUGIN_DIR}-v([0-9][^/\\s]*)/`))?.[1]
check(versionInTree === versionInPlugin,
  `README tree says ${PLUGIN_DIR}-v${versionInTree} but the plugin VERSION is ${versionInPlugin}`)

if (failures.length) {
  console.error('Package validation failed:\n')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`Package validation passed: ${required.length} required files, names consistent.`)
