<template>
  <section class="page" data-module="inspection">
    <header class="page-head">
      <div>
        <h2>巡检记录管理</h2>
        <p class="page-desc">维护巡检记录，围绕记录编号、站点编号、巡检日期、巡检人员做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" @click="exportRows">导出巡检记录清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <RouterLink class="link" :to="`/inspection/${row.id}`">详情</RouterLink>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="isReadonly(row)"
              :title="isReadonly(row) ? readonlyTitle(row) : ''"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无巡检记录数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条巡检记录记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  stationSnapshot,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('inspection')
const baseColumns = ["记录编号", "站点编号", "巡检日期", "巡检人员", "检查项目", "发现问题", "处理措施", "巡检状态"]
// 所在河流 / 站点运行状态不是巡检自带字段，统一从站点主档取，列表与详情同口径。
const columns = ["记录编号", "站点编号", "所在河流", "站点运行状态", "巡检日期", "巡检人员", "检查项目", "发现问题", "处理措施", "巡检状态"]
const actions = ["完成巡检", "报告故障", "确认处置"]
const statuses = ["待巡检", "已巡检", "发现故障", "已处置"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = baseColumns.slice(0, 3)

function displayValue(row: EntryRow, column: string): string | number | boolean {
  if (column === '所在河流' || column === '站点运行状态') {
    const station = stationSnapshot(String(row['站点编号'] ?? ''))
    if (!station) {
      return '主档缺失'
    }
    return column === '所在河流' ? station.river || '—' : station.status
  }
  return row[column] ?? '—'
}

function isReadonly(row: EntryRow): boolean {
  const station = stationSnapshot(String(row['站点编号'] ?? ''))
  return station === null || station.status === '已撤销'
}

function readonlyTitle(row: EntryRow): string {
  const station = stationSnapshot(String(row['站点编号'] ?? ''))
  return station === null ? '所属站点主档不存在，禁止处置' : '所属站点已撤销，历史记录只读'
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: "本月巡检次数", value: rows.value.length },
  { label: "已巡检站点", value: rows.value.filter((row) => String(row.status) !== '待巡检').length },
  { label: "待处置故障", value: rows.value.filter((row) => row.pending).length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '巡检记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '巡检记录列表读取失败'
  }
}

onMounted(reload)
</script>
