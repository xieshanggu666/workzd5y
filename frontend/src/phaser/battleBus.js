// React <-> Phaser 事件总线。React 在播放服务端结算日志时调用 emit，Phaser 场景订阅并播放动画。
const _listeners = new Map()

// Phaser 场景是否已就绪（create 后置 true，销毁时回 false）。断线恢复补交
// 战斗动作时场景可能刚随新视口挂载，需等就绪再发结算帧，避免帧被空监听吞掉。
let sceneReady = false
const _readyWaiters = new Set()

export const bus = {
  on(event, fn) {
    if (!_listeners.has(event)) _listeners.set(event, [])
    _listeners.get(event).push(fn)
    return () => {
      const arr = _listeners.get(event) || []
      _listeners.set(
        event,
        arr.filter((f) => f !== fn),
      )
    }
  },
  emit(event, payload) {
    ;(_listeners.get(event) || []).forEach((fn) => fn(payload))
  },
  clear() {
    _listeners.clear()
  },
  // 场景就绪状态（由 BattleScene 在 create/destroy 时维护）
  isSceneReady() {
    return sceneReady
  },
  setSceneReady(ready) {
    sceneReady = !!ready
    if (sceneReady) {
      const waiters = Array.from(_readyWaiters)
      _readyWaiters.clear()
      waiters.forEach((fn) => fn())
    }
  },
}

// 等待 Phaser 场景就绪；已就绪立即 resolve；超时兜底（场景挂载失败时也不
// 让补交管线永久挂起，帧静默跳过、视口仍以权威快照对齐）。
export function waitForBattleBus(timeoutMs = 4000) {
  if (sceneReady) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(finish, timeoutMs)
    function finish() {
      if (settled) return
      settled = true
      _readyWaiters.delete(finish)
      clearTimeout(timer)
      resolve()
    }
    _readyWaiters.add(finish)
  })
}

// 把一串结算事件交给 Phaser 按顺序播放；resolve 时整条连锁已播完。
// 本地动作（BattleView）与协作增量同步（coopSync）共用同一套播放，
// 保证「自己操作」与「队友操作补播」的逐帧表现一致。超时兜底防止动画
// 异常让操作永久锁死。
export function playBattleLog(entries, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const list = (entries || []).filter(Boolean)
    if (!list.length) return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      off()
      clearTimeout(timer)
      resolve()
    }
    const off = bus.on('queue_done', finish)
    const timer = setTimeout(finish, timeoutMs)
    bus.emit('queue', list)
  })
}
