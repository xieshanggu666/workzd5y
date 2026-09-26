// 协作增量同步状态本地持久化（规则 2.10.2 客户端侧）：
//
// 为什么需要：2.10.0/2.10.1 的游标与队伍动态只存在内存里——页面一刷新，
// 游标丢失，首轮同步只能 reset 全量对齐：离线窗口内队友的动作不再逐帧
// 补播（等于漏掉队友动作）；队伍动态侧栏也清空。本模块把这三样状态按
// 队伍落 localStorage，重连/刷新/跨章后恢复：
//
//   ① 游标（cursor）：服务端权威三元组 + rev/章节锚点。每次 sync/全量入口
//      都落盘；刷新后 anchorCoopCursor 优先保留本地游标（仍指向同一章节
//      run、未超前、未落后过多时），首轮同步即增量——离线窗口的队友动作
//      照常逐帧补播，不再一律 reset。
//   ② 已应用帧窗口（seen）：游标落盘【先于】补播完成（sync 回包先推进
//      游标、再逐帧播放），若刷新恰好发生在补播途中，朴素恢复会把未播
//      完的动作整段丢掉。恢复时按「已应用前沿」把 run_seq 回退到「其上
//      的动作全部已应用」的位置，让服务端重发未播动作；已播动作凭 seen
//      隔离不再补播第二次（重复帧隔离）。seen 按 seq 顺序登记，恒为已
//      应用前缀，容量与服务端 SYNC_ACTION_LIMIT 对齐（落后更多本就 reset）。
//   ③ 队伍动态（feed）：最近若干条（带去重键），刷新后恢复侧栏；同一
//      事件（动作/队伍时间线/远征事件）凭去重键绝不重复入栏——游标回退
//      重发时动态不会出现两遍。
//
// 旧游标淘汰：同队章节推进（run_id 变化）时游标/帧记录整体替换；长期
// 未用的队伍按存活期（与未确认意图同 24h）+ 队数上限（LRU）淘汰。
const STORAGE_KEY = 'cardrun_coop_sync_v1'
const MAX_AGE_MS = 24 * 60 * 60 * 1000  // 超过一天的同步状态视为失效（服务端多半也已 reset）
const MAX_TEAMS = 8                     // 本地最多保留最近若干队伍（超出 LRU 淘汰）
export const SEEN_LIMIT = 64            // 已应用帧窗口：与服务端 SYNC_ACTION_LIMIT 对齐
const FEED_LIMIT = 12                   // 持久化动态条数（与侧栏窗口一致）
const FEED_DK_LIMIT = 64                // 动态去重键记忆窗口（大于展示窗口，滚出后重发仍可隔离）

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const data = raw ? JSON.parse(raw) : {}
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

// 落盘即顺带淘汰：存活期过期 + 队数上限 LRU
function writeAll(data) {
  const now = Date.now()
  for (const [tid, e] of Object.entries(data)) {
    if (!e || typeof e !== 'object' || !e.savedAt || now - e.savedAt > MAX_AGE_MS) {
      delete data[tid]
    }
  }
  const ids = Object.keys(data)
  if (ids.length > MAX_TEAMS) {
    ids.sort((a, b) => (data[a].savedAt || 0) - (data[b].savedAt || 0))
    for (const tid of ids.slice(0, ids.length - MAX_TEAMS)) delete data[tid]
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch { /* 隐私模式/配额不足：退化为仅内存生命周期 */ }
}

function freshEntry() {
  return { cursor: null, seen: null, feed: [], dks: [], savedAt: Date.now() }
}

// 取某队的同步状态：过期/损坏视为不存在（不返回 null 的调用方自行兜底）
function entryOf(all, teamId) {
  const e = all[teamId]
  if (!e || typeof e !== 'object') return null
  if (!e.savedAt || Date.now() - e.savedAt > MAX_AGE_MS) return null
  return e
}

// ---------- 游标 + 已应用帧 ----------

// 读持久化游标，返回 {cursor, seen}；cursor.run_seq 已按「已应用前沿」回退。
// 游标落盘先于补播完成时（刷新/崩溃发生在补播途中），把 run_seq 回退到
// 「其上的动作全部已应用」的位置，未播动作由服务端重发继续补播、已播的
// 由 seen 隔离。无帧记录的游标保守不回退（无法判定应用位置，宁可不重放）。
export function loadCoopCursorState(teamId) {
  if (!teamId) return null
  const e = entryOf(readAll(), teamId)
  if (!e?.cursor?.run_id) return null
  const cursor = { ...e.cursor }
  const seen = e.seen && e.seen.run_id === cursor.run_id ? e.seen : null
  const nowSeq = Number.isInteger(cursor.run_seq) ? cursor.run_seq : 0
  // 无 seen：游标之前视为已随全量视口应用（floor=当前 seq，不回退）
  const floor = seen ? (seen.floor || 0) : nowSeq
  const applied = new Set(seen?.seqs || [])
  let runSeq = nowSeq
  while (runSeq > floor && !applied.has(runSeq)) runSeq -= 1
  return { cursor: { ...cursor, run_seq: runSeq }, seen }
}

// 权威锚定（全量入口 / reset 回包）：游标之前的动作视为已随全量视口
// 应用——seen 地板抬到 run_seq、增量帧记录清空。跨章（run_id 变化）时
// 旧章游标与帧记录由此整体替换淘汰。
export function saveCoopCursorAnchor(teamId, cursor) {
  if (!teamId || !cursor?.run_id) return
  const all = readAll()
  const e = entryOf(all, teamId) || freshEntry()
  e.cursor = { ...cursor }
  e.seen = { run_id: cursor.run_id, floor: cursor.run_seq ?? 0, seqs: [] }
  e.savedAt = Date.now()
  all[teamId] = e
  writeAll(all)
}

// 增量推进（sync 非 reset 回包）：同章保留 seen（floor+已应用帧），仅
// 游标前移；跨章/无记录时按权威替换（旧章帧记录淘汰，已对齐部分为地板）。
export function saveCoopCursorAdvance(teamId, cursor) {
  if (!teamId || !cursor?.run_id) return
  const all = readAll()
  const e = entryOf(all, teamId) || freshEntry()
  const keepSeen = e.seen && e.seen.run_id === cursor.run_id
  e.cursor = { ...cursor }
  if (!keepSeen) {
    e.seen = { run_id: cursor.run_id, floor: cursor.run_seq ?? 0, seqs: [] }
  }
  e.savedAt = Date.now()
  all[teamId] = e
  writeAll(all)
}

// 登记「已应用」的动作帧（严格按 seq 顺序调用，保证 seen 是连续前缀）。
// 战斗动作在逐帧补播【完成后】登记；自己的动作/无帧动作随权威视口对齐
// 即登记。游标已指向新章时，旧章迟到登记直接丢弃（跨章淘汰）。
export function markCoopActionsApplied(teamId, runId, seqs) {
  if (!teamId || !runId || !Array.isArray(seqs) || !seqs.length) return
  const all = readAll()
  const e = entryOf(all, teamId) || freshEntry()
  if (e.cursor?.run_id && e.cursor.run_id !== runId) return
  const seen = e.seen && e.seen.run_id === runId
    ? e.seen
    // 防御：游标同章但帧记录缺失，地板取游标当前位置，避免恢复时误回退
    : { run_id: runId, floor: e.cursor?.run_id === runId ? (e.cursor.run_seq ?? 0) : 0, seqs: [] }
  const merged = new Set([
    ...seen.seqs,
    ...seqs.filter((s) => Number.isInteger(s) && s > (seen.floor || 0)),
  ])
  seen.seqs = [...merged].sort((a, b) => a - b).slice(-SEEN_LIMIT)
  e.seen = seen
  e.savedAt = Date.now()
  all[teamId] = e
  writeAll(all)
}

// 重复帧隔离：该动作是否已经应用（地板之前，或已登记的已应用帧）。
export function isCoopActionApplied(teamId, runId, seq) {
  if (!teamId || !runId || !Number.isInteger(seq)) return false
  const e = entryOf(readAll(), teamId)
  if (!e?.seen || e.seen.run_id !== runId) return false
  return seq <= (e.seen.floor || 0) || e.seen.seqs.includes(seq)
}

// ---------- 队伍动态 ----------

// 恢复本地保存的最近动态（新在前，只含展示所需字段；React key 由 store 重排）
export function loadCoopFeed(teamId) {
  if (!teamId) return []
  const e = entryOf(readAll(), teamId)
  if (!e || !Array.isArray(e.feed)) return []
  return e.feed
    .filter((it) => it && it.text)
    .map((it) => ({ text: it.text, dk: it.dk || null }))
}

// 落盘当前动态窗口（新在前），并把去重键记忆窗口滚动到 FEED_DK_LIMIT：
// 已滚出展示窗口的事件重发时仍能被隔离。
export function saveCoopFeed(teamId, feed) {
  if (!teamId) return
  const all = readAll()
  const e = entryOf(all, teamId) || freshEntry()
  const items = (feed || [])
    .filter((it) => it && it.text)
    .map((it) => ({ text: it.text, dk: it.dk || null }))
  e.feed = items.slice(0, FEED_LIMIT)
  const dks = []
  for (const it of e.feed) {
    if (it.dk && !dks.includes(it.dk)) dks.push(it.dk)
  }
  for (const dk of e.dks || []) {
    if (dks.length >= FEED_DK_LIMIT) break
    if (dk && !dks.includes(dk)) dks.push(dk)
  }
  e.dks = dks
  e.savedAt = Date.now()
  all[teamId] = e
  writeAll(all)
}

// 去重键是否已在记忆窗口（刷新后重发的事件不再重复入栏）
export function isFeedKeyKnown(teamId, dk) {
  if (!teamId || !dk) return false
  const e = entryOf(readAll(), teamId)
  return !!e && Array.isArray(e.dks) && e.dks.includes(dk)
}
