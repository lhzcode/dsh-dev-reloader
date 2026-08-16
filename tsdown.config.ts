import { readFileSync } from 'node:fs'

import { defineConfig } from 'tsdown'

const pluginId: string = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).name

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  outDir: 'lib',
  clean: false,
  sourcemap: true,
  dts: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^react(?:\/.*)?$/],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginId)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
