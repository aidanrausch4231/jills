/** Generate lib/typert.host.* and lib/typert.remote-client.* with dsh's exported Typert generator.
 * Stage our sources plus public built dsh
 * declarations (never upstream source) in ignored .typert/, then run the generator on that stage. */
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(import.meta.dirname, '..')
const stage = join(root, '.typert')
const NAME = '@jills/dsh'
rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, 'packages'), { recursive: true })
symlinkSync(join(root, 'node_modules'), join(stage, 'node_modules'), 'dir')
const paths = {}
const references = []
{
  const target = join(stage, 'packages', 'dsh')
  cpSync(join(root, 'src'), join(target, 'src'), { recursive: true, filter: file => !file.includes('/client') })
  cpSync(join(root, 'package.json'), join(target, 'package.json'))
  symlinkSync(join(root, 'node_modules'), join(target, 'node_modules'), 'dir')
  paths[NAME] = ['./packages/dsh/src/index.ts']
  paths[`${NAME}/types`] = ['./packages/dsh/src/types.ts']
  references.push({ path: './packages/dsh' })
}
const require = createRequire(join(root, 'package.json'))
for (const name of ['dsh-typert-protocol', 'dsh-brand']) {
  const manifestFile = require.resolve(`@deepseek-ai/${name}/package.json`)
  const source = dirname(manifestFile), target = join(stage, 'packages', name)
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  cpSync(join(source, 'lib/types'), join(target, 'types'), { recursive: true, filter: file => !file.endsWith('.js') && !file.endsWith('.map') })
  const exports = {}
  for (const [key, value] of Object.entries(manifest.exports)) {
    const type = typeof value === 'object' && value !== null ? value.types : undefined
    if (!type?.startsWith('./lib/types/') || key.includes('*')) continue
    const staged = type.replace('./lib/types/', './types/')
    exports[key] = staged
    paths[manifest.name + (key === '.' ? '' : key.slice(1))] = [`./packages/${name}/${staged}`]
  }
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: manifest.name, exports }))
  symlinkSync(join(source, 'node_modules'), join(target, 'node_modules'), 'dir')
  references.push({ path: `./packages/${name}` })
}
const options = JSON.parse(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')).compilerOptions
writeFileSync(join(stage, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: { ...options, composite: true, declaration: true, paths } }))
for (const { path } of references) writeFileSync(join(stage, path, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json', include: ['src', 'types'] }))
writeFileSync(join(stage, 'tsconfig.host.json'), JSON.stringify({ extends: './tsconfig.base.json', files: [], references }))
const generator = new WorkspaceTypertGenerator(stage, { checkDiagnostics: false })
const artifacts = generator.generate([NAME], ['host'])
if (!artifacts.length) throw new Error(`${NAME}: the generator produced no artifact`)
for (const artifact of artifacts) {
  const out = join(root, 'lib')
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'typert.host.js'), artifact.js)
  writeFileSync(join(out, 'typert.host.d.ts'), artifact.dts)
  if (!artifact.remote) throw new Error(`${artifact.package}: missing Remote artifact`)
  writeFileSync(join(out, 'typert.remote-client.js'), artifact.remote.js)
  writeFileSync(join(out, 'typert.remote-client.d.ts'), artifact.remote.dts)
}
console.log('Generated Jills Host/Remote contracts.')
