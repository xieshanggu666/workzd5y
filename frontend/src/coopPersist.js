// 协作增量同步状态本地持久化（规则 2.10.2）：
//
// 为什么需要：增量游标（run_seq/team_seq/exp_seq 三元组 + run_id/rev 锚点）
// 与「队伍动态」原本只活在内存里——页面刷新 / 关掉标签页 / 浏览器崩溃后全部
// 丢失，重进只能当「首次连接」走 reset 全量；而队长推进章节后，非队长客户端
// 的游标仍指向上一章 run，要等下一轮轮询触发 reset 才追上。游标与动态持久化
// 到 localStorage 后：
//   - 刷新/断线重连：先水合本地动态，再用持久化游标向服务端「补捞缺口」——
//     缺口期间的队友动作以动态文案保留（其结果已包含在权威视口里，历史帧不
//     逐帧补播，与全量入口语义一致），最后把游标锚定到服务端权威位置；
//   - 跨章切换：旧游标仍能补捞到 advance/settle 等队伍/远征事件，随后整体
//     替换为新章权威游标（旧游标自然淘汰，绝不拿旧 run 的游标回拉新章）；
//   - 重复帧隔离：每条动态有跨会话稳定的 id（run 动作按 run_id+seq、队伍/
//     远征事件按各自 seq），同一事件无论被几条恢复路径重复带回，只上屏一次。
//
// 存储按队伍分片：不同队伍的游标/动态互不可见；超过 TTL 的分片在读取时淘汰，
// 避免本地无限膨胀（隐私模式/配额不足时静默退化为仅内存生命周期）。
const CURSOR_STORAGE_KEY = 'cardrun_coop_cursor_v2'
const FEED_STORAGE_KEY = 'cardrun_coop_feed_v2'
const TTL_MS = 7 * 24 * 60 * 60 * 1000   // 游标/动态最多保留 7 天
const FEED_CAP = 30                       // 每队本地最多保留的动态条数

// 动作 -> 队伍动态文案（侧栏「最近动态」）
export const ACTION_TEXT = {
  create: '创建章节',
  choose_node: '选择了路线',
  play: '打出卡牌',
  end_turn: '结束回合',
  use_potion: '使用药水',
  claim_reward: '领取奖励',
  forge: '锻造卡牌',
  shop_buy: '完成购买',
  shop_remove: '移除卡牌',
  discard_potion: '丢弃药水',
  companion_set_mode: '调整伙伴',
  commission_accept: '接取委托',
  commission_claim: '领取委托奖励',
  encounter_choice: '奇遇抉择',
}

export const TEAM_EVENT_TEXT = {
  form: '队伍组建',
  join: '新成员加入',
  role: '角色调整',
  leave: '成员离队',
  disband: '队伍解散',
  start: '远征开赛',
  chapter_clear: '章节通关',
  advance: '进入下一章',
  settle: '远征结算',
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    const data = raw ? JSON.parse(raw) : {}
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeJson(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch { /* 隐私模式/配额不足：退化为仅内存生命周期 */ }
}

function pruneShards(all, now = Date.now()) {
  let changed = false
  for (const [tid, shard] of Object.entries(all)) {
    if (!shard || typeof shard !== 'object' || !shard.ts || now - shard.ts > TTL_MS) {
      delete all[tid]
      changed = true
    }
  }
  return changed
}

// ---------- 游标分片 ----------
// 结构：{ [teamId]: { cursor: <权威游标>, ts: number } }
export function saveCoopCursor(teamId, cursor) {
  if (!teamId || !cursor || !cursor.run_id) return
  const all = readJson(CURSOR_STORAGE_KEY)
  pruneShards(all)
  all[teamId] = { cursor: { ...cursor }, ts: Date.now() }
  writeJson(CURSOR_STORAGE_KEY, all)
}

export function loadCoopCursor(teamId) {
  if (!teamId) return null
  const all = readJson(CURSOR_STORAGE_KEY)
  const shard = all[teamId]
  if (!shard || !shard.cursor || !shard.cursor.run_id) return null
  const now = Date.now()
  if (!shard.ts || now - shard.ts > TTL_MS) {
    // 旧游标淘汰：过期分片删除，调用方按「无游标」处理（轮询自然走 reset）
    pruneShards(all)
    writeJson(CURSOR_STORAGE_KEY, all)
    return null
  }
  return { ...shard.cursor }
}

// ---------- 队伍动态分片 ----------
// 结构：{ [teamId]: Array<{ id, text, teamId, ts }> }，按 ts 新->旧排列。
export function loadCoopFeed(teamId) {
  if (!teamId) return []
  const all = readJson(FEED_STORAGE_KEY)
  const list = Array.isArray(all[teamId]) ? all[teamId] : null
  if (!list) return []
  const now = Date.now()
  const live = list.filter(
    (it) => it && it.id && it.text && it.ts && now - it.ts <= TTL_MS)
  if (live.length !== list.length) {
    if (live.length) all[teamId] = live
    else delete all[teamId]
    writeJson(FEED_STORAGE_KEY, all)
  }
  return live.map((it) => ({ ...it }))
}

// 合并本队新动态：按稳定 id 去重（跨会话/多恢复路径重复带回的同一事件只落
// 一次）。items 由调用方按「新 -> 旧」给出（轮询 reverse 后、水合分片同样
// 新->旧），合并时保持该顺序插入队首，仅按 TTL 过滤旧分片并截断到 FEED_CAP。
export function addCoopFeed(teamId, items) {
  if (!teamId || !Array.isArray(items) || !items.length) return
  const all = readJson(FEED_STORAGE_KEY)
  const now = Date.now()
  const existing = Array.isArray(all[teamId]) ? all[teamId] : []
  const live = existing.filter(
    (it) => it && it.id && it.text && it.ts && now - it.ts <= TTL_MS)
  const known = new Set(live.map((it) => it.id))
  const fresh = []
  for (const it of items) {
    if (!it || !it.id || !it.text || known.has(it.id)) continue
    known.add(it.id)
    fresh.push({
      id: it.id, text: it.text, teamId,
      ts: Number.isInteger(it.ts) ? it.ts : now,
    })
  }
  if (!fresh.length) return
  all[teamId] = [...fresh, ...live].slice(0, FEED_CAP)
  writeJson(FEED_STORAGE_KEY, all)
}

// ---------- 动态文案构造（轮询同步与重连补捞共用，保证 id 规则一致） ----------
function memberName(view, id) {
  const m = (view?.coop?.members || []).find((x) => x.id === id)
  return m ? `${m.icon || ''}${m.name}` : null
}

// 由一个 sync 响应构造队伍动态（旧->新顺序，调用方负责 reverse 后上交 store）。
// id 跨会话稳定：run 动作 = team:run:seq，队伍/远征事件 = team:t|e:seq——
// 同一条事件无论从轮询、reset 还是重连补捞回来，都不会重复上屏。
// 自己的动作（actor===myId）与 create 事件同在线路径一样跳过。
// 批内 ts 顺序分配（旧->新、毫秒递增）：历史补捞的多条文案上屏后保持服务端
// 原始先后，不会因同毫秒而被 id 字符串序打乱。
export function buildFeedItems(teamId, data, { myId = null, view = null } = {}) {
  if (!teamId || !data) return []
  const runId = data.cursor?.run_id || '?'
  const base = Date.now()
  let order = 0
  const item = (id, text) => ({ id, teamId, text, ts: base + order++ })
  const items = []
  for (const a of data.actions || []) {
    if (a.actor === myId || a.action === 'create') continue
    const who = memberName(view, a.actor)
    items.push(item(`${teamId}:a:${runId}:${a.seq}`,
                    `${who || '队友'} ${ACTION_TEXT[a.action] || a.action}`))
  }
  for (const e of data.team_events || []) {
    items.push(item(`${teamId}:t:${e.seq}`,
                    `👥 ${TEAM_EVENT_TEXT[e.kind] || e.kind}`))
  }
  for (const e of data.expedition_events || []) {
    if (e.kind === 'create') continue
    items.push(item(`${teamId}:e:${e.seq}`,
                    `🚩 ${TEAM_EVENT_TEXT[e.kind] || e.kind}`))
  }
  return items
}

// 本地提示（恢复流程的隔离/核对/补交文案）的唯一 id 生成：这类文案没有服务端
// seq，每次产生都是一条新提示，因此用进程内自增保证 key 稳定即可；带 teamId
// 的同样落盘，刷新后能看到恢复结论。
let localFeedSeq = 0
export function localFeedId() {
  localFeedSeq += 1
  return `local:${Date.now().toString(36)}:${localFeedSeq}`
}
