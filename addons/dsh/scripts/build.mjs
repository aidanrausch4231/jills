/** Build the add-on: Host types + Typert contracts + Host entry + wrapped browser client.
 * The browser client uses dsh's closure-factory format (adapted from DeepSeek Harness, MIT; see THIRD_PARTY_NOTICES.md):
 * one CJS file wrapped in window.__ModuleLoader__.load, importing only dsh platform modules. */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(join(root, 'package.json'))
const tsc = require.resolve('typescript/bin/tsc')
const ID = '@jills/dsh'
/** Modules the dsh web shell provides to plugin factories (DeepSeek Harness client build). */
export const PLATFORM = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit'])

const step = (label, fn) => { process.stdout.write(`- ${label}\n`); return fn() }
rmSync(join(root, 'lib'), { recursive: true, force: true })
step('tsc host', () => execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' }))
step('typert contracts', () => execFileSync(process.execPath, [join(root, 'scripts/contracts.mjs')], { cwd: root, stdio: 'inherit' }))
await step('host entry', () => build({
  entryPoints: [join(root, 'lib/types/index.js')], outfile: join(root, 'lib/index.js'),
  bundle: true, format: 'esm', platform: 'node', target: 'node22', packages: 'external', logLevel: 'warning',
}))
step('tsc client (typecheck)', () => execFileSync(process.execPath, [tsc, '-p', 'tsconfig.client.json'], { cwd: root, stdio: 'inherit' }))
const result = await step('browser client', () => build({
  entryPoints: [join(root, 'src/client/index.tsx')], outfile: join(root, 'lib/client.js'),
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic', metafile: true, minify: true, keepNames: true, logLevel: 'warning',
  alias: { [`${ID}/remote`]: join(root, 'lib/typert.remote-client.js') },
  external: [...PLATFORM],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
}))
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (imported.kind === 'dynamic-import') throw new Error(`dynamic import is not supported by the dsh module loader: ${imported.path}`)
    if (imported.external && !PLATFORM.has(imported.path)) throw new Error(`Unprovided browser module: ${imported.path}`)
  }
}
console.log('Built lib/index.js, lib/client.js and Typert contracts.')
