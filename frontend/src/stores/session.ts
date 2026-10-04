import { defineStore } from 'pinia'

export type OperatorRole = '管理员' | '操作员' | '访客'

// 需要提权的动作：只有管理员能执行，其余角色一律越权拒绝。
const ELEVATED_ACTIONS = ['撤销站点']

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: '管理员' as OperatorRole,
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0 && state.role !== '访客',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: OperatorRole) {
      this.role = role
    },
    // 服务层在每次写操作前调用：无权就拒绝，页面按钮藏不藏都不能绕过。
    permits(action: string): boolean {
      if (!this.canOperate) {
        return false
      }
      if (ELEVATED_ACTIONS.includes(action)) {
        return this.role === '管理员'
      }
      return true
    },
  },
})
