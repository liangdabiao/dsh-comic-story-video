// 扫描根目录设置（$DSH_HOME/comic-story-video/settings.json）。
// 页面「我的项目」列表靠它扫描；对话里 init 过的项目会记进来，换盘也不丢。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const DATA_DIR = join(DSH_HOME, 'comic-story-video')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

function atomicWrite(file, value) {
  ensureDir()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    try { writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
  }
}

export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return {
      roots: Array.isArray(raw.roots) ? raw.roots.filter((r) => typeof r === 'string' && r.trim()) : [],
      lastRoot: typeof raw.lastRoot === 'string' ? raw.lastRoot : ''
    }
  } catch {
    return { roots: [], lastRoot: '' }
  }
}

export function writeSettings(patch = {}) {
  const current = readSettings()
  const next = { ...current, ...patch }
  if (patch.roots) next.roots = patch.roots
  atomicWrite(SETTINGS_FILE, next)
  return next
}

// 记一个项目目录：加进第一个根（没有根就用它父目录建根），并更新 lastRoot。
export function rememberProject(dir) {
  const settings = readSettings()
  const normalized = String(dir).replace(/\/+$/, '')
  if (!settings.roots.some((r) => normalized.startsWith(r.replace(/\/+$/, '')))) {
    settings.roots.unshift(normalized)
  }
  settings.lastRoot = normalized
  writeSettings(settings)
  return settings
}
