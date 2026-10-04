import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MODULES } from '@/data/modules'
import type { EntryRow } from '@/data/types'
import type { OperatorRole } from '@/stores/session'

// 用内存版 localStorage 替代浏览器环境；fail 开关用来模拟落库失败。
function makeStorageStub() {
  const stub = {
    data: {} as Record<string, string>,
    fail: false,
    getItem(key: string) {
      return key in stub.data ? stub.data[key] : null
    },
    setItem(key: string, value: string) {
      if (stub.fail) {
        throw new Error('模拟落库失败：存储空间不足')
      }
      stub.data[key] = String(value)
    },
    removeItem(key: string) {
      delete stub.data[key]
    },
    clear() {
      stub.data = {}
    },
  }
  return stub
}

type BootOptions = {
  role?: OperatorRole
  preset?: Record<string, EntryRow[]>
}

// 每个用例都重置模块注册表，保证 local-store 的缓存是全新的。
async function boot(options: BootOptions = {}) {
  vi.resetModules()
  const store = await import('@/data/local-store')
  const stub = makeStorageStub()
  if (options.preset) {
    stub.data[store.storageKey()] = JSON.stringify(options.preset)
  }
  vi.stubGlobal('window', { localStorage: stub })
  setActivePinia(createPinia())
  const { useSessionStore } = await import('@/stores/session')
  const session = useSessionStore()
  if (options.role) {
    session.setRole(options.role)
  }
  const service = await import('@/api/local-service')
  return { service, session, stub, storageKey: store.storageKey() }
}

function rowOf(items: EntryRow[], id: number): EntryRow {
  const row = items.find((item) => Number(item.id) === id)
  if (!row) {
    throw new Error(`用例数据缺失：id=${id}`)
  }
  return row
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('站点撤销与关联业务联动', () => {
  it('撤销站点后，该站巡检记录只读，确认处置被拒绝且状态不变', async () => {
    const { service } = await boot()
    expect(service.runAction('station', 1, '撤销站点').ok).toBe(true)

    const dispose = service.runAction('inspection', 1, '确认处置')
    expect(dispose.ok).toBe(false)
    expect(dispose.message).toContain('已撤销')
    expect(dispose.message).toContain('只读')
    expect(rowOf(service.listEntries('inspection').items, 1).status).toBe('待巡检')

    // 未撤销站点的巡检记录不受影响
    expect(service.runAction('inspection', 3, '确认处置').ok).toBe(true)
  })

  it('撤销站点后，该站在途检定记录级联停用并清出待办，历史结论保留', async () => {
    const { service } = await boot()
    const result = service.runAction('station', 1, '撤销站点')
    expect(result.ok).toBe(true)
    expect(result.message).toContain('停用')

    const items = service.listEntries('calibration').items
    const cascaded = rowOf(items, 1)
    expect(cascaded.status).toBe('已停用')
    expect(cascaded['检定状态']).toBe('已停用')
    expect(cascaded.pending).toBe(false)

    // 其他站点的检定记录不受影响
    expect(rowOf(items, 2).status).toBe('送检中')
    expect(rowOf(items, 3).status).toBe('已合格')

    // 待办里只剩 STAT-0002 那一条送检中
    const overview = service.loadOverview()
    const calibration = overview.modules.find((item) => item.name === '仪器检定')
    expect(calibration?.pending).toBe(1)
  })

  it('另一个检定入口同样核查：已撤销站点的检定记录不能再流转', async () => {
    const { service } = await boot()
    // 核查前：正常站点的检定动作可以走
    expect(service.runAction('calibration', 1, '送出检定').ok).toBe(true)

    // 撤销 STAT-0002 后，其名下检定记录（已被级联停用）任何动作都拒绝
    expect(service.runAction('station', 2, '撤销站点').ok).toBe(true)
    const result = service.runAction('calibration', 2, '确认合格')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已撤销')
    expect(rowOf(service.listEntries('calibration').items, 2).status).toBe('已停用')
  })

  it('重复撤销只生效一次，级联不会重复执行', async () => {
    const { service } = await boot()
    expect(service.runAction('station', 1, '撤销站点').ok).toBe(true)

    const again = service.runAction('station', 1, '撤销站点')
    expect(again.ok).toBe(false)
    expect(again.message).toContain('不用重复操作')

    const closed = service
      .listEntries('calibration')
      .items.filter((row) => row.status === '已停用')
    expect(closed).toHaveLength(1)
  })

  it('已撤销的站点本身只读，任何动作都被拒绝', async () => {
    const { service } = await boot()
    expect(service.runAction('station', 1, '撤销站点').ok).toBe(true)
    const result = service.runAction('station', 1, '登记故障')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('只读')
    expect(rowOf(service.listEntries('station').items, 1).status).toBe('已撤销')
  })

  it('越权必须拒绝：访客不能写，操作员不能撤销站点，管理员可以', async () => {
    const guest = await boot({ role: '访客' })
    const denied = guest.service.runAction('station', 1, '登记故障')
    expect(denied.ok).toBe(false)
    expect(denied.message).toContain('越权')
    expect(rowOf(guest.service.listEntries('station').items, 1).status).toBe('正常运行')

    const operator = await boot({ role: '操作员' })
    expect(operator.service.runAction('station', 1, '登记故障').ok).toBe(true)
    const elevate = operator.service.runAction('station', 1, '撤销站点')
    expect(elevate.ok).toBe(false)
    expect(elevate.message).toContain('越权')
    expect(rowOf(operator.service.listEntries('station').items, 1).status).toBe('设备故障')

    const admin = await boot({ role: '管理员' })
    expect(admin.service.runAction('station', 1, '撤销站点').ok).toBe(true)
  })

  it('任一落库失败时状态不得先写入：内存与存储都保持原状', async () => {
    const { service, stub, storageKey } = await boot()
    // 先正常读一轮（页面打开就会做），再模拟落库失败
    expect(service.listEntries('station').total).toBe(3)
    stub.fail = true
    const result = service.runAction('station', 1, '撤销站点')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('落库失败')
    stub.fail = false

    // 内存缓存没有半截状态
    expect(rowOf(service.listEntries('station').items, 1).status).toBe('正常运行')
    expect(rowOf(service.listEntries('calibration').items, 1).status).toBe('待送检')

    // localStorage 里也没有写入撤销
    const persisted = JSON.parse(stub.data[storageKey]) as Record<string, EntryRow[]>
    expect(rowOf(persisted.station, 1).status).toBe('正常运行')
    expect(rowOf(persisted.calibration, 1).status).toBe('待送检')

    // 恢复后可以正常撤销
    expect(service.runAction('station', 1, '撤销站点').ok).toBe(true)
  })

  it('历史撤销站只读兼容：旧数据可读、镜像状态对齐、动作被拒', async () => {
    const legacy: Record<string, EntryRow[]> = {
      station: [
        {
          id: 9,
          status: '已撤销',
          pending: false,
          abnormal: true,
          '站点编号': 'STAT-0009',
          '站点名称': ' legacy老站',
          '站点类型': '水文站',
          '所在河流': '旧河',
          '经纬度坐标': '-',
          '建站年份': '1978',
          '管理单位': '老单位',
          '运行状态': '监测站点样例9',
        },
      ],
      inspection: [
        {
          id: 9,
          status: '发现故障',
          pending: true,
          abnormal: false,
          '记录编号': 'INSP-0009',
          '站点编号': 'STAT-0009',
          '巡检日期': '2025-12-01',
          '巡检人员': '老张',
          '检查项目': '-',
          '发现问题': '-',
          '处理措施': '-',
          '巡检状态': '巡检记录样例9',
        },
      ],
      calibration: [
        // 旧数据甚至没有站点编号字段
        {
          id: 9,
          status: '送检中',
          pending: true,
          abnormal: false,
          '记录编号': 'CALI-0009',
          '仪器编号': 'CALI-0009',
          '仪器名称': '老仪器',
          '检定单位': '-',
          '检定日期': '2025-11-01',
          '有效期至': '-',
          '检定结论': '-',
          '检定状态': '仪器检定样例9',
        },
      ],
    }
    const { service } = await boot({ preset: legacy })

    // 只读兼容：读得出，镜像状态字段按 status 对齐
    const station = rowOf(service.listEntries('station').items, 9)
    expect(station['运行状态']).toBe('已撤销')
    const inspection = rowOf(service.listEntries('inspection').items, 9)
    expect(inspection['巡检状态']).toBe('发现故障')

    // 历史撤销站本身只读：不能改状态，重复撤销也不再生效
    expect(service.runAction('station', 9, '登记故障').ok).toBe(false)
    expect(service.runAction('station', 9, '撤销站点').ok).toBe(false)

    // 其名下巡检记录只读
    const dispose = service.runAction('inspection', 9, '确认处置')
    expect(dispose.ok).toBe(false)
    expect(dispose.message).toContain('已撤销')

    // 没有站点编号的历史检定记录：不崩溃、不错误冻结，仍可正常流转
    const calibration = rowOf(service.listEntries('calibration').items, 9)
    expect(calibration['检定状态']).toBe('送检中')
    expect(service.runAction('calibration', 9, '确认合格').ok).toBe(true)
  })

  it('状态流转会同步镜像状态字段，列表与详情一致', async () => {
    const { service } = await boot()
    expect(service.runAction('station', 1, '登记故障').ok).toBe(true)
    const station = rowOf(service.listEntries('station').items, 1)
    expect(station.status).toBe('设备故障')
    expect(station['运行状态']).toBe('设备故障')
  })
})

describe('种子数据一致性', () => {
  it('站点编号、所在河流与镜像状态字段在列表和详情对得上', async () => {
    const { service } = await boot()
    const stations = service.listEntries('station').items
    const codes = new Set(stations.map((row) => String(row['站点编号'])))
    expect(codes.size).toBe(stations.length)
    for (const station of stations) {
      expect(String(station['所在河流'])).not.toContain('样例')
    }

    for (const meta of MODULES) {
      const mirror = meta.fields.find((field) => field.endsWith('状态'))
      expect(mirror, `${meta.key} 缺少镜像状态字段`).toBeTruthy()
      for (const row of service.listEntries(meta.key).items) {
        expect(row[mirror as string], `${meta.key}#${row.id} 镜像状态不一致`).toBe(row.status)
        // 关联模块的站点编号必须能在站点档案里对上（站点模块自身除外）
        if (meta.key !== 'station' && meta.fields.includes('站点编号')) {
          expect(codes.has(String(row['站点编号'])), `${meta.key}#${row.id} 站点编号对不上`).toBe(
            true,
          )
        }
      }
    }
  })
})
