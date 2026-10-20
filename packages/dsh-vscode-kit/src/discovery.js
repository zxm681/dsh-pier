/**
 * 发现文件：DSH 实例的「名片」。
 *
 * 桥接双方共用这一份实现 —— DSH 侧写、VSCode 侧读，规则只写一遍，
 * 避免两边对权限位/原子性/死 pid 的处理慢慢漂移。
 *
 * 安全边界（阶段4 §6）：
 *  - 目录 0700、文件 0600；token 只落在本机当前用户可读的位置。
 *  - 原子写（临时文件 + rename），读者永远看到完整 JSON。
 *  - 死 pid 残留清扫：DSH 崩溃留下的名片不能永久骗住编辑器。
 *
 * 零依赖：只用 node:fs / node:crypto / node:os / node:path。
 */

import { randomBytes } from 'node:crypto'
import {
  chmodSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 发现文件目录名（相对 DSH_HOME）。刻意与 Fengze233 的 vscode-bridge 隔离。 */
export const DISCOVERY_DIR_NAME = 'dsh-vscode-kit'

/** 解析 DSH_HOME。优先级：显式参数 > DSH_HOME 环境变量 > ~/.dsh。 */
export function resolveDshHome(explicit) {
  if (explicit) return explicit
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

/** 发现文件目录绝对路径。 */
export function discoveryDir(dshHome) {
  return join(resolveDshHome(dshHome), DISCOVERY_DIR_NAME)
}

/**
 * 原子写发现文件：写临时文件 → chmod 0600 → rename 覆盖。
 *
 * 为什么必须原子：VSCode 扩展可能在任意时刻读它，直接 writeFile 会读到半截 JSON。
 * 为什么 chmod 在 rename 之前：rename 后再 chmod 存在窗口期，文件已可见但尚未收紧。
 */
export function writeDiscoveryFile(dir, payload) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, `${payload.pid}.json`)
  const temp = join(dir, `.${payload.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
    // Windows 上 mode 常被忽略，显式再设一次（失败不致命）
    try { chmodSync(temp, 0o600) } catch { /* best effort on Windows */ }
    renameSync(temp, target)
  } catch (err) {
    try { rmSync(temp, { force: true }) } catch { /* ignore */ }
    throw err
  }
  return target
}

/** 删除发现文件（退出回收）。 */
export function removeDiscoveryFile(dir, pid) {
  try { rmSync(join(dir, `${pid}.json`), { force: true }) } catch { /* ignore */ }
}

/**
 * 进程是否存活。用于死 pid 残留清扫。
 *
 * process.kill(pid, 0) 的语义：不发信号只做权限/存在性检查。
 * ESRCH = 不存在；EPERM = 存在但无权限（仍算活着）。Windows 上同理可用。
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/**
 * 清扫发现目录里的死 pid 残留与垃圾临时文件。
 * @returns {{removed: string[], kept: string[]}}
 */
export function sweepDiscoveryDir(dir) {
  const removed = []
  const kept = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return { removed, kept }
  }
  for (const name of entries) {
    const full = join(dir, name)
    if (name.endsWith('.tmp')) {
      try { rmSync(full, { force: true }); removed.push(name) } catch { kept.push(name) }
      continue
    }
    if (!name.endsWith('.json')) continue
    const pid = Number.parseInt(name.slice(0, -5), 10)
    if (!Number.isInteger(pid)) { kept.push(name); continue }
    if (pid === process.pid || isProcessAlive(pid)) { kept.push(name); continue }
    try { rmSync(full, { force: true }); removed.push(name) } catch { kept.push(name) }
  }
  return { removed, kept }
}

/**
 * 读取目录下所有仍然存活的桥实例（按 startedAt 降序，最新的在前）。
 *
 * 「存活」用 pid 探测判断，而不是文件存在与否 —— DSH 被强杀时名片会留下。
 * 损坏/半截文件直接忽略，不因为一个坏名片让整次扫描失败。
 */
export function listLiveBridges(dir) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    try {
      const info = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      if (info && Number.isInteger(info.pid) && isProcessAlive(info.pid)) out.push(info)
    } catch { /* 半截/损坏文件直接忽略 */ }
  }
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return out
}
