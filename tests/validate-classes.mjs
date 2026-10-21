// Catches a whole class of silent failure: the plugin's settings UI is injected
// into the app's own Tailwind bundle, and that bundle is compiled ahead of time,
// so it only defines the utilities the app itself uses. A class the app never
// used — `w-11` is one — simply does not exist in the stylesheet, and the
// element silently falls back to its default layout. That is invisible until
// something looks misaligned, so it is checked here instead.
//
// The same check is then run over the app's CSS custom properties, which the
// plugin overrides to retint the UI — see the comment above that block.
//
// Skips when the app's stylesheet cannot be found, so it never blocks work on a
// machine without a packaged Hermes.
//
// The locator below is deliberately broad. An earlier version hardcoded one
// developer's checkout path, which meant that on every other machine the check
// hit the "not found" branch and reported success — a validator that passes by
// skipping is worse than no validator at all.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginPath = path.join(root, 'dynamic-backdrop/plugin.js')

// Where a packaged Hermes may live, in order of preference:
//   HERMES_DESKTOP_HOME  app-level home, explicit override
//   HERMES_HOME          may be profile-shaped (…/profiles/<name>); stripped below
//   ~/.hermes            default app home
//   /Applications, ~/Applications  a normally installed app
function candidateRoots() {
  const roots = []
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p) }

  if (process.env.HERMES_DESKTOP_HOME) push(process.env.HERMES_DESKTOP_HOME)

  if (process.env.HERMES_HOME) {
    const home = process.env.HERMES_HOME
    // A session sets HERMES_HOME to one profile; the app home is two levels up.
    const parent = path.dirname(home)
    push(path.basename(parent) === 'profiles' ? path.dirname(parent) : home)
  }

  push(path.join(os.homedir(), '.hermes'))
  push('/Applications')
  push(path.join(os.homedir(), 'Applications'))
  return roots
}

const ASSETS_TAIL = path.join('Contents', 'Resources', 'app.asar.unpacked', 'dist', 'assets')

// Finding the assets folder, cheapest first.
//
// The layout differs by install kind, and the development build nests it six
// directories deep: <home>/hermes-agent/apps/desktop/release/<arch>/Hermes.app.
// A hand-written directory walk with a depth cap missed exactly that case, so
// the check still passed-by-skipping on the machine it was written for. Known
// shapes are tried first; the glob is the fallback that catches the rest.
function knownShapes(root) {
  return [
    // dev checkout: ~/.hermes/hermes-agent/apps/desktop/release/<arch>/Hermes.app
    path.join(root, 'hermes-agent', 'apps', 'desktop', 'release'),
    root,                       // root may be the app home holding Hermes.app
    path.join(root, 'Applications'),
  ]
}

function assetsFrom(root) {
  const found = []
  for (const base of knownShapes(root)) {
    if (!fs.existsSync(base)) continue
    let entries
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    // `<release>/<arch>/Hermes.app/…`
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const archDir = path.join(base, entry.name)
      const direct = path.join(archDir, 'Hermes.app', ASSETS_TAIL)
      if (fs.existsSync(direct)) found.push(direct)
      // `<base>/Hermes.app/…`
      const app = path.join(base, entry.name, ASSETS_TAIL)
      if (entry.name === 'Hermes.app' && fs.existsSync(app)) found.push(app)
    }
  }
  return found
}

function assetsByGlob(root) {
  let apps
  try {
    apps = fs.globSync(`${root}/**/Hermes.app`, {
      maxDepth: 8,
      exclude: (p) => /node_modules|\.git[/\\]|sessions|sandboxes|backups/.test(p),
    })
  } catch {
    return []
  }
  return apps
    .map((app) => path.join(app, ASSETS_TAIL))
    .filter((dir) => fs.existsSync(dir))
}

function collectCss() {
  for (const root of candidateRoots()) {
    const dirs = [...assetsFrom(root)]
    if (!dirs.length) dirs.push(...assetsByGlob(root))
    for (const dir of dirs) {
      let files
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.css'))
      } catch {
        continue
      }
      if (!files.length) continue
      return { css: files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join(''), dir }
    }
  }
  return { css: null, dir: null }
}

const { css, dir: assetsDir } = collectCss()
if (css === null) {
  console.log('Class validation skipped: no packaged Hermes stylesheet found on this machine.')
  console.log(`  searched: ${candidateRoots().join(' · ')}`)
  process.exit(0)
}

// Class names defined in the stylesheet, with Tailwind's selector escapes removed.
const defined = new Set()
for (const m of css.matchAll(/\.((?:[^\s,{:>+~()\[\]\\]|\\.)+)/g)) {
  if (m[1].startsWith('--')) continue // a custom property, not a class
  defined.add(m[1].replace(/\\/g, ''))
}

const source = fs.readFileSync(pluginPath, 'utf8')
const used = new Set()
for (const m of source.matchAll(/className:\s*['"]([^'"]+)['"]/g)) {
  for (const cls of m[1].split(/\s+/)) used.add(cls)
}
// JSX-style className="..." inside template strings is covered by the above; the
// stylesheet the plugin injects contains no class selectors of its own.

const missing = [...used].filter((c) => !defined.has(c)).sort()
if (missing.length) {
  console.error(`Stylesheet used: ${assetsDir}\n`)
  console.error('These Tailwind classes are not defined in the app stylesheet and will do nothing:\n')
  for (const c of missing) console.error(`  ${c}`)
  console.error('\nUse an inline style for anything layout-critical.')
  process.exit(1)
}

console.log(`Class validation passed: ${used.size} classes all exist in the app stylesheet.`)

// The app's own CSS custom properties, which the plugin overrides to retint the
// UI. Same failure mode as a missing class, and harder to notice: if the app
// renames a token, the assignment lands on nothing, that surface keeps the app's
// own colour, and nothing errors anywhere — the background simply looks slightly
// wrong. The terminal surface was exactly this bug: the token resolved to
// transparent, xterm fell back to its built-in dark colour, and it read as a
// foreign block until the token was traced by hand.
//
// Only the app's own tokens are checked. The plugin's own --hlw-* are defined by
// the plugin and mean nothing to the app, so their absence here would be
// meaningless.
const appTokens = [...new Set([...source.matchAll(/--((?:ui|dt)-[a-z0-9-]+)/g)].map((m) => m[1]))]
// A plain substring test would miss a token that was merely renamed into a longer
// one (--ui-bg-input disappearing while --ui-bg-input-hover survives), so the name
// must end where the next character is not part of it.
const missingTokens = appTokens.filter((name) => !new RegExp(`--${name}(?![a-z0-9-])`).test(css))
if (missingTokens.length) {
  console.error(`Stylesheet used: ${assetsDir}\n`)
  console.error('These Hermes design tokens are not defined in the app stylesheet; overriding them does nothing:\n')
  for (const t of missingTokens) console.error(`  --${t}`)
  console.error('\nThe app renamed or dropped them. Find the current name in the bundle before shipping.')
  process.exit(1)
}

console.log(`Token validation passed: ${appTokens.length} app tokens all defined in the app stylesheet.`)
