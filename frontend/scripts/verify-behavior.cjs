// 行为核查脚本：用 localStorage 垫片直跑本地数据服务，验证撤销/级联/越权/原子性。
const path = require('path')
const esbuild = require('esbuild')
const Module = require('module')

const store = new Map()
global.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (global.__failNextWrite) {
        global.__failNextWrite = false
        throw new Error('模拟落库失败')
      }
      store.set(k, String(v))
    },
  },
}

let svc
async function loadService() {
  const result = await esbuild.build({
    entryPoints: [path.resolve(__dirname, '../src/api/local-service.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    alias: { '@': path.resolve(__dirname, '../src') },
  })
  const code = result.outputFiles[0].text
  const m = new Module('service')
  m._compile(code, 'service.cjs')
  svc = m.exports
  return svc
}

let passed = 0
function check(name, cond, extra = '') {
  if (!cond) {
    console.error(`✗ ${name}${extra ? ` — ${extra}` : ''}`)
    process.exitCode = 1
  } else {
    passed += 1
    console.log(`✓ ${name}`)
  }
}

;(async () => {
  await loadService()
  const find = (key, id) => svc.getEntry(key, id)

  // 1. 站点主档口径：编号/河流/运行状态一致
  const snap = svc.stationSnapshot('STAT-0001')
  check('主档快照取到编号/河流/状态', snap.code === 'STAT-0001' && snap.river === '长江' && snap.status === '正常运行')

  // 2. 正常状态机流转 + 越权拒绝
  let r = svc.runAction('inspection', 1, '报告故障') // 待巡检 -> 报告故障 允许
  check('待巡检可报告故障', r.ok, r.message)
  r = svc.runAction('inspection', 1, '确认处置') // 发现故障才允许确认处置；当前是发现故障
  check('发现故障可确认处置', r.ok && find('inspection', 1).status === '已处置', r.message)
  r = svc.runAction('inspection', 1, '完成巡检') // 终态再动作 -> 越权
  check('终态再处置被拒绝(越权)', !r.ok, r.message)
  r = svc.runAction('calibration', 3, '送出检定') // 已合格 -> 送出检定 越权
  check('已合格仪器再送检定被拒绝', !r.ok, r.message)

  // 3. 历史撤销站只读兼容：STAT-0999 已撤销，其故障巡检(id5)与已合格检定(id5)
  r = svc.runAction('inspection', 5, '确认处置')
  check('历史撤销站巡检详情处置被拒', !r.ok && /只读/.test(r.message), r.message)
  // 注入一条「状态机本来允许、但站点已撤销」的检定待办，证明第二入口确实补了站点核查
  let seedRaw = JSON.parse(store.get('hydrology-monitor-station:entries'))
  seedRaw.calibration.push({
    id: 901, status: '送检中', pending: true, abnormal: false, 所属站点: 'STAT-0999',
  })
  store.set('hydrology-monitor-station:entries', JSON.stringify(seedRaw))
  await loadService()
  r = svc.runAction('calibration', 901, '确认合格')
  check('历史撤销站检定处置被拒(第二入口同核查)', !r.ok && /只读/.test(r.message), r.message)
  check('历史撤销站记录仍可读', find('inspection', 5) !== null && find('calibration', 5)?.status === '已合格')

  // 4. 悬空引用拒绝（状态机允许、但站点主档查不到）
  const raw = JSON.parse(store.get('hydrology-monitor-station:entries'))
  raw.calibration.push({ id: 902, status: '送检中', pending: true, abnormal: false, 所属站点: 'STAT-404' })
  store.set('hydrology-monitor-station:entries', JSON.stringify(raw))
  await loadService()
  r = svc.runAction('calibration', 902, '确认合格')
  check('悬空站点编号处置被拒', !r.ok && /主档/.test(r.message), r.message)

  // 5. 撤销 STAT-0002：级联收尾
  //    巡检 id3「发现故障 pending」-> pending=false 保留状态；检定 id2「送检中 pending」-> 已停用
  r = svc.runAction('station', 2, '撤销站点')
  check('撤销成功', r.ok && /只读/.test(r.message), r.message)
  const insp3 = find('inspection', 3)
  check('撤销后未办结巡检退出待办但保留原状态(只读兼容)', insp3.status === '发现故障' && insp3.pending === false)
  r = svc.runAction('inspection', 3, '确认处置')
  check('撤销站巡检详情不能再处置', !r.ok && /只读/.test(r.message), r.message)
  const cali2 = find('calibration', 2)
  check('撤销站检定待办停用且退出待办', cali2.status === '已停用' && cali2.pending === false)
  r = svc.runAction('calibration', 2, '标记不合格')
  check('撤销站检定列表/详情处置都被拒', !r.ok, r.message)
  // 已停用检定 id4 本来就终态；已合格历史不受影响
  check('非待办历史检定原样保留', find('calibration', 4).status === '已停用' && find('calibration', 3).status === '已合格')

  // 6. 重复撤销只生效一次
  const before = JSON.stringify(find('station', 2))
  r = svc.runAction('station', 2, '撤销站点')
  check('重复撤销被拒且不产生写入', !r.ok && /重复撤销/.test(r.message) && JSON.stringify(find('station', 2)) === before, r.message)

  // 7. 原子性：落库失败时状态不得先写入
  // 注入一条 STAT-0001 的待办巡检，用于验证失败时关联收尾也未发生
  const pre = JSON.parse(store.get('hydrology-monitor-station:entries'))
  pre.inspection.push({ id: 102, status: '发现故障', pending: true, abnormal: true, 站点编号: 'STAT-0001' })
  store.set('hydrology-monitor-station:entries', JSON.stringify(pre))
  await loadService()
  const station1Before = find('station', 1).status
  global.__failNextWrite = true
  r = svc.runAction('station', 1, '撤销站点')
  check('落库失败返回失败', !r.ok && /落库失败/.test(r.message), r.message)
  const afterRaw = JSON.parse(store.get('hydrology-monitor-station:entries'))
  check('落库失败后站点状态未写入', afterRaw.station.find((x) => x.id === 1).status === station1Before)
  check('落库失败后关联业务未被收尾', afterRaw.inspection.find((x) => x.id === 102).pending === true)

  // 8. 撤销 STAT-0001 成功后，巡检待办(id1 已处置跳过; id4 已处置) 与检定待办 id1 一并收尾
  r = svc.runAction('station', 1, '撤销站点')
  check('撤销 STAT-0001 成功', r.ok, r.message)
  check('其待送检仪器被停用', find('calibration', 1).status === '已停用' && find('calibration', 1).pending === false)
  check('站点为已撤销终态', find('station', 1).status === '已撤销')
  check('撤销态升级/故障动作越权',
    !svc.runAction('station', 1, '升级为加强').ok && !svc.runAction('station', 1, '登记故障').ok)

  console.log(`\n${passed} 项核查通过`)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
