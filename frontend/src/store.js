import { create } from 'zustand'
import { loadCoopFeed, saveCoopFeed, isFeedKeyKnown } from './coopPersist'

const initialState = {
  cards: [],            // 全部卡牌元数据
  runId: null,
  view: null,           // 服务端 _public_view
  meta: { cards: [], enemies: [] },
  log: [],
  playing: false,
  error: null,
  // 协作增量同步（2.10.0）：
  // acting——本地动作提交/动画播放中，同步器本轮暂停（避免与增量应用交错）；
  // syncing——同步器正在补播队友动作，本地操作暂时禁用；
  // coopFeed——队伍动态（增量事件流，最近若干条，侧栏展示）；
  // coopSyncNow——同步器注册的「立即同步」入口（409 冲突恢复时调用）；
  // coopReconnectNow——同步器注册的「断线重连恢复」入口（online/失败后调用）：
  //   全量对齐 -> 隔离旧章意图 -> 核对/补交未确认操作
  acting: false,
  syncing: false,
  coopFeed: [],
  coopSyncNow: null,
  coopReconnectNow: null,
  _feedSeq: 0,          // 队伍动态 key 自增器（pushCoopFeed 内部使用）
}

const FEED_LIMIT = 12

export const useStore = create((set, get) => ({
  ...initialState,

  setCards: (cards) => set({ cards }),

  applyRun: (run) => set({ view: run, runId: run.run_id }),

  // 旧章节响应隔离（2.10.1）：只在响应仍属于当前章节 run 时应用。
  // expectedRunId 为提交时捕获的 run 归属；章节已推进（store.runId 已切到
  // 新章）时，迟到的旧 run 响应被丢弃，绝不回写画面/游标——避免旧章扣款、
  // 发奖结果覆盖新章。rev 非空且落后于当前视口时同样丢弃（同 run 的迟到
  // 旧响应）。主动对齐（全量入口/章节切换）请直接用 applyRun。
  applyRunIfCurrent: (expectedRunId, run) => {
    const cur = get().runId
    if (!run || !run.run_id) return false
    if (expectedRunId && cur && expectedRunId !== cur) return false
    const curRev = get().view?.rev
    if (cur && run.run_id === cur && Number.isInteger(run.rev)
        && Number.isInteger(curRev) && run.rev < curRev) {
      return false
    }
    set({ view: run, runId: run.run_id })
    return true
  },

  setRunId: (id) => set({ runId: id }),

  setMeta: (meta) => set({ meta }),

  setLog: (log) => set({ log }),

  setError: (err) => set({ error: err }),

  setPlaying: (playing) => set({ playing }),

  setActing: (acting) => set({ acting }),

  setSyncing: (syncing) => set({ syncing }),

  setCoopSyncNow: (fn) => set({ coopSyncNow: fn }),

  setCoopReconnectNow: (fn) => set({ coopReconnectNow: fn }),

  // 追加队伍动态（最新在前），保留最近 FEED_LIMIT 条；key 在此统一自增分配，
  // 避免跨章节 run 的日志 seq 复用导致 React key 冲突。
  // 重复帧隔离（2.10.2）：带 dk（去重键）的事件只入栏一次——本地窗口 +
  // 持久化记忆窗口双重判定，刷新后游标回退重发也不重复入栏；非空变更按
  // 队伍落 localStorage，刷新后由 hydrateCoopFeed 恢复。
  pushCoopFeed: (items) => set((s) => {
    const teamId = s.view?.coop?.team_id || null
    const known = new Set(s.coopFeed.map((f) => f.dk).filter(Boolean))
    const fresh = []
    for (const it of items || []) {
      if (it.dk) {
        if (known.has(it.dk)) continue
        if (teamId && isFeedKeyKnown(teamId, it.dk)) continue
        known.add(it.dk)
      }
      fresh.push(it)
    }
    if (!fresh.length) return {}
    const base = s._feedSeq || 0
    const tagged = fresh.map((it, i) => ({ ...it, key: `f${base + i}` }))
    const coopFeed = [...tagged, ...s.coopFeed].slice(0, FEED_LIMIT)
    if (teamId) saveCoopFeed(teamId, coopFeed)
    return { coopFeed, _feedSeq: base + tagged.length }
  }),

  // 进入协作队时恢复本地持久化的最近动态（刷新不丢；key 重新分配）
  hydrateCoopFeed: (teamId) => {
    if (!teamId) return
    const tagged = loadCoopFeed(teamId).map((it, i) => ({ ...it, key: `f${i}` }))
    set({ coopFeed: tagged, _feedSeq: tagged.length })
  },

  clearCoopFeed: () => {
    const teamId = get().view?.coop?.team_id
    if (teamId) saveCoopFeed(teamId, [])
    set({ coopFeed: [], _feedSeq: 0 })
  },

  cardMeta: (id) => get().cards.find((c) => c.id === id) || null,
}))

// 手牌/牌组项兼容两种形态：旧档裸 id（字符串）或卡牌实例 {uid,id,cost,forges}
export function cardRef(item) {
  return typeof item === 'string' ? item : item?.uid
}

export function cardIdOf(item) {
  return typeof item === 'string' ? item : item?.id
}

// 服务端卡牌效果标签 -> 中文简介
export function cardBadge(card) {
  if (!card) return ''
  switch (card.type) {
    case 'attack': return '攻击'
    case 'skill': return '技能'
    case 'power': return '能力'
    default: return ''
  }
}