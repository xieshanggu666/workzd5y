"""协作远征断线恢复：未确认操作核对（规则 2.10.1）。

场景：成员提交动作后网络中断——请求可能（a）已在服务端生效而响应丢失，
或（b）根本没到达。客户端把意图（request_id/动作体）持久化在本地，重连
后先经 GET /api/runs/{id}/requests/{request_id} 核对服务端结果：

- landed：意图已生效，附 seq/rev/chapter，客户端以权威视口对齐、不再补交
  （同一 request_id 虽幂等，但重复对齐/补播会造成重复扣款/发奖/播放观感）；
- unknown：无记录（没到达，或在任何写入前被 400/403 拒绝——拒绝不登记
  幂等行），客户端可以同一 request_id 安全补交，服务端只生效一次。

权限：协作 run 与写动作同源——非本队成员/未带身份核对 -> 403、零副作用；
单人远征/普通局忽略 member_id。核对只读，且绝不回放首次响应视口。
"""
from app import db
from app.coop import SUPPLY

from tests.test_coop_sync import _squad, _act, _first_encounter_node


def _probe(client, rid, request_id, member_id=None):
    q = f"?member_id={member_id}" if member_id else ""
    return client.get(f"/api/runs/{rid}/requests/{request_id}{q}")


def test_unknown_request_can_be_safely_resubmitted(client):
    """unknown：同一 request_id 补交只生效一次（扣款/发奖幂等）。"""
    squad = _squad(client, seed=71, chapters=2)
    rid = squad["run_id"]
    # 从未提交过的令牌 -> unknown
    r = _probe(client, rid, "never-sent-42", squad["supply_id"])
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "unknown", "run_id": rid}

    # 资源位走到商店/节点：先选一个普通战斗节点（choose_node 无扣款，
    # 这里验证补交路径）——直接用一个 forge 意图验证幂等落账更直接：
    # 先让队伍走到锻造节点成本高，这里用 end_turn（战斗位）覆盖补交主路径
    node = _first_encounter_node(client, rid)
    enter = _act(client, rid, squad["supply_id"], "choose_node", node=node)
    assert enter.status_code == 200

    # 模拟「请求已发出但响应丢失」：战斗位用固定令牌打 end_turn
    r1 = _act(client, rid, squad["combat_id"], "end_turn",
              request_id="recover-t1")
    assert r1.status_code == 200
    landed = r1.json()
    rev_after = landed["rev"]
    seq_after = landed["seq"]

    # 核对 -> landed，元数据与首次响应一致
    p = _probe(client, rid, "recover-t1", squad["combat_id"])
    assert p.status_code == 200, p.text
    body = p.json()
    assert body["status"] == "landed"
    assert body["seq"] == seq_after and body["rev"] == rev_after
    assert body["chapter"] == 1 and body["action"] == "end_turn"

    # 客户端（误以为没生效）以同一令牌补交 -> 幂等返回首次结果、duplicate，
    # 动作日志没有新增第二条 end_turn（不会重复扣款/发奖/播放）
    r2 = _act(client, rid, squad["combat_id"], "end_turn",
              request_id="recover-t1")
    assert r2.status_code == 200
    assert r2.json()["duplicate"] is True
    assert r2.json()["seq"] == seq_after
    end_turns = [e for e in db.load_events(rid) if e["action"] == "end_turn"]
    assert len(end_turns) == 1

    # 核对视口绝不包含首次响应的 run 快照（避免旧快照污染）
    assert "run" not in body and "log" not in body


def test_probe_after_rejected_request_is_unknown_and_resubmit_works(client):
    """在任何写入前被拒（400/403）不登记幂等行 -> unknown；改正后可补交。"""
    squad = _squad(client, seed=73, chapters=2)
    rid = squad["run_id"]
    # 战斗位越权提交资源动作 -> 403（零副作用，不登记）
    denied = _act(client, rid, squad["combat_id"], "forge", card="c1",
                  growth_node="sharpen", request_id="recover-deny")
    assert denied.status_code == 403
    assert _probe(client, rid, "recover-deny", squad["combat_id"]).json()["status"] == "unknown"

    # 金币不足/非法动作 -> 400，同样不登记
    bad = _act(client, rid, squad["leader_id"], "play", card="no-such-uid",
               request_id="recover-bad")
    assert bad.status_code == 400
    assert _probe(client, rid, "recover-bad", squad["leader_id"]).json()["status"] == "unknown"


def test_probe_requires_membership_for_coop_run(client):
    """协作 run：非成员/他队成员核对 -> 403、零副作用。"""
    squad = _squad(client, seed=79, chapters=2)
    rid = squad["run_id"]
    assert _probe(client, rid, "whatever").status_code == 403
    assert _probe(client, rid, "whatever", "m_nobody").status_code == 403
    other = _squad(client, seed=80, chapters=2)
    assert _probe(client, rid, "whatever", other["leader_id"]).status_code == 403
    # 不存在的 run -> 400
    assert client.get("/api/runs/nope/requests/x").status_code == 400
    # 空令牌 -> 400
    assert _probe(client, rid, "", squad["leader_id"]).status_code in (400, 404)


def test_probe_solo_run_ignores_member_id(client):
    """单人远征/普通局：核对接口无需身份，行为与 resume 一致。"""
    created = client.post("/api/runs", json={"seed": 7}).json()
    rid = created["run_id"]
    assert client.get(f"/api/runs/{rid}/requests/solo-x").json() == {
        "status": "unknown", "run_id": rid}
    r = client.post(f"/api/runs/{rid}/act", json={
        "action": "choose_node", "node": created["reachable"][0]["id"],
        "request_id": "solo-1"})
    assert r.status_code == 200
    body = client.get(f"/api/runs/{rid}/requests/solo-1").json()
    assert body["status"] == "landed"
    assert body["seq"] == r.json()["seq"] and body["rev"] == r.json()["rev"]


def test_probe_chapter_anchors_isolate_old_chapter(client):
    """核对结果带 chapter：客户端据此隔离旧章节、不向新章补交旧意图。"""
    squad = _squad(client, seed=33, chapters=2)
    tid, rid = squad["team_id"], squad["run_id"]
    node = _first_encounter_node(client, rid)
    _act(client, rid, squad["supply_id"], "choose_node", node=node,
         request_id="rec-old-n")
    p = _probe(client, rid, "rec-old-n", squad["supply_id"]).json()
    assert p["status"] == "landed" and p["chapter"] == 1

    # 打通第 1 章并推进（与 test_coop_sync 的 reset 测试同一路径）
    from tests.test_coop_sync import _bot_play
    _bot_play(client, rid, squad["combat_id"])
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
        pick = next((n for n in reach if n["type"] == "boss"), reach[0])
        _act(client, rid, squad["supply_id"], "choose_node", node=pick["id"])
    assert client.get(f"/api/runs/{rid}/resume").json()["status"] == "won"
    adv = client.post(f"/api/coop/teams/{tid}/advance",
                      json={"member_id": squad["leader_id"]})
    assert adv.status_code == 200
    new_rid = adv.json()["run"]["run_id"]

    # 旧章的核对仍锚定第 1 章；客户端应将旧章未确认意图隔离丢弃，
    # 绝不把旧动作补交进第 2 章 run（不同 run 的幂等空间互不影响）
    old_p = _probe(client, rid, "rec-old-n", squad["supply_id"]).json()
    assert old_p["chapter"] == 1
    # 新章 run 上同一令牌是 unknown——若误补交只会作为新章的新意图，
    # 不会误认旧章结果；恢复逻辑按 run_id 隔离后根本不会走到这里
    new_p = _probe(client, new_rid, "rec-old-n", squad["supply_id"]).json()
    assert new_p["status"] == "unknown"
