import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitRows, listRows, resetRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import { useSessionStore } from '@/stores/session'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 站点状态与关联业务的联动约定：站点撤销后，关联记录只读，在途检定记录级联停用。
const STATION_KEY = 'station'
const STATION_CODE_FIELD = '站点编号'
const REVOKED_STATUS = '已撤销'
const CALIBRATION_KEY = 'calibration'
const CALIBRATION_IN_FLIGHT = ['待送检', '送检中']
const CALIBRATION_CLOSED = '已停用'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 每个模块的「XX状态」字段是 status 的镜像，流转时一起改，列表和详情才不会对不上。
function mirrorFieldOf(meta: ModuleMeta): string | null {
  return meta.fields.find((field) => field.endsWith('状态')) ?? null
}

// 越权必须拒绝：拿不到会话也按无权处理（宁可拒真，不可放行）。
function checkPermission(action: string): ActionResult | null {
  try {
    const session = useSessionStore()
    if (!session.permits(action)) {
      return {
        ok: false,
        message: `越权拒绝：当前值班「${session.operator}」（${session.role}）无权执行「${action}」`,
      }
    }
    return null
  } catch {
    return { ok: false, message: '越权拒绝：当前没有可用的值班会话，禁止写操作' }
  }
}

// 关联业务核查：记录所属站点已撤销时，记录只读，任何流转动作都拒绝。
function checkStationActive(meta: ModuleMeta, row: EntryRow): ActionResult | null {
  const stationCode = String(row[STATION_CODE_FIELD] ?? '')
  if (!stationCode) {
    return null
  }
  const revoked = listRows(STATION_KEY).some(
    (station) =>
      String(station[STATION_CODE_FIELD] ?? '') === stationCode &&
      String(station.status) === REVOKED_STATUS,
  )
  if (revoked) {
    return {
      ok: false,
      message: `所属水文监测站「${stationCode}」已撤销，${meta.entity}只读，不能执行该动作`,
    }
  }
  return null
}

function applyStatus(meta: ModuleMeta, row: EntryRow, target: string, abnormal: boolean): EntryRow {
  const mirror = mirrorFieldOf(meta)
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return {
    ...row,
    status: target,
    ...(mirror ? { [mirror]: target } : {}),
    pending: target !== lastStatus,
    abnormal,
  }
}

// 站点撤销的级联：该站名下还在流程里的检定记录（待送检/送检中）一律停用，清出待办；
// 已有结论（已合格/不合格）的记录是历史档案，保持原样只读。
function cascadeCalibration(stationCode: string): { rows: EntryRow[]; closed: number } {
  const meta = moduleMeta(CALIBRATION_KEY)
  let closed = 0
  const rows = listRows(CALIBRATION_KEY).map((row) => {
    // 空编号不参与匹配：历史数据可能缺站点编号，不能误伤。
    const belongs = stationCode !== '' && String(row[STATION_CODE_FIELD] ?? '') === stationCode
    if (!belongs || !CALIBRATION_IN_FLIGHT.includes(String(row.status))) {
      return row
    }
    closed += 1
    return applyStatus(meta, row, CALIBRATION_CLOSED, true)
  })
  return { rows, closed }
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const denied = checkPermission(action)
  if (denied) {
    return denied
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    // 幂等：重复撤销（或任何重复流转）只生效一次，后续直接拒绝，不再产生副作用。
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const updates: Record<string, EntryRow[]> = {}
  let cascadeNote = ''
  if (key === STATION_KEY) {
    if (current === REVOKED_STATUS) {
      // 历史撤销站只读兼容：已撤销的站点只能看，不能再流转。
      return { ok: false, message: `${meta.entity}已撤销，档案只读，不能再执行「${action}」` }
    }
    if (target === REVOKED_STATUS) {
      const stationCode = String(rows[index][STATION_CODE_FIELD] ?? '')
      const cascade = cascadeCalibration(stationCode)
      updates[CALIBRATION_KEY] = cascade.rows
      if (cascade.closed > 0) {
        cascadeNote = `，同步停用该站在途仪器检定记录 ${cascade.closed} 条`
      }
    }
  } else {
    const inactive = checkStationActive(meta, rows[index])
    if (inactive) {
      return inactive
    }
  }
  const abnormal = NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
  const next = [...rows]
  next[index] = applyStatus(meta, rows[index], target, abnormal)
  updates[key] = next
  try {
    // 原子落库：主记录与级联记录一次写入，任一失败全部不生效，状态不会先写进去。
    commitRows(updates)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `落库失败，本次${action}未生效，数据保持原状：${reason}` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${cascadeNote}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
