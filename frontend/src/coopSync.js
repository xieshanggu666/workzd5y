// 协作远征增量同步器（规则 2.10.x）：
// - 轮询服务端游标接口，把队友的动作以「录制帧」逐条补播（战斗中经 Phaser
//   逐帧播放，与本地操作同一套动画），播完应用权威视口一次性对齐；
// - 章节推进/长期断线/旧日志等场景服务端回 reset，走统一恢复顺序：
//   ① 全量视口对齐（跨章切换）→ ② 隔离旧章节未确认意图 → ③ 核对/补交
//   （recoverCoop），战斗补播、资源交易补交在同一串行管线内完成；
// - 本地操作进行中（acting）暂停本轮同步，避免动画与状态交错；
// - 409 冲突恢复经 coopSyncNow 立即触发一轮（提交管线在 409 时调用）；
// - 网络失败（NetworkError）触发重连恢复（去抖），恢复成功后继续增量跟随；
// - 旧章节响应隔离：请求发出时捕获 run_id/team_id，响应到达若章节已切换
//   （或同 run 但游标/rev 倒退）整包丢弃，游标经 advanceCoopCursor 单调
//   推进，绝不回拉——避免旧章动作覆盖新章、重复扣款/发奖/播放。
// - 本地持久化（2.10.2）：游标/队伍动态按队伍落 localStorage，刷新、断线、
//   跨章后恢复继续增量跟随；每个动作应用（补播完成/视口对齐）后按 seq
//   顺序登记「已应用帧」，恢复时游标按已应用前沿回退——服务端重发的未播
//   动作继续补播、已播的凭记录隔离，不重复补播、不漏队友动作。
import { useCallback, useEffect, useRef } from 'react'
import { api, getCoopCursor, getCurrentMemberId, setCoopCursor,
         setExpectedRev, advanceCoopCursor } from './api'
import { useStore } from './store'
import { playBattleLog } from './phaser/battleBus'
import { recoverCoop, isActing } from './coopRecovery'
import { markCoopActionsApplied, isCoopActionApplied } from './coopPersist'

const POLL_MS = 2500
const RECONNECT_DEBOUNCE_MS = 1200

// 动作 -> 队伍动态文案（侧栏「最近动态」）
const ACTION_TEXT = {
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

const TEAM_EVENT_TEXT = {
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

function memberName(view, id) {
  const m = (view?.coop?.members || []).find((x) => x.id === id)
  return m ? `${m.icon || ''}${m.name}` : null
}

export function useCoopSync() {
  const teamId = useStore((s) => s.view?.coop?.team_id || null)
  const runId = useStore((s) => s.runId)
  const applyRun = useStore((s) => s.applyRun)
  const busyRef = useRef(false)
  const reconnectTimer = useRef(null)
  const reconnectingRef = useRef(false)

  // 断线重连恢复：去抖（多次轮询失败只跑一轮），恢复完再立即同步一轮
  const scheduleReconnect = useCallback((tid) => {
    if (reconnectTimer.current) return
    reconnectTimer.current = setTimeout(() => {
      reconnectTimer.current = null
      if (reconnectingRef.current) return
      reconnectingRef.current = true
      Promise.resolve()
        .then(() => recoverCoop(tid))
        .catch(() => { /* 仍无网络/恢复失败：下轮轮询再次触发 */ })
        .finally(() => { reconnectingRef.current = false })
    }, RECONNECT_DEBOUNCE_MS)
  }, [])

  const syncOnce = useCallback(async (force = false) => {
    const st0 = useStore.getState()
    const tid = st0.view?.coop?.team_id
    if (!tid || busyRef.current) return
    // 本地动作提交/动画进行中：本轮让位，下轮再追（force 为 409 冲突恢复）。
    // isActing 覆盖战斗 + 资源所有动作（提交管线的在途计数）。
    if (!force && (st0.acting || isActing())) return

    // 捕获请求归属：响应到达时据此识别迟到的旧章节响应
    const cursorAtCall = getCoopCursor()
    const runAtCall = st0.runId || null

    busyRef.current = true
    try {
      const data = await api.syncCoop(tid, cursorAtCall)

      // ---- 旧章节响应隔离（必须在任何游标/视口更新之前完成） ----
      const after = useStore.getState()
      const currentRun = after.runId
      const serverRun = data.cursor?.run_id || null
      if (runAtCall && currentRun && runAtCall !== currentRun) {
        // 请求期间章节已推进：只有「服务端也已指向当前新章」的包才接受，
        // 先到的旧章包（reset 回旧 run、游标/视口全是旧章）整包丢弃，
        // 游标绝不回拉（advanceCoopCursor 也会做单调保护，这里提前拦截）。
        if (serverRun !== currentRun) return
      }

      const view = useStore.getState().view
      const myId = getCurrentMemberId()
      // 自己的动作已随本地 /act 响应播放/应用：增量里再遇到（actor===我）
      // 既不补播也不进队伍动态，只随游标推进并登记已应用——队友动作不受影响。
      const newActions = (data.actions || []).filter((a) => a.actor !== myId)
      // 队伍动态：动作增量（标注操作者）+ 队伍时间线增量（key 由 store 统一分配）。
      // 去重键先行：动态必须【先于游标推进】落盘——若此后页面崩溃，游标
      // 回退重发时同一事件凭 dk 被隔离，绝不重复入栏。
      const feed = []
      for (const a of newActions) {
        if (a.action === 'create') continue
        const who = memberName(view, a.actor)
        feed.push({
          text: `${who || '队友'} ${ACTION_TEXT[a.action] || a.action}`,
          dk: serverRun && Number.isInteger(a.seq) ? `a:${serverRun}:${a.seq}` : null,
        })
      }
      for (const e of data.team_events || []) {
        feed.push({
          text: `👥 ${TEAM_EVENT_TEXT[e.kind] || e.kind}`,
          dk: Number.isInteger(e.seq) ? `t:${e.seq}` : null,
        })
      }
      for (const e of data.expedition_events || []) {
        if (e.kind === 'create') continue
        feed.push({
          text: `🚩 ${TEAM_EVENT_TEXT[e.kind] || e.kind}`,
          dk: Number.isInteger(e.seq) ? `e:${e.seq}` : null,
        })
      }
      if (feed.length) useStore.getState().pushCoopFeed(feed.reverse())

      // 通过隔离检查后才推进游标（同 run 单调前进并落盘；跨章由权威锚定替换）
      advanceCoopCursor(data.cursor, tid)
      // 权威版本锚点随响应对齐（视口 rev 优先，心跳时取游标 rev——旧档迁移
      // 不产生动作事件但会推进 rev），避免后续动作带过期 expected_rev 必遭 409
      const authRev = data.run?.rev ?? data.cursor?.rev
      if (Number.isInteger(authRev)) setExpectedRev(authRev)

      if (data.reset) {
        // 章节推进/断线重连/落后过多：统一恢复顺序——
        // ① 先应用权威全量视口（跨章切换），再 ②③ 经 recoverCoop 隔离旧章
        // 意图、核对/补交未确认操作（战斗补播与资源交易在其中串行完成）。
        // 能走到这里说明该 reset 包已通过旧章隔离（serverRun===currentRun，
        // 或本地尚无 run）；直接应用并以权威游标锚定（seen 地板抬到最新，
        // 旧章帧记录随 run 切换淘汰），recoverCoop 的再次锚定为幂等空操作。
        if (data.run) applyRun(data.run)
        if (data.cursor) setCoopCursor(data.cursor, tid)
        // 恢复在后台串行（补播/补交期间 acting/syncing 锁定操作）
        void recoverCoop(tid, { runView: data.run, cursor: data.cursor })
          .catch(() => {})
        return
      }

      const oldSeq = cursorAtCall?.run_id === serverRun
        ? (cursorAtCall?.run_seq ?? 0)
        : 0
      // 本轮服务端新交付的动作（含自己的——要登记已应用，保证帧记录是
      // 连续前缀；迟到旧包的动作不超过 oldSeq，直接忽略）
      const delivered = (data.actions || [])
        .filter((a) => Number.isInteger(a.seq) && a.seq > oldSeq)
      if (!delivered.length) return

      // 可补播集合：队友动作 + 有录制帧（replay_only 旧日志在非 reset 包中
      // 不应出现，防御性排除）；自己的动作不在其中，只登记不补播
      const replayable = new Set(
        newActions.filter((a) => !a.replay_only).map((a) => a.seq),
      )
      const hasTeammateWork = delivered.some((a) => replayable.has(a.seq))
      // 局部重放：战斗中逐帧补播结算动画（与本地操作同一套 Phaser 播放）；
      // 非战斗动作无动画帧，登记已应用后由权威视口对齐
      const inBattle = !!useStore.getState().view?.battle
      if (hasTeammateWork) useStore.getState().setSyncing(true)
      try {
        // 严格按 seq 顺序应用并登记「已应用帧」：恢复时游标按已应用前沿回退，
        // 服务端重发的未播动作继续补播、已播的凭 isCoopActionApplied 隔离。
        for (const a of delivered) {
          // 播放期间章节若被推进，剩余帧属于旧章，立即停止补播（不登记——
          // 新章锚定会整体替换旧章游标/帧记录）
          if (useStore.getState().runId !== (serverRun || currentRun)) break
          const needReplay = inBattle
            && replayable.has(a.seq)
            && Array.isArray(a.log) && a.log.length > 0
            && !isCoopActionApplied(tid, serverRun, a.seq)
          if (needReplay) await playBattleLog(a.log)
          markCoopActionsApplied(tid, serverRun, [a.seq])
        }
      } finally {
        // 播完一次性应用权威视口（与单人 /act「动画 -> 快照」同节奏）；
        // 旧章视口同样经 run_id 守卫拒绝
        if (data.run && (!currentRun || data.run.run_id === currentRun)) {
          useStore.getState().applyRunIfCurrent(data.run.run_id, data.run)
        }
        if (hasTeammateWork) useStore.getState().setSyncing(false)
      }
    } catch (e) {
      // 网络层失败：服务端状态未知（不影响已提交动作——它们有 request_id
      // 幂等与未确认持久化）；去抖触发全量重连恢复
      if (e?.name === 'NetworkError' || e?.constructor?.name === 'NetworkError') {
        scheduleReconnect(tid)
      }
      // 4xx/5xx：下轮轮询重试，不触发恢复
    } finally {
      busyRef.current = false
    }
  }, [applyRun, scheduleReconnect])

  // 队伍动态本地持久化（2.10.2）：进入/切换协作队时恢复本地保存的最近动态，
  // 刷新后侧栏不丢（同队跨章 teamId 不变，不触发恢复，动态跨章连续）
  useEffect(() => {
    if (teamId) useStore.getState().hydrateCoopFeed(teamId)
  }, [teamId])

  // 注册「立即同步」入口（409 冲突恢复用）+ 轮询驱动 + online 重连
  useEffect(() => {
    const setCoopSyncNow = useStore.getState().setCoopSyncNow
    const setCoopReconnectNow = useStore.getState().setCoopReconnectNow
    if (!teamId) {
      setCoopSyncNow(null)
      setCoopReconnectNow(null)
      return () => {}
    }
    setCoopSyncNow(() => () => syncOnce(true))
    setCoopReconnectNow(() => () => recoverCoop(teamId).catch(() => {}))

    const onOnline = () => { void recoverCoop(teamId).catch(() => {}) }
    window.addEventListener('online', onOnline)

    let alive = true
    const timer = setInterval(() => {
      if (alive) syncOnce(false).catch(() => { /* 网络抖动：内部已安排重连 */ })
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = null
      }
      setCoopSyncNow(null)
      setCoopReconnectNow(null)
    }
  }, [teamId, runId, syncOnce])
}
