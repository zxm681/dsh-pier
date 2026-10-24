/**
 * 扩展版本号的**唯一来源**（T60 缺陷②）。
 *
 * ## 为什么要有这个文件
 *
 * 真机验证抓到：已装扩展是 `0.3.2`，`hello` 里的 `extensionVersion` 报 `0.3.1`。
 * 原因是 `connector.js` 里写死了一份字面量，而 `package.json` 是另一份 —— 发版时
 * 只改了 `package.json`（那才是 VS Code 认的清单），代码里那份悄悄过期了。
 * 「两份手写同一事实」必然漂移；所以这里**不再有第二份**：
 * `EXTENSION_VERSION` 是运行时从 `package.json` 读出来的。
 *
 * ## 为什么是运行时读，而不是构建时注入
 *
 * 构建期注入（esbuild `define`）只覆盖打包产物，单测从 `src/` 直接 import 时拿不到
 * 那个常量，于是又得给源码留一份兜底值 —— 那就是第二个来源，缺陷原地复活。
 * 运行时读 `package.json` 对三种跑法都成立：
 *  - 单测 / `node src/...`：`src/version.js` → `../package.json`；
 *  - 打包产物 `out/extension.cjs`（`__dirname` = `<ext>/out`）→ `../package.json`；
 *  - 装好的 vsix：`package.json` 一定在扩展根目录（那是扩展清单本身）。
 * 同一份代码在两种目录布局下都指向扩展根，因此**不需要平台/构建分支**。
 *
 * ## 读不到怎么办
 *
 * 回 `0.0.0-unknown`，**绝不**回一个看起来合理的版本号 —— 缺陷②的形态就是
 * "报了个能过 schema 但不是真的版本"。诚实的不确定比漂亮的谎话好排查。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 读不到清单时的自报值（见文件头：宁可丑，不可编）。 */
export const EXTENSION_VERSION_FALLBACK = '0.0.0-unknown'

/**
 * 本模块所在目录。
 *
 * 源码里是 ESM（有 `import.meta.url`）；esbuild 打成 CJS 后 `import.meta` 是空对象，
 * 但那时 `__dirname` 存在。两个分支各自都只在这一个地方出现，不散落到调用方。
 */
function moduleDir() {
  // eslint-disable-next-line no-undef -- 只有 CJS 打包产物里才有 __dirname
  if (typeof __dirname === 'string' && __dirname !== '') return __dirname
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * 扩展清单路径：`<模块目录>/../package.json`（源码 `src/` 与打包 `out/` 同一相对位置）。
 *
 * @param {string} [here] 模块目录（仅供测试注入）
 * @returns {string}
 */
export function bridgePackageJsonPath(here = moduleDir()) {
  return join(here, '..', 'package.json')
}

/**
 * 读一个 `package.json` 里的 `version`。
 *
 * @param {string} [file] 清单路径（默认 = 本扩展的清单）
 * @returns {string} 读不到 / 字段不是非空字符串 → `EXTENSION_VERSION_FALLBACK`
 */
export function readExtensionVersion(file = bridgePackageJsonPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const version = typeof parsed?.version === 'string' ? parsed.version.trim() : ''
    return version === '' ? EXTENSION_VERSION_FALLBACK : version
  } catch {
    return EXTENSION_VERSION_FALLBACK
  }
}

/** 扩展对外自报的版本（`hello` 用；等于 `package.json` 的 `version`）。 */
export const EXTENSION_VERSION = readExtensionVersion()
