<template>
  <section class="page" data-module="calibration-detail">
    <header class="page-head">
      <div>
        <h2>仪器检定详情</h2>
        <p class="page-desc">检定处置与列表入口执行同一核查：所属站点撤销后本页只读。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn ghost" to="/calibration">返回仪器检定列表</RouterLink>
      </div>
    </header>

    <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>
    <template v-else-if="entry">
      <section v-if="readonly" class="readonly-banner">{{ readonlyReason }}</section>

      <section class="detail-card">
        <h3>所属站点</h3>
        <dl class="detail-grid">
          <dt>站点编号</dt>
          <dd>{{ entry['所属站点'] || '—' }}</dd>
          <dt>所在河流</dt>
          <dd>{{ station ? station.river || '—' : '主档缺失' }}</dd>
          <dt>站点运行状态</dt>
          <dd>{{ station ? station.status : '主档缺失' }}</dd>
          <dt>站点详情</dt>
          <dd>
            <RouterLink v-if="stationRow" class="link" :to="`/station/${stationRow.id}`">查看站点</RouterLink>
            <span v-else>—</span>
          </dd>
        </dl>
      </section>

      <section class="detail-card">
        <h3>检定记录</h3>
        <dl class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>{{ entry[field] || '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ entry.status }}</dd>
        </dl>
        <div v-if="!readonly" class="detail-actions">
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
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import {
  getEntry,
  moduleMeta,
  runAction as applyAction,
  stationByCode,
  stationSnapshot,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('calibration')
const detailFields = ["记录编号", "仪器编号", "仪器名称", "检定单位", "检定日期", "有效期至", "检定结论", "检定状态"]
const actions = ["送出检定", "确认合格", "标记不合格"]

const route = useRoute()
const entry = ref<EntryRow | null>(null)
const errorMessage = ref('')

const station = computed(() =>
  entry.value ? stationSnapshot(String(entry.value['所属站点'] ?? '')) : null,
)
const stationRow = computed(() =>
  entry.value ? stationByCode(String(entry.value['所属站点'] ?? ''))?.row ?? null : null,
)
const readonly = computed(() => {
  if (!entry.value) {
    return true
  }
  const code = String(entry.value['所属站点'] ?? '').trim()
  if (!code) {
    return false
  }
  return station.value === null || station.value.status === '已撤销'
})
const readonlyReason = computed(() => {
  if (station.value === null) {
    return '所属站点在站点主档中不存在或已被删除，禁止检定处置，请先核对站点编号'
  }
  return `所属站点「${station.value.code}」已撤销，历史检定记录只读，不能再处置`
})

function runAction(action: string) {
  if (!entry.value) {
    return
  }
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(entry.value.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  load()
}

function load() {
  errorMessage.value = ''
  const found = getEntry(meta.key, Number(route.params.id))
  if (!found) {
    entry.value = null
    errorMessage.value = '没有找到该仪器检定记录'
    return
  }
  entry.value = found
}

watch(() => route.params.id, load, { immediate: true })
</script>
