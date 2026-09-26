"""协作远征断线重连与事件增量同步（规则 2.10.0）。

覆盖：
- 录制帧：动作落库携带 log（结算事件序列）/rev，与在线 /act 响应同源
- 服务端游标：sync 按 (run_id, run_seq, team_seq, exp_seq) 下发三条日志增量，
  游标单调推进；无新事件时增量为空、游标不后退
- 权限边界：非成员/缺失身份/他队成员 sync -> 403，零副作用（游标与日志不变）
- 断线重连：全量入口（expedition）携带权威游标；首次 sync（空游标）reset
  全量视口；章节推进后旧游标 reset 到新章；游标超前/落后过多/旧日志无
  录制帧一律 reset 全量对齐
- 冲突恢复：旧 expected_rev 提交 409 -> sync 增量追平 -> 新 rev 重试成功；
  request_id 幂等在追平后仍只生效一次
- 逐帧一致：sync 增量录制帧与在线 /act 响应、与整局回放推演帧逐条相等；
  回放 frame 维度全 ok、final_match；增量追平后的权威视口与 resume 一致
"""
import json

from app import db
from app.coop import SUPPLY


# ---------- 组队辅助（与 test_coop.py 同构） ----------
def _make_team(client, captain="阿队长", seed=21, chapters=2):
    r = client.post("/api/coop/teams", json={
        "captain_name": captain, "seed": seed, "chapters": chapters})
    assert r.status_code == 200, r.text
    data = r.json()
    return data, data["me"]["id"], data["code"]


def _join(client, code, name):
    r = client.post("/api/coop/teams/join", json={"code": code, "member_name": name})
    assert r.status_code == 200, r.text
    return r.json(), r.json()["me"]["id"]


def _squad(client, seed=21, chapters=2):
    """队长 + 资源位 + 战斗位三人队并开赛。"""
    team, leader_id, code = _make_team(client, seed=seed, chapters=chapters)
    _, supply_id = _join(client, code, "阿资")
    _, combat_id = _join(client, code, "阿战")
    r = client.post(f"/api/coop/teams/{team['id']}/roles",
                    json={"member_id": leader_id, "target_id": supply_id,
                          "role": SUPPLY})
    assert r.status_code == 200
    started = client.post(f"/api/coop/teams/{team['id']}/start",
                          json={"member_id": leader_id})
    assert started.status_code == 200, started.text
    s = started.json()
    return {"team_id": team["id"], "leader_id": leader_id,
            "supply_id": supply_id, "combat_id": combat_id,
            "run_id": s["run"]["run_id"], "expedition_id": s["expedition"]["id"]}


def _sync(client, team_id, member_id, **cursor):
    q = {"member_id": member_id}
    q.update({k: v for k, v in cursor.items() if v is not None})
    r = client.get(f"/api/coop/teams/{team_id}/sync", params=q)
    assert r.status_code == 200, r.text
    return r.json()


def _act(client, rid, member_id, action, **kw):
    body = {"action": action, "member_id": member_id}
    body.update(kw)
    return client.post(f"/api/runs/{rid}/act", json=body)


def _first_encounter_node(client, rid):
    view = client.get(f"/api/runs/{rid}/resume").json()
    return next(n["id"] for n in view["reachable"] if n["type"] == "encounter")


def _bot_play(client, rid, combat_id):
    """战斗位合法打完当前战斗（与 test_coop.py 同构的保守打法）。"""
    for _ in range(80):
        view = client.get(f"/api/runs/{rid}/resume",
                          params={"member_id": combat_id}).json()
        if not view["in_battle"]:
            return view["status"]
        b = view["battle"]
        playable = [h for h in b["hand"]
                    if (h.get("cost", 1) if isinstance(h, dict) else 1) <= b["energy"]]
        strike = next((h for h in playable
                       if (h["id"] if isinstance(h, dict) else h) == "strike"), None)
        pick = strike or (playable[0] if playable else None)
        if pick:
            uid = pick["uid"] if isinstance(pick, dict) else pick
            r = _act(client, rid, combat_id, "play", card=uid)
        else:
            r = _act(client, rid, combat_id, "end_turn")
        assert r.status_code == 200, r.text
        data = r.json()
        if data["run"]["status"] in ("won", "lost") or not data["run"]["in_battle"]:
            return data["run"]["status"]
    raise AssertionError("battle did not finish")


# ---------- 权限边界 ----------
def test_sync_requires_membership(client):
    squad = _squad(client)
    tid = squad["team_id"]
    # 缺失身份 / 非成员 / 他队成员 -> 403
    assert client.get(f"/api/coop/teams/{tid}/sync").status_code == 403
    assert client.get(f"/api/coop/teams/{tid}/sync",
                      params={"member_id": "m_nobody"}).status_code == 403
    _, other_leader, _ = _make_team(client, captain="外人", seed=99)
    assert client.get(f"/api/coop/teams/{tid}/sync",
                      params={"member_id": other_leader}).status_code == 403
    # 不存在的队伍 -> 400
    assert client.get("/api/coop/teams/t_none/sync",
                      params={"member_id": squad["leader_id"]}).status_code == 400
    # 零副作用：越权访问后三条日志与游标不变
    before = _sync(client, tid, squad["leader_id"])
    assert before["reset"] is True  # 空游标首次同步：全量对齐
    cursor = before["cursor"]
    again = _sync(client, tid, squad["leader_id"], **{
        "run_id": cursor["run_id"], "run_seq": cursor["run_seq"],
        "team_seq": cursor["team_seq"], "exp_seq": cursor["exp_seq"]})
    assert again["reset"] is False and again["actions"] == []
    assert again["cursor"] == cursor


def test_sync_forming_team_only_team_events(client):
    team, leader_id, code = _make_team(client)
    tid = team["id"]
    first = _sync(client, tid, leader_id)
    assert first["reset"] is False and first["run"] is None
    assert first["cursor"]["run_id"] is None
    assert [e["kind"] for e in first["team_events"]] == ["form"]
    # 新成员加入：队伍时间线增量按游标下发
    _join(client, code, "老二")
    second = _sync(client, tid, leader_id,
                   team_seq=first["cursor"]["team_seq"])
    assert [e["kind"] for e in second["team_events"]] == ["join"]
    assert second["team"] is not None  # 成员变化时附队伍视口
    assert len(second["team"]["members"]) == 2
    # 无新事件：增量为空、不附队伍视口
    third = _sync(client, tid, leader_id,
                  team_seq=second["cursor"]["team_seq"])
    assert third["team_events"] == [] and third["team"] is None
    assert third["cursor"]["team_seq"] == second["cursor"]["team_seq"]


# ---------- 增量与录制帧 ----------
def test_sync_incremental_actions_carry_recorded_frames(client):
    squad = _squad(client)
    tid, rid = squad["team_id"], squad["run_id"]
    # 全量入口拿权威游标（断线重连入口）
    entry = client.get(f"/api/coop/teams/{tid}/expedition",
                       params={"member_id": squad["supply_id"]}).json()
    cursor = entry["cursor"]
    assert cursor["run_id"] == rid and cursor["run_seq"] >= 1
    assert cursor["rev"] == entry["run"]["rev"]

    # 资源位进战斗节点，战斗位打一个回合（各自带 request_id）
    node = _first_encounter_node(client, rid)
    r1 = _act(client, rid, squad["supply_id"], "choose_node", node=node,
              request_id="sync-n1")
    assert r1.status_code == 200
    r2 = _act(client, rid, squad["combat_id"], "end_turn", request_id="sync-t1")
    assert r2.status_code == 200

    # 另一成员（队长）从旧游标增量同步：两条动作按序到达，携带录制帧
    data = _sync(client, tid, squad["leader_id"], **{
        "run_id": cursor["run_id"], "run_seq": cursor["run_seq"],
        "team_seq": cursor["team_seq"], "exp_seq": cursor["exp_seq"]})
    assert data["reset"] is False
    seqs = [a["seq"] for a in data["actions"]]
    assert seqs == sorted(seqs) and len(seqs) == 2
    a1, a2 = data["actions"]
    assert a1["action"] == "choose_node" and a1["actor"] == squad["supply_id"]
    assert a2["action"] == "end_turn" and a2["actor"] == squad["combat_id"]
    # 录制帧与在线 /act 响应的 log 逐帧一致（同源录制）
    assert a1["log"] == r1.json()["log"]
    assert a2["log"] == r2.json()["log"]
    assert a1["replay_only"] is False and a2["replay_only"] is False
    assert a1["ckpt"] and a2["ckpt"] and a1["ver"] and a2["rev"]
    # 增量非空时附最新权威视口，且与 resume 全量一致
    assert data["run"]["in_battle"] is True
    assert data["run"]["rev"] == data["cursor"]["rev"]
    fresh = client.get(f"/api/runs/{rid}/resume").json()
    assert data["run"]["battle"]["turn"] == fresh["battle"]["turn"]
    assert data["run"]["health"] == fresh["health"]
    # 游标推进到最新；再同步无增量
    assert data["cursor"]["run_seq"] == a2["seq"]
    # 增量同步是只读幂等的：同一游标重复调用返回完全相同的增量
    repeat = _sync(client, tid, squad["leader_id"], **{
        "run_id": cursor["run_id"], "run_seq": cursor["run_seq"],
        "team_seq": cursor["team_seq"], "exp_seq": cursor["exp_seq"]})
    assert repeat["actions"] == data["actions"]
    assert repeat["cursor"] == data["cursor"]
    idle = _sync(client, tid, squad["leader_id"], **{
        "run_id": data["cursor"]["run_id"], "run_seq": data["cursor"]["run_seq"],
        "team_seq": data["cursor"]["team_seq"],
        "exp_seq": data["cursor"]["exp_seq"]})
    assert idle["reset"] is False and idle["actions"] == []
    assert idle["run"] is None  # 纯心跳不附视口
    assert idle["cursor"]["run_seq"] == data["cursor"]["run_seq"]


def test_sync_frames_match_replay_steps(client):
    """整段打完一章：增量同步的录制帧与整局回放推演帧逐条一致。"""
    squad = _squad(client, seed=13, chapters=2)
    tid, rid = squad["team_id"], squad["run_id"]
    node = _first_encounter_node(client, rid)
    _act(client, rid, squad["supply_id"], "choose_node", node=node)
    _bot_play(client, rid, squad["combat_id"])

    # 队长从游标 0 全量增量（含 create 事件）
    data = _sync(client, tid, squad["leader_id"], run_id=rid, run_seq=0)
    assert data["reset"] is False
    actions = data["actions"]
    assert actions[0]["action"] == "create" and actions[0]["log"] == []
    assert all(not a["replay_only"] for a in actions)

    rep = client.get(f"/api/runs/{rid}/replay").json()
    assert rep["verification"]["final_match"] is True
    assert rep["verification"]["frame_mismatch"] == 0
    steps = rep["steps"]
    assert len(actions) == len(steps)
    for a, step in zip(actions, steps):
        assert a["seq"] == step["seq"] and a["action"] == step["action"]
        if a["action"] == "create":
            continue
        # 录制帧 == 回放推演帧（逐帧一致的服务端证明）
        assert a["log"] == step["events"]
        assert step["frame"] == "ok"
        assert a["actor"] == (step.get("payload") or {}).get("actor")


def test_replay_frame_dimension_on_new_and_legacy_logs(client):
    """回放 frame 维度：2.10.0 新日志逐帧比对；无录制帧的旧日志跳过。"""
    squad = _squad(client, seed=17, chapters=2)
    rid = squad["run_id"]
    node = _first_encounter_node(client, rid)
    _act(client, rid, squad["supply_id"], "choose_node", node=node)
    _act(client, rid, squad["combat_id"], "end_turn")

    rep = client.get(f"/api/runs/{rid}/replay").json()
    frames = {c["seq"]: c["frame"] for c in rep["verification"]["checks"]}
    # create 无录制帧；其余动作全部逐帧一致
    assert frames[1] is None
    assert all(f == "ok" for seq, f in frames.items() if seq != 1)
    assert rep["verification"]["final_match"] is True

    # 模拟 2.10.0 之前的旧日志：剥掉录制帧 -> 该步 frame 跳过（None），
    # 状态校验点不受影响，回放仍逐位一致
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT seq, payload_json FROM battle_events WHERE run_id=? AND seq>1",
            (rid,)).fetchall()
        for row in rows:
            p = json.loads(row["payload_json"])
            p.pop("log", None)
            p.pop("rev", None)
            conn.execute("UPDATE battle_events SET payload_json=? "
                         "WHERE run_id=? AND seq=?",
                         (json.dumps(p, ensure_ascii=False), rid, row["seq"]))
        conn.commit()
    finally:
        conn.close()
    rep2 = client.get(f"/api/runs/{rid}/replay").json()
    frames2 = {c["seq"]: c["frame"] for c in rep2["verification"]["checks"]}
    assert all(f is None for f in frames2.values())
    assert rep2["verification"]["mismatch"] == 0
    assert rep2["verification"]["final_match"] is True
    # 旧日志无录制帧：增量同步拒绝局部重放，回退全量对齐
    data = _sync(client, squad["team_id"], squad["leader_id"],
                 run_id=rid, run_seq=1)
    assert data["reset"] is True and data["actions"] == []
    assert data["run"] is not None and data["cursor"]["run_seq"] >= 2


# ---------- 断线重连（reset 全量对齐） ----------
def test_sync_reset_on_first_connect_and_chapter_change(client):
    squad = _squad(client, seed=33, chapters=2)
    tid, rid = squad["team_id"], squad["run_id"]
    # 首次同步（空游标）：reset 全量视口 + 权威游标
    first = _sync(client, tid, squad["combat_id"])
    assert first["reset"] is True
    assert first["run"]["run_id"] == rid
    assert first["cursor"]["run_id"] == rid
    assert first["run"]["coop"]["team_id"] == tid

    # 打通第 1 章并由队长推进：旧游标同步 -> reset 到新章
    node = _first_encounter_node(client, rid)
    _act(client, rid, squad["supply_id"], "choose_node", node=node)
    _bot_play(client, rid, squad["combat_id"])
    # 直接走到首领（资源位合法选路）
    for _ in range(30):
        view = client.get(f"/api/runs/{rid}/resume").json()
        if view["status"] != "in_progress":
            break
        if view["in_battle"]:
            _bot_play(client, rid, squad["combat_id"])
            continue
        if not view["reward_claimed"] and view["reward_options"]:
            _act(client, rid, squad["supply_id"], "claim_reward", option=0)
            continue
        reach = view["reachable"]
        if not reach:
            break
        boss = next((n for n in reach if n["type"] == "boss"), None)
        pick = boss or reach[0]
        r = _act(client, rid, squad["supply_id"], "choose_node", node=pick["id"])
        assert r.status_code == 200
    view = client.get(f"/api/runs/{rid}/resume").json()
    assert view["status"] == "won"
    adv = client.post(f"/api/coop/teams/{tid}/advance",
                      json={"member_id": squad["leader_id"]})
    assert adv.status_code == 200, adv.text
    new_rid = adv.json()["run"]["run_id"]
    assert new_rid != rid

    stale = _sync(client, tid, squad["combat_id"], **{
        "run_id": rid, "run_seq": first["cursor"]["run_seq"],
        "team_seq": first["cursor"]["team_seq"],
        "exp_seq": first["cursor"]["exp_seq"]})
    assert stale["reset"] is True
    assert stale["cursor"]["run_id"] == new_rid
    assert stale["run"]["run_id"] == new_rid
    assert stale["cursor"]["chapter"] == 2
    # 远征事件增量（chapter_clear/advance）随 reset 一并下发
    kinds = [e["kind"] for e in stale["expedition_events"]]
    assert "chapter_clear" in kinds and "advance" in kinds


def test_sync_reset_when_cursor_ahead_or_too_far_behind(client, monkeypatch):
    squad = _squad(client, seed=41, chapters=2)
    tid, rid = squad["team_id"], squad["run_id"]
    # 游标超前（客户端错乱）-> reset
    ahead = _sync(client, tid, squad["leader_id"], run_id=rid, run_seq=999)
    assert ahead["reset"] is True and ahead["actions"] == []
    # 落后过多（超过 SYNC_ACTION_LIMIT 条未同步）-> reset 全量对齐
    # （调低上限，避免为构造场景打几十回合战斗）
    monkeypatch.setattr("app.coop.SYNC_ACTION_LIMIT", 3)
    node = _first_encounter_node(client, rid)
    _act(client, rid, squad["supply_id"], "choose_node", node=node)
    for _ in range(4):
        r = _act(client, rid, squad["combat_id"], "end_turn")
        assert r.status_code == 200
    behind = _sync(client, tid, squad["leader_id"], run_id=rid, run_seq=1)
    assert behind["reset"] is True and behind["actions"] == []
    assert behind["run"] is not None
    assert behind["cursor"]["run_seq"] > 1
    # 未超限时仍走增量（同一游标窗口内只有 2 条）
    fresh = _sync(client, tid, squad["combat_id"], run_id=rid, run_seq=3)
    assert fresh["reset"] is False and 0 < len(fresh["actions"]) <= 3


# ---------- 冲突恢复 ----------
def test_conflict_then_incremental_catchup_then_retry(client):
    squad = _squad(client, seed=55, chapters=2)
    tid, rid = squad["team_id"], squad["run_id"]
    entry = client.get(f"/api/coop/teams/{tid}/expedition",
                       params={"member_id": squad["combat_id"]}).json()
    cursor = entry["cursor"]
    stale_rev = entry["run"]["rev"]

    # 资源位推进路线（战斗位视角里状态已过期）
    node = _first_encounter_node(client, rid)
    r1 = _act(client, rid, squad["supply_id"], "choose_node", node=node)
    assert r1.status_code == 200

    # 战斗位基于过期 rev 提交 -> 409 状态冲突
    conflict = _act(client, rid, squad["combat_id"], "end_turn",
                    expected_rev=stale_rev, request_id="conflict-t1")
    assert conflict.status_code == 409

    # 增量追平：拿到资源位的动作（含录制帧），游标与 rev 对齐
    catchup = _sync(client, tid, squad["combat_id"], **{
        "run_id": cursor["run_id"], "run_seq": cursor["run_seq"],
        "team_seq": cursor["team_seq"], "exp_seq": cursor["exp_seq"]})
    assert catchup["reset"] is False
    assert [a["action"] for a in catchup["actions"]] == ["choose_node"]
    assert catchup["actions"][0]["log"] == r1.json()["log"]
    new_rev = catchup["cursor"]["rev"]
    assert new_rev == r1.json()["rev"]

    # 用最新 rev 重试同一意图（同一 request_id）：成功且只生效一次
    retry = _act(client, rid, squad["combat_id"], "end_turn",
                 expected_rev=new_rev, request_id="conflict-t1")
    assert retry.status_code == 200, retry.text
    again = _act(client, rid, squad["combat_id"], "end_turn",
                 expected_rev=new_rev, request_id="conflict-t1")
    assert again.status_code == 200 and again.json()["duplicate"] is True
    # 两次响应一致（幂等），动作日志只多了一条 end_turn
    assert again.json()["seq"] == retry.json()["seq"]
    actions = [e for e in db.load_events(rid) if e["action"] == "end_turn"]
    assert len(actions) == 1
    # 追平后回放逐帧一致
    rep = client.get(f"/api/runs/{rid}/replay").json()
    assert rep["verification"]["final_match"] is True
    assert rep["verification"]["frame_mismatch"] == 0


# ---------- 结算后同步 ----------
def test_sync_after_team_settled(client):
    squad = _squad(client, seed=61, chapters=2)
    tid, rid = squad["team_id"], squad["run_id"]
    entry = client.get(f"/api/coop/teams/{tid}/expedition",
                       params={"member_id": squad["leader_id"]}).json()
    cursor = entry["cursor"]
    # 进战斗后连续空过直到战败
    node = _first_encounter_node(client, rid)
    _act(client, rid, squad["supply_id"], "choose_node", node=node)
    for _ in range(60):
        view = client.get(f"/api/runs/{rid}/resume").json()
        if view["status"] != "in_progress":
            break
        r = _act(client, rid, squad["combat_id"], "end_turn")
        assert r.status_code == 200
    view = client.get(f"/api/runs/{rid}/resume").json()
    assert view["status"] == "lost"

    # 战败后其他成员同步：拿到剩余动作增量 + 队伍 settle 事件，游标到终态
    data = _sync(client, tid, squad["supply_id"], **{
        "run_id": cursor["run_id"], "run_seq": cursor["run_seq"],
        "team_seq": cursor["team_seq"], "exp_seq": cursor["exp_seq"]})
    assert data["reset"] is False
    assert data["cursor"]["run_status"] == "lost"
    assert data["cursor"]["expedition_status"] == "lost"
    assert any(e["kind"] == "settle" for e in data["team_events"])
    # 终态视口随增量下发（与 resume 一致）
    assert data["run"]["status"] == "lost"
    # 回放仍逐帧一致（含战败结算帧）
    rep = client.get(f"/api/runs/{rid}/replay").json()
    assert rep["verification"]["final_match"] is True
    assert rep["verification"]["frame_mismatch"] == 0
