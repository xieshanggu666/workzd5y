import { loadCoopCursorState, saveCoopCursorAnchor, saveCoopCursorAdvance,
         SEEN_LIMIT } from './coopPersist'

const BASE = '/api'

// 行动请求并发控制：
// - expectedRev：当前视口的存档版本号，服务端据此拒绝基于过期状态的提交（409 状态冲突）
// - 每个新意图生成 request_id 做请求级幂等；网络超时后的同一重试复用同一 id，
//   服务端返回首次结果，不会重复扣款/发奖（双击/重复请求同理）
let expectedRev = null

// 多人协作远征（2.9.0）：当前队伍成员身份（入会响应里的 me.id）。协作章节 run
// 的每个动作都带 member_id，服务端据此做角色权限边界（越权 403、零副作用）。
let currentMemberId = null

// 协作增量同步（2.10.0）：客户端游标，锚定三条日志的已读位置
// （章节 run 动作日志 run_seq / 队伍时间线 team_seq / 远征事件 exp_seq）。
// 由全量入口（getCoopExpedition）锚定、sync 响应持续推进；2.10.2 起按队伍
// 持久化到 localStorage（coopPersist），刷新/断线后恢复本地游标继续增量
// 跟随——离线窗口的队友动作照常补播，不再一律 reset 全量对齐。
let coopCursor = null
let coopCursorTeam = null  // 当前游标归属的队伍（持久化键）

export function getCoopCursor() {
  return coopCursor
}

// 权威游标整体锚定（全量入口 / sync reset 回包）：游标之前的动作视为已随
// 全量视口应用（seen 地板抬到 run_seq）；跨章切换时旧章游标/帧记录一并淘汰。
export function setCoopCursor(cursor, teamId = null) {
  if (teamId) coopCursorTeam = teamId
  coopCursor = cursor ? { ...cursor } : null
  if (coopCursorTeam && coopCursor?.run_id) {
    saveCoopCursorAnchor(coopCursorTeam, coopCursor)
  }
}

// 游标单调推进（断线恢复 2.10.1）：迟到的旧响应（章节切换前发出的 sync）
// 不得把游标/版本锚点往回拉。run_id 变化（章节推进）时整体替换——这是唯一
// 合法的「游标重置」；同 run 时各 seq/rev 只前进不后退。
// 注意：本地自己的动作【不】推进游标——自己的动作会随下一次增量回到客户端，
// 由同步器按 actor 过滤（自己的动作不补播、不进队伍动态）；若用本地 seq 推进
// 游标，会把「自己动作之前、尚未看到的队友动作」一并跳过（补播永久缺失）。
export function advanceCoopCursor(next, teamId = null) {
  if (!next || !next.run_id) return
  if (teamId) coopCursorTeam = teamId
  if (!coopCursor || coopCursor.run_id !== next.run_id) {
    coopCursor = { ...next }
  } else {
    const max = (a, b) => (Number.isInteger(a) && Number.isInteger(b) ? Math.max(a, b) : (b ?? a))
    coopCursor = {
      ...next,
      run_seq: max(coopCursor.run_seq, next.run_seq),
      team_seq: max(coopCursor.team_seq, next.team_seq),
      exp_seq: max(coopCursor.exp_seq, next.exp_seq),
      rev: max(coopCursor.rev, next.rev),
    }
  }
  // 增量推进随落盘（seen 帧记录保留）：刷新后按已应用前沿回退恢复
  if (coopCursorTeam) saveCoopCursorAdvance(coopCursorTeam, coopCursor)
}

// 本地游标是否可继续增量跟随：同章、未超前、未落后超过服务端增量上限
// （落后更多服务端本就 reset，直接以权威锚定省一轮往返）。
function usableCoopCursor(candidate, authoritative) {
  if (!candidate || candidate.run_id !== authoritative.run_id) return false
  const le = (a, b) => !Number.isInteger(a) || !Number.isInteger(b) || a <= b
  if (!le(candidate.run_seq, authoritative.run_seq)) return false
  if (!le(candidate.team_seq, authoritative.team_seq)) return false
  if (!le(candidate.exp_seq, authoritative.exp_seq)) return false
  if (Number.isInteger(candidate.run_seq) && Number.isInteger(authoritative.run_seq)
      && authoritative.run_seq - candidate.run_seq > SEEN_LIMIT) return false
  return true
}

// 全量对齐时的游标锚定（2.10.2：进入协作远征 / 断线重连恢复）。
// 会话内游标或本地持久化游标仍指向同一章节 run 且可继续增量时，保留本地
// 位置（持久化游标已按已应用前沿回退）——离线窗口的队友动作由随后的增量
// 同步逐帧补播，已播的凭已应用帧记录隔离，不漏不重；否则（首次进入/跨章/
// 游标失效）以权威游标整体锚定。返回最终生效的游标。
export function anchorCoopCursor(teamId, authoritative) {
  if (teamId) coopCursorTeam = teamId
  if (!teamId || !authoritative || !authoritative.run_id) {
    setCoopCursor(authoritative, teamId)
    return coopCursor
  }
  if (usableCoopCursor(coopCursor, authoritative)) {
    return coopCursor  // 会话内游标仍然有效（断线重连最常见路径）
  }
  const persisted = loadCoopCursorState(teamId)?.cursor || null
  if (usableCoopCursor(persisted, authoritative)) {
    coopCursor = persisted  // 刷新后恢复本地游标；不覆盖持久化的完整游标
    return coopCursor
  }
  setCoopCursor(authoritative, teamId)
  return coopCursor
}

export function setExpectedRev(rev) {
  if (Number.isInteger(rev)) expectedRev = rev
}

export function setCurrentMemberId(id) {
  currentMemberId = id || null
}

export function getCurrentMemberId() {
  return currentMemberId
}

export class ConflictError extends Error {
  constructor(detail) {
    super(detail || '状态已变化，请刷新后重试')
    this.status = 409
  }
}

// 协作权限边界：角色无权提交该动作（战斗位做资源动作/反之）。不自动重试，
// 由调用方提示——这是明确的 403 而非并发冲突，刷新视口也不会改变授权结果。
export class ForbiddenError extends Error {
  constructor(detail) {
    super(detail || '你的角色无权执行该操作')
    this.status = 403
  }
}

// 请求未能拿到任何 HTTP 终态（断网/DNS/超时/连接重置）：服务端是否已生效
// 未知。调用方必须保留未确认意图，重连后先核对再决定补交；绝不能当成失败
// 直接重发（否则可能重复扣款/发奖）。
export class NetworkError extends Error {
  constructor(cause) {
    super(cause?.message || '网络中断，操作结果待确认')
    this.name = 'NetworkError'
    this.cause = cause || null
  }
}

let reqSeq = 0
function newRequestId() {
  reqSeq += 1
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${reqSeq}`
}

// 为「一个意图」生成幂等令牌：同一意图的首次提交与所有重试共用同一令牌，
// 服务端只生效一次（双击/断线补交/409 重试都安全）。
export function makeRequestId() {
  return newRequestId()
}

async function j(url, opts) {
  let res
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    })
  } catch (e) {
    // fetch 层失败：没有任何 HTTP 响应，服务端结果未知（可能已生效）
    throw new NetworkError(e)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 409) throw new ConflictError(data.detail)
    if (res.status === 403) throw new ForbiddenError(data.detail)
    throw new Error(data.detail || `HTTP ${res.status}`)
  }
  return data
}

export const api = {
  cards: () => j(`${BASE}/cards`),
  async createRun(seed) {
    const data = await j(`${BASE}/runs`, { method: 'POST', body: JSON.stringify({ seed }) })
    setExpectedRev(data.rev)
    return data
  },
  async resume(id) {
    const data = await j(`${BASE}/runs/${id}/resume${currentMemberId ? `?member_id=${encodeURIComponent(currentMemberId)}` : ''}`)
    setExpectedRev(data.rev)
    return data
  },
  replay: (id) => j(`${BASE}/runs/${id}/replay`),

  // 未确认操作核对（断线恢复 2.10.1）：landed（已生效，附 seq/rev/chapter）
  // 或 unknown（未到达/被写入前校验拒绝）。协作 run 带成员身份，只读。
  probeRequest: (id, requestId) => {
    const suffix = currentMemberId
      ? `?member_id=${encodeURIComponent(currentMemberId)}`
      : ''
    return j(`${BASE}/runs/${id}/requests/${encodeURIComponent(requestId)}${suffix}`)
  },

  // ---------- 多章远征 ----------
  async createExpedition(seed, chapters) {
    const data = await j(`${BASE}/expeditions`, {
      method: 'POST',
      body: JSON.stringify({ seed, chapters }),
    })
    if (Number.isInteger(data.run?.rev)) setExpectedRev(data.run.rev)
    return data
  },
  async getExpedition(id) {
    const data = await j(`${BASE}/expeditions/${id}`)
    if (Number.isInteger(data.run?.rev)) setExpectedRev(data.run.rev)
    return data
  },
  expeditionReplay: (id) => j(`${BASE}/expeditions/${id}/replay`),
  async advanceExpedition(id, { retryKey } = {}) {
    // 与 run 行动同理：request_id 幂等，重复/并发提交返回首次结果，不会重复开章
    const requestId = retryKey || newRequestId()
    const data = await j(`${BASE}/expeditions/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId }),
    })
    if (Number.isInteger(data.run?.rev)) setExpectedRev(data.run.rev)
    return data
  },

  act: async (id, action, { retryKey } = {}) => {
    // retryKey：调用方在“重试同一个意图”时显式传入；缺省每个调用一个新令牌
    const requestId = retryKey || newRequestId()
    const body = { ...action, request_id: requestId }
    // 协作远征：动作带成员身份（普通局/单人远征服务端忽略该字段）
    if (currentMemberId) body.member_id = currentMemberId
    if (expectedRev !== null) body.expected_rev = expectedRev
    try {
      const data = await j(`${BASE}/runs/${id}/act`, { method: 'POST', body: JSON.stringify(body) })
      if (Number.isInteger(data.rev)) expectedRev = data.rev
      // 同步游标只随服务端 sync/全量响应推进；自己的动作会经下一次增量回来，
      // 由同步器按 actor 过滤，不在这里本地推进（避免跳过未看到的队友动作）
      return data
    } catch (e) {
      // 状态冲突：版本号已失效，清掉避免后续请求继续带旧值；调用方应刷新续局
      if (e instanceof ConflictError) expectedRev = null
      throw e
    }
  },

  // ---------- 多人协作远征（2.9.0） ----------
  createCoopTeam: ({ name, captainName, seed, chapters }) =>
    j(`${BASE}/coop/teams`, {
      method: 'POST',
      body: JSON.stringify({
        name: name || null,
        captain_name: captainName || null,
        seed: seed ?? null,
        chapters: chapters ?? null,
      }),
    }),
  joinCoopTeam: (code, memberName, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/join`, {
      method: 'POST',
      body: JSON.stringify({
        code,
        member_name: memberName || null,
        request_id: retryKey || newRequestId(),
      }),
    }),
  getCoopTeam: (teamId, memberId = currentMemberId) =>
    j(`${BASE}/coop/teams/${teamId}${memberId ? `?member_id=${encodeURIComponent(memberId)}` : ''}`),
  assignRole: (teamId, targetId, role, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/roles`, {
      method: 'POST',
      body: JSON.stringify({
        member_id: currentMemberId, target_id: targetId, role,
        request_id: retryKey || newRequestId(),
      }),
    }),
  leaveCoopTeam: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/leave`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }),
  disbandCoopTeam: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/disband`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }),
  startCoopExpedition: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/start`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }).then((data) => {
      if (Number.isInteger(data?.run?.rev)) setExpectedRev(data.run.rev)
      return data
    }),
  advanceCoopExpedition: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/advance`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }).then((data) => {
      if (Number.isInteger(data?.run?.rev)) setExpectedRev(data.run.rev)
      return data
    }),
  getCoopExpedition: (teamId, memberId = currentMemberId) =>
    j(`${BASE}/coop/teams/${teamId}/expedition${memberId ? `?member_id=${encodeURIComponent(memberId)}` : ''}`)
      .then((data) => {
        if (Number.isInteger(data?.run?.rev)) setExpectedRev(data.run.rev)
        return data
      }),
  // 增量同步（2.10.0）：带客户端游标，服务端返回三条日志的增量事件；
  // 游标缺失/错乱/落后过多时 reset 全量视口（断线重连同路径）
  syncCoop: (teamId, cursor = coopCursor) => {
    const q = new URLSearchParams()
    if (currentMemberId) q.set('member_id', currentMemberId)
    if (cursor?.run_id) q.set('run_id', cursor.run_id)
    q.set('run_seq', cursor?.run_seq ?? 0)
    q.set('team_seq', cursor?.team_seq ?? 0)
    q.set('exp_seq', cursor?.exp_seq ?? 0)
    return j(`${BASE}/coop/teams/${teamId}/sync?${q.toString()}`)
  },
  coopTeamReplay: (teamId) => j(`${BASE}/coop/teams/${teamId}/replay`),
}
