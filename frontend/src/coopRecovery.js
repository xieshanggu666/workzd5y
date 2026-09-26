// 协作远征断线恢复编排（规则 2.10.1）：
//
// 统一恢复顺序——
//   ① 跨章切换/全量对齐（getCoopExpedition 权威视口 + 权威游标）；
//      其他章节 run 的未确认意图一律隔离丢弃，绝不补交进新章
//      （旧意图的扣款/发奖属于旧章，重放=重复扣款/发奖/播放）；
//   ② 同章节未确认意图逐条核对服务端结果（probe）：
//      landed -> 只对齐、不补交（服务端已生效，再交只回首次结果，重复播放
//                与重复对齐正是「重复扣款/发奖/播放」的来源）；
//      unknown -> 以同一 request_id 补交（服务端幂等保证只生效一次）；
//   ③ 补交串行（同一时刻只一条在途），按意图的原始先后执行；战斗动作先经
//      Phaser 补播结算帧、资源动作直接对齐——与本地操作完全同一套节奏；
//   ④ 之后恢复常规增量同步（coopSync）。
//
// 旧章节响应隔离：所有异步响应（/act、sync）在应用前都要核对其 run_id 仍
// 是当前章节 run；章节已切换就丢弃响应（其游标也不得回拉）。
import { api, ConflictError, ForbiddenError, NetworkError,
         getCoopCursor, getCurrentMemberId, makeRequestId,
         setCoopCursor, setExpectedRev } from './api'
import { useStore } from './store'
import { playBattleLog, waitForBattleBus } from './phaser/battleBus'
import { recordPending, clearPending, listPending,
         dropStaleChapterPending, dropExpiredPending } from './pendingOps'
import { buildFeedItems, loadCoopCursor, loadCoopFeed, localFeedId,
         saveCoopCursor } from './coopPersist'

// 提交管线重入计数：>0 期间同步器整体让位（与原 acting 同义，但覆盖战斗+资源
// 所有动作，避免队友补播与本地资源操作交错）。
let inFlight = 0
export function isActing() {
  return inFlight > 0
}

const ACTION_TEXT_SHORT = {
  choose_node: '路线推进', play: '打出卡牌', end_turn: '结束回合',
  use_potion: '使用药水', claim_reward: '领取奖励', forge: '锻造卡牌',
  shop_buy: '商店购买', shop_remove: '移除卡牌', discard_potion: '丢弃药水',
  companion_set_mode: '调整伙伴', commission_accept: '接取委托',
  commission_claim: '领取委托奖励', encounter_choice: '奇遇抉择',
}

function feed(text, teamId = null) {
  useStore.getState().pushCoopFeed([{ id: localFeedId(), text, teamId }])
}

// 只在响应仍属于「当前章节 run」时应用权威视口；跨章后的迟到响应直接丢弃。
function applyIfCurrent(runId, run) {
  return useStore.getState().applyRunIfCurrent(runId, run)
}

// ---------- 统一动作提交管线（战斗/资源共用） ----------
// 返回 /act 响应；调用方据 res.log 做本地呈现（组件已有自己的日志面板）。
// requestId 缺省由管线生成；同一意图重试复用同一令牌（调用方传入）。
export async function submitRunAction(runId, body, { requestId = makeRequestId(),
                                                       playBattle = false } = {}) {
  const chapter = useStore.getState().view?.expedition?.chapter ?? null
  const teamId = useStore.getState().view?.coop?.team_id ?? null
  const kind = ACTION_TEXT_SHORT[body.action] || body.action
  // 发出前持久化意图：之后任何网络层结果未知都能在重连时核对补交
  recordPending({ runId, requestId, body: { ...body }, chapter, teamId, kind })

  inFlight += 1
  useStore.getState().setActing(true)
  try {
    let res
    try {
      res = await api.act(runId, body, { retryKey: requestId })
    } catch (e) {
      // 409：服务端已推进（队友动作/章节变化）。先走增量同步追平再决定：
      // - 同步期间章节已推进（run 切换）：旧 run 的意图不再适用，隔离清除，
      //   绝不拿旧动作去撞新章（避免重复扣款/发奖）；
      // - 同一 run：用同一令牌自动重试一次（队友动作已追平）。仍失败则抛出，
      //   意图保留，下轮重连恢复会再核对。
      if (e instanceof ConflictError) {
        const syncNow = useStore.getState().coopSyncNow
        if (syncNow) {
          try { await syncNow() } catch (_) { /* 同步失败下轮再追 */ }
        }
        if (useStore.getState().runId !== runId) {
          // reset 恢复会把同队旧章意图隔离；非协作/极端情况下这里也兜一层
          clearPending(runId, requestId)
          feed('ℹ️ 章节已切换，未提交的原章节操作不再生效', teamId)
          throw new Error('章节已切换，原操作已取消')
        }
        try {
          res = await api.act(runId, body, { retryKey: requestId })
        } catch (e2) {
          // 重试拿到的是服务端终态结论（400/403/409）：意图已被明确拒绝，
          // 清除持久化（网络层失败除外——结果未知，保留待重连核对）
          if (!(e2 instanceof NetworkError) && e2?.name !== 'NetworkError') {
            clearPending(runId, requestId)
          }
          throw e2
        }
      } else {
        // 400/403 等明确拒绝：服务端已给出终态结论，意图不再保留
        if (!(e instanceof NetworkError) && e?.name !== 'NetworkError') {
          clearPending(runId, requestId)
        }
        throw e
      }
    }
    // 终态响应：意图有结论，清除持久化
    clearPending(runId, requestId)

    const isCurrent = applyIfCurrent(runId, res.run)
    // duplicate=true：补交/双击命中服务端幂等首次结果。首帧动画此前已经播过
    // （或会由同步补播），这里绝不再播一遍——避免重复播放/重复扣款观感。
    if (playBattle && isCurrent && res.log?.length && !res.duplicate) {
      await waitForBattleBus(4000)
      await playBattleLog(res.log)
      // 播放后以权威视口再对齐一次（与 BattleView 的「动画 -> 快照」同节奏）
      useStore.getState().applyRunIfCurrent(runId, res.run)
    }
    if (!isCurrent) {
      // 响应落地时章节已切换：旧章节响应隔离，游标不动
      feed('ℹ️ 章节已切换，原章节操作结果不再覆盖当前画面', teamId)
    }
    return res
  } finally {
    inFlight -= 1
    if (inFlight === 0) useStore.getState().setActing(false)
  }
}

// 网络层失败（结果未知）时的统一文案；其余错误（400/403/409）已有服务端
// 明确结论，由组件展示原因。
export function actionErrorText(e) {
  if (e instanceof NetworkError) return '网络中断：操作已暂存，重连后将核对服务端结果再决定补交'
  if (e instanceof ForbiddenError) return e.message
  return e.message
}

// ---------- 重连恢复 ----------
// 恢复流程全局互斥：reset 轮询、online 事件、失败去抖可能同时触发，串行管线
// 只跑一条（核对/补交同一意图跑两遍会造成重复提交——虽幂等但会重复播放）。
let recovering = false

// 重连恢复（统一恢复顺序）。
// 由全量入口（进入协作远征）与 sync reset（章节推进/长期断线）触发。
// runView/cursor 已由调用方持有时直接复用（reset 包即权威全量），否则经
// getCoopExpedition 重新拉取。返回 {recovered,resubmitted,failed,dropped}。
export async function recoverCoop(teamId, { runView = null, cursor = null } = {}) {
  const summary = { recovered: 0, resubmitted: 0, failed: 0, dropped: 0 }
  if (!teamId || recovering) return summary
  recovering = true
  try {
    return await _recoverCoopInner(teamId, { runView, cursor }, summary)
  } finally {
    recovering = false
  }
}

async function _recoverCoopInner(teamId, { runView, cursor }, summary) {
  dropExpiredPending()

  // 持久化恢复（2.10.2）：先水合本队最近的队伍动态——刷新/关掉标签页后
  // 「队友做了什么」不再丢，稳定 id 与后续增量天然去重。
  useStore.getState().hydrateCoopFeed(loadCoopFeed(teamId))

  // 水合后判断缺口（权威游标由全量入口/reset 包提供，或稍后由补捞补回）
  // ① 跨章切换/全量对齐：以权威入口重新锚定视口与游标。
  let entry
  if (runView) {
    entry = { run: runView, cursor: cursor || null }
  } else {
    try {
      entry = await api.getCoopExpedition(teamId)
    } catch (e) {
      if (e instanceof NetworkError || e?.name === 'NetworkError') return summary
      throw e
    }
  }

  // 缺口补捞（2.10.2）：只要本地游标落后于服务端权威位置（关页/断线/断网
  // 期间队友推进了章节或有新动作），就用本地游标打一次 sync，把缺口期间的
  // 队友动作/队伍时间线/远征事件转成动态文案补齐（其结果已包含在权威视口里，
  // 历史帧不逐帧重播，避免在终态画面上重放几十帧动画）；随后统一锚定权威
  // 游标，缺口不会被二次轮询取到。游标锚在旧章也安全：服务端回 reset 时
  // 只取时间线增量，动作随全量视口对齐，旧游标随后被整体替换（绝不回拉）。
  // reset 轮询路径游标在调用前已落盘为 tip，与权威游标一致 -> 自动跳过，
  // 不会多发请求；稳定 id 去重也保证即使重复带回也不重屏。
  const saved = loadCoopCursor(teamId) || getCoopCursor()
  let gapCursor = null
  if (saved && cursorLags(saved, entry.cursor)) {
    gapCursor = await harvestGap(teamId, saved)
  }

  if (entry.run) {
    // 主动对齐：允许 run 切换（旧章 -> 新章是唯一合法的非守卫切换）
    useStore.getState().applyRun(entry.run)
  }
  // 权威入口游标优先；没有时（队长本地推进章节）退用补捞响应里的最新游标
  const anchor = entry.cursor || gapCursor
  if (anchor) {
    setCoopCursor(anchor)
    // 权威游标落盘：下一次刷新/断线直接从最新位置恢复，缺口最小
    saveCoopCursor(teamId, anchor)
  }

  const currentRunId = entry.run?.run_id || useStore.getState().runId
  if (!currentRunId) return summary

  // 隔离旧章节：同队伍其他章节 run 的意图已失效，绝不补交进新章
  const dropped = dropStaleChapterPending(teamId, currentRunId)
  if (dropped.length) {
    summary.dropped = dropped.length
    feed(`🔒 已隔离 ${dropped.length} 个上一章节的未确认操作（不重复扣款/发奖）`, teamId)
  }

  // ② 逐条核对同章节未确认意图；③ unknown 的按原始顺序串行补交
  await reconcilePending(teamId, currentRunId, summary)
  return summary
}

// 本地游标是否落后于服务端权威位置（需要补捞缺口）。
// - 无权威游标可比（runView-only 路径）：只要本地有游标就尝试补捞（响应即权威）；
// - 章节 run 已切换：必然落后（旧章游标无法覆盖新章事件）；
// - 同 run：三条日志任一 seq 落后即有缺口。
function cursorLags(saved, authoritative) {
  if (!saved || !saved.run_id) return false
  if (!authoritative || !authoritative.run_id) return true
  if (saved.run_id !== authoritative.run_id) return true
  return (saved.run_seq ?? 0) < (authoritative.run_seq ?? 0)
    || (saved.team_seq ?? 0) < (authoritative.team_seq ?? 0)
    || (saved.exp_seq ?? 0) < (authoritative.exp_seq ?? 0)
}

// 缺口补捞（2.10.2）：以持久化游标打一次 sync，把「最后确认位置 -> 服务端
// 当前」之间的队友动作/队伍时间线/远征事件转成队伍动态文案上屏并落盘；
// 不逐帧重播历史结算动画（权威视口会整体对齐，重放历史帧既重复又错乱）。
// reset（跨章/落后过多/旧日志）时只保留时间线增量，动作动态随全量对齐放弃。
// 返回响应里的服务端游标（调用方据情锚定）；网络/服务端不可用返回 null。
async function harvestGap(teamId, savedCursor) {
  let data
  try {
    data = await api.syncCoop(teamId, savedCursor)
  } catch (e) {
    if (e instanceof NetworkError || e?.name === 'NetworkError') return null
    return null // 4xx/5xx（如身份失效）：交给后续全量/轮询路径处理
  }
  const view = useStore.getState().view
  const myId = getCurrentMemberId()
  const payload = data.reset
    ? { ...data, actions: [] }   // reset：动作缺口以权威视口整体对齐，不补文案
    : data
  const items = buildFeedItems(teamId, payload, { myId, view })
  if (items.length) useStore.getState().pushCoopFeed(items.reverse())
  // rev 锚点提前对齐，避免恢复后的首个动作带过期 expected_rev 必遭 409
  const authRev = data.run?.rev ?? data.cursor?.rev
  if (Number.isInteger(authRev)) setExpectedRev(authRev)
  return data.cursor || null
}


// ② 核对 + ③ 补交（协作/单人共用同一条串行管线）。
// landed -> 只对齐（游标越过、不补播）；unknown -> 同 request_id 补交；
// 补交仅在服务端明确拒绝时移除意图，网络再断则保留待下轮重连。
async function reconcilePending(teamId, currentRunId, summary) {
  const pending = listPending(currentRunId)
  if (!pending.length) return summary

  useStore.getState().setSyncing(true)
  try {
    for (const item of pending) {
      // 恢复期间章节又被推进：剩余意图留给下一次恢复（会在那里被隔离）
      if (useStore.getState().runId !== currentRunId) break

      let probe
      try {
        probe = await api.probeRequest(currentRunId, item.requestId)
      } catch (e) {
        if (e instanceof NetworkError || e?.name === 'NetworkError') break
        probe = { status: 'unknown' } // 其他核对失败：按 unknown 补交尝试
      }

      if (probe.status === 'landed') {
        // 已生效：只对齐、不补交（权威视口在 ① 已对齐；不本地推进游标——
        // 自己的动作会经下一次增量回来并按 actor 过滤，不会重复补播；
        // 更早的队友动作则能正常补播，不被一并跳过）。
        summary.recovered += 1
        clearPending(currentRunId, item.requestId)
        feed(`✅ 断线前的「${item.kind}」已在服务端生效，无需补交`, teamId)
        continue
      }

      // unknown：同一 request_id 补交（服务端幂等 -> 只生效一次）。
      // 战斗动作的结算帧经 Phaser 补播；资源动作直接对齐。
      try {
        const inBattleNow = !!useStore.getState().view?.battle
        const res = await submitRunAction(currentRunId, item.body, {
          requestId: item.requestId,
          playBattle: inBattleNow,
        })
        if (res.duplicate) {
          summary.recovered += 1
          feed(`✅ 断线前的「${item.kind}」已在服务端生效（幂等确认）`, teamId)
        } else {
          summary.resubmitted += 1
          feed(`↩️ 已补交断线前未确认的「${item.kind}」`, teamId)
        }
      } catch (e) {
        // 网络再断：保留剩余意图，下轮重连继续
        if (e instanceof NetworkError || e?.name === 'NetworkError') break
        // 补交被服务端明确拒绝（金币不足/状态已变/越权）：意图已无意义
        summary.failed += 1
        clearPending(currentRunId, item.requestId)
        feed(`⚠️ 「${item.kind}」补交失败：${e.message}`, teamId)
      }
    }
  } finally {
    useStore.getState().setSyncing(false)
  }
  return summary
}

// 单人局/单人远征续局或刷新后的恢复：没有全量入口/游标，直接对当前 run 的
// 未确认意图做核对+补交（同一条串行管线；不动其他 run 的意图）。
export async function recoverSoloRun(runId) {
  const summary = { recovered: 0, resubmitted: 0, failed: 0, dropped: 0 }
  if (!runId || recovering) return summary
  recovering = true
  try {
    dropExpiredPending()
    if (!listPending(runId).length) return summary
    return await reconcilePending(null, runId, summary)
  } finally {
    recovering = false
  }
}
