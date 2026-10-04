<template>
  <section class="page" data-module="station-detail">
    <header class="page-head">
      <div>
        <h2>监测站点详情</h2>
        <p class="page-desc">站点编号、所在河流、运行状态均取自站点主档；列表与本页同口径。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/station">返回监测站点列表</RouterLink>
      </div>
    </header>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <template v-else-if="station">
      <section v-if="revoked" class="readonly-banner">
        站点已撤销：本页与关联巡检、检定记录一律只读，不接受任何处置。
      </section>

      <section class="detail-card">
        <h3>站点主档</h3>
        <dl class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ displayValue(field) }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ station.status }}</dd>
        </dl>
        <div v-if="!revoked" class="detail-actions">
          <button
            v-for="action in actions"
            :key="action"
            class="btn"
            type="button"
            @click="runAction(action)"
          >
            {{ action }}
          </button>
        </div>
      </section>

      <section class="detail-card">
        <h3>关联巡检记录</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>记录编号</th>
              <th>巡检日期</th>
              <th>巡检人员</th>
              <th>巡检状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in related.inspection" :key="String(row.id)">
              <td>{{ row['记录编号'] }}</td>
              <td>{{ row['巡检日期'] }}</td>
              <td>{{ row['巡检人员'] }}</td>
              <td>{{ row.status }}</td>
              <td><RouterLink class="link" :to="`/inspection/${row.id}`">巡检详情</RouterLink></td>
            </tr>
            <tr v-if="!related.inspection.length">
              <td colspan="5" class="empty-state">暂无关联巡检记录</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="detail-card">
        <h3>关联仪器检定记录</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>记录编号</th>
              <th>仪器编号</th>
              <th>仪器名称</th>
              <th>检定状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in related.calibration" :key="String(row.id)">
              <td>{{ row['记录编号'] }}</td>
              <td>{{ row['仪器编号'] }}</td>
              <td>{{ row['仪器名称'] }}</td>
              <td>{{ row.status }}</td>
              <td><RouterLink class="link" :to="`/calibration/${row.id}`">检定详情</RouterLink></td>
            </tr>
            <tr v-if="!related.calibration.length">
              <td colspan="5" class="empty-state">暂无关联检定记录</td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  getEntry,
  moduleMeta,
  relatedEntries,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('station')
const detailFields = ["站点编号", "站点名称", "站点类型", "所在河流", "经纬度坐标", "建站年份", "管理单位"]
const actions = ["升级为加强", "登记故障", "撤销站点"]

const route = useRoute()
const station = ref<EntryRow | null>(null)
const related = ref<{ inspection: EntryRow[]; calibration: EntryRow[] }>({ inspection: [], calibration: [] })
const errorMessage = ref('')

const revoked = computed(() => String(station.value?.status ?? '') === '已撤销')

// 运行状态字段与 status 同源，避免详情与列表各显示一份对不上。
function displayValue(field: string): string | number | boolean {
  if (!station.value) {
    return '—'
  }
  return station.value[field] ?? '—'
}

function runAction(action: string) {
  if (!station.value) {
    return
  }
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(station.value.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  load()
}

function load() {
  errorMessage.value = ''
  const entry = getEntry(meta.key, Number(route.params.id))
  if (!entry) {
    station.value = null
    related.value = { inspection: [], calibration: [] }
    errorMessage.value = '没有找到该监测站点'
    return
  }
  station.value = entry
  const code = String(entry['站点编号'] ?? '')
  related.value = relatedEntries(code)
}

watch(() => route.params.id, load, { immediate: true })
</script>
