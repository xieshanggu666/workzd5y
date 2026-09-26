// 未确认操作持久化（协作远征断线恢复 2.10.1）：
// 动作请求「发出前」登记一条意图（request_id + 动作体 + 章节锚点），拿到
// 服务端终态响应（成功/400/403）后清除；只有「请求结果未知」（网络中断、
// 响应丢失）的意图会留在 localStorage 里，重连后由 coopRecovery 先核对
// 服务端结果（GET .../requests/{id}）再决定补交——已落库的只对齐不补交，
// 未到达的以同一 request_id 补交（服务端幂等保证只生效一次）。
//
// 按 run_id（章节 run）分组存储：跨章切换后旧章节 run 的意图被隔离，绝不
// 补交进新章节（避免把旧章的扣款/发奖/播放带到新章）。
const STORAGE_KEY = 'cardrun_pending_acts_v1'
const MAX_AGE_MS = 24 * 60 * 60 * 1000  // 超过一天的未确认意图不再自动补交

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const data = raw ? JSON.parse(raw) : {}
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeAll(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch { /* 隐私模式/配额不足：退化为仅内存生命周期 */ }
}

function groupOf(all, runId) {
  const g = all[runId]
  return g && Array.isArray(g.items) ? g : { run_id: runId, items: [] }
}

// 登记一条即将发出的意图（同一 request_id 重复登记为幂等覆盖，保持最早 ts）。
// chapter/teamId 仅作锚点展示与隔离判断；body 必须不含 request_id/member_id
// 之外的服务端瞬态字段（由提交层补入）。
export function recordPending({ runId, requestId, body, chapter = null, teamId = null,
                                kind = null }) {
  if (!runId || !requestId) return
  const all = readAll()
  const g = groupOf(all, runId)
  const idx = g.items.findIndex((it) => it.requestId === requestId)
  const now = Date.now()
  if (idx >= 0) {
    g.items[idx] = { ...g.items[idx], body, kind, chapter, teamId, ts: g.items[idx].ts || now }
  } else {
    g.items.push({ requestId, body, kind, chapter, teamId, ts: now })
  }
  all[runId] = g
  writeAll(all)
}

// 意图已有终态结论（成功响应/400/403/放弃）：移除。
export function clearPending(runId, requestId) {
  if (!runId || !requestId) return
  const all = readAll()
  const g = groupOf(all, runId)
  const next = g.items.filter((it) => it.requestId !== requestId)
  if (next.length) {
    all[runId] = { ...g, items: next }
  } else {
    delete all[runId]
  }
  writeAll(all)
}

export function listPending(runId = null) {
  const all = readAll()
  if (runId) return groupOf(all, runId).items.slice()
  return Object.values(all).flatMap((g) => (Array.isArray(g.items) ? g.items : []))
}

// 跨章隔离：丢弃「同一队伍、但已离开的旧章节 run」的全部意图——远征已推进，
// 旧章 run 不再接受这些动作，补交进新章=重复扣款/发奖/播放，必须隔离。
// 只按 teamId 匹配：其他队伍/单人局的意图不受影响（它们各自的重连入口会
// 独立核对）。返回被丢弃的意图，供恢复流程给出提示。
export function dropStaleChapterPending(teamId, keepRunId) {
  const all = readAll()
  const dropped = []
  for (const [rid, g] of Object.entries(all)) {
    if (rid === keepRunId || !Array.isArray(g.items)) continue
    const stale = g.items.filter((it) => it.teamId === teamId)
    if (!stale.length) continue
    dropped.push(...stale)
    const rest = g.items.filter((it) => it.teamId !== teamId)
    if (rest.length) {
      all[rid] = { ...g, items: rest }
    } else {
      delete all[rid]
    }
  }
  if (dropped.length) writeAll(all)
  return dropped
}

// 丢弃过期（MAX_AGE_MS 前登记）的意图，返回被丢弃列表。
export function dropExpiredPending(now = Date.now()) {
  const all = readAll()
  const dropped = []
  for (const g of Object.values(all)) {
    if (!Array.isArray(g.items)) continue
    g.items = g.items.filter((it) => {
      const stale = !it.ts || now - it.ts > MAX_AGE_MS
      if (stale) dropped.push(it)
      return !stale
    })
  }
  for (const [rid, g] of Object.entries(all)) {
    if (!g.items || !g.items.length) delete all[rid]
  }
  if (dropped.length) writeAll(all)
  return dropped
}

export function clearAllPending() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}
