import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitSnapshots, listRows, resetRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 站点主档是关联业务的唯一事实源，站点编号 / 所在河流 / 运行状态都以这里为准。
const STATION_KEY = 'station'
const STATION_CODE_FIELD = '站点编号'
const STATION_RIVER_FIELD = '所在河流'
const STATION_REVOKED = '已撤销'

// 受控模块的状态机：动作只允许从列举的当前状态发起，其余一律视为越权。
// 没登记的模块沿用旧的「不重复即可流转」规则，避免改动面外溢。
const ACTION_FROM: Record<string, Record<string, string[]>> = {
  station: {
    升级为加强: ['正常运行', '设备故障'],
    登记故障: ['正常运行', '汛期加强', '暂停运行'],
    撤销站点: ['正常运行', '设备故障', '汛期加强', '暂停运行'],
  },
  inspection: {
    完成巡检: ['待巡检'],
    报告故障: ['待巡检', '已巡检'],
    确认处置: ['发现故障'],
  },
  calibration: {
    送出检定: ['待送检'],
    确认合格: ['送检中'],
    标记不合格: ['送检中'],
  },
}

type StationContext = {
  code: string
  row: EntryRow
  index: number
  revoked: boolean
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
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

export function getEntry(key: string, id: number): EntryRow | null {
  return listRows(key).find((row) => Number(row.id) === id) ?? null
}

// 列表与详情共用同一份站点解析逻辑，杜绝两边各取一个字段导致对不上。
export function stationByCode(code: string): StationContext | null {
  const stations = listRows(STATION_KEY)
  const index = stations.findIndex(
    (row) => String(row[STATION_CODE_FIELD] ?? '') === code,
  )
  if (index < 0) {
    return null
  }
  const row = stations[index]
  return { code, row, index, revoked: String(row.status) === STATION_REVOKED }
}

// 解析关联记录所属站点：编号写了但在主档里查不到，说明引用了已删除/错误的主数据，同样不允许处置。
function resolveStation(meta: ModuleMeta, row: EntryRow): { station: StationContext | null; code: string; dangling: boolean } {
  const field = meta.stationField
  if (!field) {
    return { station: null, code: '', dangling: false }
  }
  const code = String(row[field] ?? '').trim()
  if (!code) {
    return { station: null, code: '', dangling: false }
  }
  const station = stationByCode(code)
  return { station, code, dangling: station === null }
}

// 站点关联业务（巡检、检定）共用的处置前核查：撤销站只读、悬空引用拒绝。
function guardStationBound(meta: ModuleMeta, row: EntryRow): ActionResult | null {
  const { station, dangling } = resolveStation(meta, row)
  if (dangling) {
    return { ok: false, message: `所属站点在站点主档中不存在或已被删除，${meta.entity}禁止处置，请先核对站点编号` }
  }
  if (station?.revoked) {
    return {
      ok: false,
      message: `所属站点「${station.code}」已撤销，历史记录只读，不能再${meta.name}处置`,
    }
  }
  return null
}

function findIndex(rows: EntryRow[], id: number): number {
  return rows.findIndex((row) => Number(row.id) === id)
}

function nextPending(meta: ModuleMeta, target: string): boolean {
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  return target !== lastStatus
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = findIndex(rows, id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)

  // 撤销站点重复执行只生效一次：已撤销的站点给出明确拒绝，不产生任何写入。
  if (key === STATION_KEY && action === '撤销站点' && current === STATION_REVOKED) {
    return { ok: false, message: '站点已经撤销，重复撤销不会再次生效' }
  }

  // 受控模块按状态机校验来源状态：跳着流转、终态再操作都算越权，必须拒绝。
  const allowedFrom = ACTION_FROM[key]?.[action]
  if (allowedFrom) {
    if (!allowedFrom.includes(current)) {
      return {
        ok: false,
        message: `${meta.entity}当前为「${current}」，不能执行「${action}」`,
      }
    }
  } else if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 站点关联业务：站点撤销后巡检详情、检定待办等任何处置入口一律只读。
  const stationBlocked = guardStationBound(meta, row)
  if (stationBlocked) {
    return stationBlocked
  }

  const marked: EntryRow = {
    ...row,
    status: target,
    pending: nextPending(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }

  try {
    if (key === STATION_KEY && action === '撤销站点') {
      // 关联业务随站点状态一起收尾：任一模块落库失败，整份快照都不会写入，站点状态也不会先变。
      commitSnapshots(buildRevokeCascade(meta, rows, index, marked))
    } else {
      commitSnapshots({ [key]: rows.map((item, at) => (at === index ? marked : item)) })
    }
  } catch {
    return { ok: false, message: `${meta.entity}落库失败，状态未变更，请重试` }
  }

  return { ok: true, message: buildSuccessMessage(meta, action, target, key === STATION_KEY && action === '撤销站点') }
}

// 撤销站点的级联收尾（在内存里把整份快照算好，最后一次落库）：
// 1) 巡检：未办结记录随站点关闭，退出待办且不再允许处置，历史已办结记录原样保留（只读兼容）；
// 2) 检定：待办记录统一停用，退出检定待办；已合格/不合格等历史记录原样保留（只读兼容）；
// 3) 站点主档最后切到「已撤销」。
function buildRevokeCascade(
  meta: ModuleMeta,
  stations: EntryRow[],
  index: number,
  revokedStation: EntryRow,
): Record<string, EntryRow[]> {
  const code = String(revokedStation[STATION_CODE_FIELD] ?? '')
  const updates: Record<string, EntryRow[]> = {}

  const inspectionMeta = MODULE_BY_KEY.get('inspection')
  if (inspectionMeta?.stationField) {
    updates.inspection = listRows('inspection').map((item) => {
      if (String(item[inspectionMeta.stationField!] ?? '') !== code || !item.pending) {
        return item
      }
      return { ...item, pending: false }
    })
  }

  const calibrationMeta = MODULE_BY_KEY.get('calibration')
  if (calibrationMeta?.stationField) {
    updates.calibration = listRows('calibration').map((item) => {
      if (String(item[calibrationMeta.stationField!] ?? '') !== code || !item.pending) {
        return item
      }
      return { ...item, status: '已停用', pending: false, abnormal: true }
    })
  }

  updates[STATION_KEY] = stations.map((item, at) => (at === index ? revokedStation : item))
  return updates
}

function buildSuccessMessage(
  meta: ModuleMeta,
  action: string,
  target: string,
  cascaded: boolean,
): string {
  const base = `${meta.entity}已${action}，当前状态「${target}」`
  return cascaded ? `${base}，关联巡检与检定待办已一并收尾，历史记录保留只读` : base
}

// 查某站点关联的巡检 / 检定记录：详情页与列表走同一条数据通道，展示口径一致。
export function relatedEntries(stationCode: string): { inspection: EntryRow[]; calibration: EntryRow[] } {
  const code = stationCode.trim()
  const inspectionField = MODULE_BY_KEY.get('inspection')?.stationField
  const calibrationField = MODULE_BY_KEY.get('calibration')?.stationField
  return {
    inspection: inspectionField
      ? listRows('inspection').filter((row) => String(row[inspectionField] ?? '') === code)
      : [],
    calibration: calibrationField
      ? listRows('calibration').filter((row) => String(row[calibrationField] ?? '') === code)
      : [],
  }
}

// 关联记录在页面上展示所属站点时统一用主档口径（编号 + 河流 + 运行状态）。
export function stationSnapshot(code: string): { code: string; river: string; status: string } | null {
  const station = stationByCode((code ?? '').trim())
  if (!station) {
    return null
  }
  return {
    code: station.code,
    river: String(station.row[STATION_RIVER_FIELD] ?? ''),
    status: String(station.row.status),
  }
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
  const bom = String.fromCharCode(0xfeff)
  return { filename: `${meta.name}-清单.csv`, content: `${bom}${lines.join('\n')}` }
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
