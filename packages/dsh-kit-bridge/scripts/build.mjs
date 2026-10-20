/**
 * 构建：esbuild 打包成 CommonJS 单文件 out/extension.cjs。
 *
 * 为什么是 CJS：VS Code 扩展宿主对 ESM 扩展的支持要 1.94+ 且仍有边界情况；
 * CJS 是 1.91 起就没问题的稳妥选择。源码本身仍写 ESM，打包转换即可。
 *
 * 为什么 bundle 而不是 tsc：kit 的 protocol.js/discovery.js 是跨包相对 import，
 * 不打包的话 vsix 里就得塞 node_modules 或 ../dsh-vscode-kit，两个都不干净。
 * 打包后 vsix 只有一个 extension.cjs，零安装依赖。
 */

import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

rmSync(path.join(root, 'out'), { recursive: true, force: true })

await build({
  entryPoints: [path.join(root, 'src/extension.js')],
  outfile: path.join(root, 'out/extension.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // vscode 由扩展宿主注入，绝不能打包
  external: ['vscode'],
  // 生产构建保留可读性，便于故障时看 vsix 里的实际代码
  minify: false,
  sourcemap: false,
  logLevel: 'info',
})

console.log('built out/extension.cjs')
