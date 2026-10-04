import { MODULE_BY_KEY } from './modules'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 每个模块最后一个「XX状态」字段是 status 的镜像，列表（当前状态）与详情（状态字段）都读它。
function mirrorFieldOf(key: string): string | null {
  const meta = MODULE_BY_KEY.get(key)
  const field = meta?.fields.find((item) => item.endsWith('状态'))
  return field ?? null
}

// 历史数据只读兼容：旧数据里镜像状态字段可能是占位文本，读进来时按 status 对齐，
// 只修展示字段，不改写任何业务状态本身。
function reconcile(state: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  for (const [key, rows] of Object.entries(state)) {
    const mirror = mirrorFieldOf(key)
    if (!mirror) {
      continue
    }
    state[key] = rows.map((row) =>
      row[mirror] === row.status ? row : { ...row, [mirror]: row.status },
    )
  }
  return state
}

// 播种与坏数据回退时的写入只是尽力而为：写不动（如存储已满）不影响本次读取。
function tryPersist(state: Record<string, EntryRow[]>): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    }
  } catch {
    // 读路径不允许被落库失败拖垮
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    tryPersist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return reconcile({ ...fallback, ...parsed })
  } catch {
    tryPersist(fallback)
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 原子落库：一次提交可以跨多个模块，序列化 + 写入全部成功后才更新内存缓存。
// 任何一步失败都会抛错，此时缓存与 localStorage 都保持原样，不会出现「状态先写进去」的半截数据。
export function commitRows(updates: Record<string, EntryRow[]>): void {
  const next = { ...allRows() }
  for (const [key, rows] of Object.entries(updates)) {
    next[key] = rows
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commitRows({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
