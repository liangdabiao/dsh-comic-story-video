// 设置（$DSH_HOME/comic-story-video/settings.json）。
// 三样东西：
//   projects   作品台账——建过/打开过的项目目录都记下来。这是「历史作品」的主数据源，
//              用户不用先配扫描目录才看得见自己做的片子。
//   outputRoot 新片默认存哪（「填主题 → 开始创作」用它落目录）。
//   roots      额外扫描目录（只用于把已有的项目目录纳进来）。
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

// 新片默认目录：D 盘在就放 D:\漫画故事，否则放 用户视频目录。
export function defaultOutputRoot() {
  try {
    if (existsSync('D:\\')) return join('D:\\', '漫画故事')
  } catch { /* ignore */ }
  return join(homedir(), 'Videos', '漫画故事')
}

export function readSettings() {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return {
      projects: Array.isArray(raw.projects) ? raw.projects.filter((r) => typeof r === 'string' && r.trim()) : [],
      roots: Array.isArray(raw.roots) ? raw.roots.filter((r) => typeof r === 'string' && r.trim()) : [],
      lastRoot: typeof raw.lastRoot === 'string' ? raw.lastRoot : '',
      outputRoot: typeof raw.outputRoot === 'string' && raw.outputRoot.trim() ? raw.outputRoot : ''
    }
  } catch {
    return { projects: [], roots: [], lastRoot: '', outputRoot: '' }
  }
}

export function writeSettings(patch = {}) {
  const current = readSettings()
  const next = { ...current, ...patch }
  if (patch.roots) next.roots = patch.roots
  if (patch.projects) next.projects = patch.projects
  atomicWrite(SETTINGS_FILE, next)
  return next
}

// 记一个项目目录：写进作品台账（历史列表就是它），并更新 lastRoot。
export function rememberProject(dir) {
  const settings = readSettings()
  const normalized = String(dir).replace(/[\\/]+$/, '')
  const projects = settings.projects.slice()
  if (!projects.some((p) => p.replace(/[\\/]+$/, '') === normalized)) projects.unshift(normalized)
  settings.projects = projects.slice(0, 500)
  settings.lastRoot = normalized
  writeSettings(settings)
  return settings
}
