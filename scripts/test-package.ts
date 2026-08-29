import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packageJSON = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  version: string
  devDependencies: { '@typescript/native-preview': string }
}
const bun = process.execPath
const directory = await mkdtemp(join(tmpdir(), 'ocpipe-package-'))

try {
  await run([bun, 'pm', 'pack', '--destination', directory, '--quiet'], root)
  const tarball = join(directory, 'ocpipe.tgz')
  await rename(join(directory, `ocpipe-${packageJSON.version}.tgz`), tarball)
  const consumer = join(directory, 'consumer')
  await mkdir(consumer)
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: { ocpipe: 'file:../ocpipe.tgz', zod: '4.4.3' },
        devDependencies: {
          '@typescript/native-preview':
            packageJSON.devDependencies['@typescript/native-preview'],
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(consumer, 'index.ts'),
    `import { field, signature } from 'ocpipe'

export const Example = signature({
  doc: 'Example signature',
  inputs: { value: field.string() },
  outputs: {},
})
`,
  )
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
      },
    }),
  )
  await run([bun, 'install', '--ignore-scripts'], consumer)
  await run([bun, 'x', 'tsgo', '--noEmit'], consumer)
  await absent(join(consumer, 'node_modules/@anthropic-ai/claude-agent-sdk'))
  await absent(join(consumer, 'node_modules/@openai/codex-sdk'))
} finally {
  await rm(directory, { recursive: true, force: true })
}

async function run(command: string[], cwd?: string): Promise<void> {
  const process = Bun.spawn(command, {
    cwd,
    stderr: 'inherit',
    stdout: 'inherit',
  })
  if ((await process.exited) !== 0) {
    throw new Error(`${command.join(' ')} failed`)
  }
}

async function absent(path: string): Promise<void> {
  try {
    await access(path)
  } catch {
    return
  }
  throw new Error(`optional provider SDK installed: ${path}`)
}
