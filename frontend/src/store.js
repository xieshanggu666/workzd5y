import { create } from 'zustand'
import { addCoopFeed } from './coopPersist'

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
}

const FEED_LIMIT = 12

// 无稳定 id 的动态（防御性兜底；正常路径均由 coopPersist 分配稳定 id）
let feedFallbackSeq = 0
function localFeedKey(it) {
  feedFallbackSeq += 1
  return `mem:${feedFallbackSeq}:${it.text}`
}

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

  // 追加队伍动态（最新在前），保留最近 FEED_LIMIT 条。
  // 2.10.2：每条带稳定 id（由 coopPersist.buildFeedItems / localFeedId 分配），
  // 按 id 去重——轮询、reset、重连补捞可能把同一条服务端事件重复带回，只上屏
  // 一次；带 teamId 的动态同步落 localStorage（刷新/断线重连后水合恢复）。
  pushCoopFeed: (items) => {
    const s = get()
    const present = new Set(s.coopFeed.map((it) => it.id).filter(Boolean))
    const fresh = []
    for (const it of items || []) {
      if (!it || !it.text) continue
      const id = it.id || localFeedKey(it)
      if (present.has(id)) continue
      present.add(id)
      fresh.push({ ...it, id })
    }
    if (!fresh.length) return
    // 落盘（addCoopFeed 内部再按 id/TTL 去重一次，覆盖多标签页等竞态）
    const withTeam = fresh.filter((it) => it.teamId)
    if (withTeam.length) addCoopFeed(withTeam[0].teamId, withTeam)
    set({ coopFeed: [...fresh, ...s.coopFeed].slice(0, FEED_LIMIT) })
  },

  // 重连/进入协作远征时水合本地持久化的队伍动态（刷新后不丢）；同样按 id 去重。
  hydrateCoopFeed: (items) => {
    const s = get()
    const present = new Set(s.coopFeed.map((it) => it.id).filter(Boolean))
    const merged = []
    for (const it of items || []) {
      if (!it || !it.id || !it.text || present.has(it.id)) continue
      present.add(it.id)
      merged.push({ ...it })
    }
    if (!merged.length) return
    // 持久化项按 ts 已为新->旧；现有内存项（多为本地提示）置于其后
    set({ coopFeed: [...merged, ...s.coopFeed].slice(0, FEED_LIMIT) })
  },

  clearCoopFeed: () => set({ coopFeed: [] }),

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