import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface PackageMetadata {
  readonly private?: boolean
  readonly repository?: { readonly url?: string }
  readonly files?: readonly string[]
  readonly scripts?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly dsh?: {
    readonly client?: {
      readonly inject?: readonly string[]
    }
  }
}

const metadata = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageMetadata

describe('package metadata', () => {
  it('remains a GitHub-only package with public documentation and no full DSH dependency', () => {
    expect(metadata.private).toBe(true)
    expect(metadata.repository?.url).toBe('git+https://github.com/lhzcode/dsh-dev-reloader.git')
    expect(metadata.files).toEqual(expect.arrayContaining([
      'README.md',
      'README.zh.md',
      'CHANGELOG.md',
      'docs',
      'LICENSE',
    ]))
    expect(metadata.dependencies).not.toHaveProperty('@deepseek-ai/dsh')
  })

  it('ships precompiled artifacts without Git install lifecycle scripts', () => {
    expect(metadata.files).toEqual(expect.arrayContaining([
      'lib/**/*.js',
      'lib/types/**/*.d.ts',
    ]))
    expect(metadata.scripts).not.toHaveProperty('prepare')
    expect(metadata.scripts).not.toHaveProperty('prepack')
    expect(metadata.scripts).not.toHaveProperty('prepublish')
  })

  it('loads every direct rc.6 client ABI provider before the browser plugin', () => {
    expect(metadata.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
      '@deepseek-ai/dsh-api-remotes',
    ])
  })
})
