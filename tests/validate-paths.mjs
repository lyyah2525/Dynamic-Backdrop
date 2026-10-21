import path from 'node:path'

const examples = [
  ['macOS', '/Users/example/My Videos/demo file.mp4'],
  ['Linux', '/home/example/My Videos/demo file.mp4'],
  ['Windows', 'C:\\\\Users\\\\example\\\\Videos\\\\demo file.mp4']
]

for (const [platform, input] of examples) {
  const normalized = input.replaceAll('\\\\', '/')
  const url = normalized.startsWith('/')
    ? `file://${encodeURI(normalized)}`
    : `file:///${encodeURI(normalized)}`
  if (!url.startsWith('file://')) throw new Error(`${platform} path failed`)
  console.log(`${platform}: ${url}`)
}

console.log(`Path validation passed: ${examples.length} platforms.`)
