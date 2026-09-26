import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HandoverBackend } from '../src/handover/backend.js';
import { replay } from '../src/handover/replay.js';
import { DomainError, ConflictError, AuthorizationError } from '../src/handover/errors.js';

const T = (h, m) => `2026-09-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`;

function minimalData() {
  return {
    exhibitors: [
      { id: 'EX-1', name: '展商甲（虚构）', booth: 'A-1' },
      { id: 'EX-2', name: '展商乙（虚构）', booth: 'B-2' },
    ],
    operators: [
      { id: 'OP-A', name: '甲', certs: [{ type: 'inj', valid_until: '2027-01-01T00:00:00+08:00' }] },
      { id: 'OP-EXPIRED', name: '资格过期', certs: [{ type: 'inj', valid_until: '2026-01-01T00:00:00+08:00' }] },
    ],
    machines: [
      {
        id: 'M-1',
        exhibitor_id: 'EX-1',
        model: '机型一',
        booth: 'A-1',
        required_cert: 'inj',
        param_ranges: { temp: [100, 200], pressure: [10, 50] },
        material_batches: [
          { id: 'B-1', material: 'PP' },
          { id: 'B-2', material: 'PE' },
        ],
        molds: [
          { id: 'D-1', name: '模具一' },
          { id: 'D-2', name: '模具二' },
        ],
        risk_zones: [{ id: 'RZ-1', name: '合模区', level: 'high' }],
        inspections: [
          { id: 'I-1', version: 1, at: T(8, 0), result: 'pass', covers: { material_batch_id: 'B-1', mold_id: 'D-1' } },
        ],
      },
    ],
  };
}

function backend() {
  return new HandoverBackend(minimalData());
}

function approve(backend, over = {}) {
  return backend.approveSlot({
    slot_id: 'S-1',
    machine_id: 'M-1',
    start: T(9, 0),
    end: T(9, 45),
    operator_id: 'OP-A',
    material_batch_id: 'B-1',
    mold_id: 'D-1',
    inspection_id: 'I-1',
    approved_by: 'org',
    ...over,
  });
}

// ---------- 时段批准 ----------

test('批准演示：合格操作员 + 匹配批次模具的合格检查才能通过', () => {
  const b = backend();
  const s = approve(b);
  assert.equal(s.status, 'approved');
  assert.equal(s.inspection_version, 1);
});

test('拒绝：操作员资格过期', () => {
  const b = backend();
  assert.throws(() => approve(b, { operator_id: 'OP-EXPIRED' }), (e) => e.code === 'OPERATOR_NOT_QUALIFIED');
});

test('拒绝：检查不覆盖本场的样料批次/模具', () => {
  const b = backend();
  assert.throws(() => approve(b, { material_batch_id: 'B-2' }), (e) => e.code === 'INSPECTION_MISMATCH');
});

test('拒绝：同设备时段冲突与同操作员撞场', () => {
  const b = backend();
  approve(b);
  assert.throws(
    () => approve(b, { slot_id: 'S-2', start: T(9, 30), end: T(10, 0) }),
    (e) => e.code === 'SLOT_CONFLICT',
  );
});

test('拒绝：检查未通过不能批准', () => {
  const data = minimalData();
  data.machines[0].inspections[0].result = 'fail';
  const b = new HandoverBackend(data);
  assert.throws(() => approve(b), (e) => e.code === 'INSPECTION_NOT_PASSED');
});

// ---------- 冻结与恢复 ----------

test('护罩开启冻结同配置场次，恢复必须引用新检查；旧确认不得沿用', () => {
  const b = backend();
  approve(b);
  b.guardOpen({ machine_id: 'M-1', zone_id: 'RZ-1', at: T(9, 20) });
  assert.equal(b.sessions.get('S-1').status, 'frozen');

  // 沿用旧检查恢复被拒绝
  assert.throws(
    () => b.resumeSlot({ session_id: 'S-1', resumed_session_id: 'S-1-R', inspection_id: 'I-1', approved_by: 'org', at: T(9, 40), end: T(10, 0) }),
    (e) => e.code === 'STALE_INSPECTION',
  );

  // 新检查必须晚于冻结时间
  b.registerInspection('M-1', { id: 'I-EARLY', version: 2, at: T(9, 10), result: 'pass', covers: { material_batch_id: 'B-1', mold_id: 'D-1' } });
  assert.throws(
    () => b.resumeSlot({ session_id: 'S-1', resumed_session_id: 'S-1-R', inspection_id: 'I-EARLY', approved_by: 'org', at: T(9, 40), end: T(10, 0) }),
    (e) => e.code === 'INSPECTION_TOO_EARLY',
  );

  b.registerInspection('M-1', { id: 'I-2', version: 3, at: T(9, 30), result: 'pass', covers: { material_batch_id: 'B-1', mold_id: 'D-1' } });
  const r = b.resumeSlot({ session_id: 'S-1', resumed_session_id: 'S-1-R', inspection_id: 'I-2', approved_by: 'org', at: T(9, 40), end: T(10, 0) });
  assert.equal(r.status, 'resumed');
  assert.equal(r.resumed_from, 'S-1');
  assert.equal(b.sessions.get('S-1').status, 'superseded');
});

test('参数越界自动冻结场次，冻结期间登记问答被拒', () => {
  const b = backend();
  approve(b);
  assert.throws(
    () => b.recordParams({ session_id: 'S-1', params: { temp: 250 }, at: T(9, 10) }),
    (e) => e.code === 'PARAM_OUT_OF_RANGE',
  );
  assert.equal(b.sessions.get('S-1').status, 'frozen');
  assert.equal(b.incidents[0].type, 'param_breach');
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 5) });
  assert.throws(
    () => b.recordQA({ id: 'Q-1', session_id: 'S-1', visitor_id: 'V-1', summary: '问', at: T(9, 12) }),
    (e) => e.code === 'SESSION_NOT_LIVE',
  );
});

test('异常停机冻结进行中场次；冻结后已过窗口的场次不能恢复', () => {
  const b = backend();
  approve(b);
  b.abnormalStop({ machine_id: 'M-1', at: T(9, 20), detail: '液压异常' });
  assert.equal(b.sessions.get('S-1').status, 'frozen');
  assert.equal(b.incidents[0].type, 'abnormal_stop');
});

test('恢复产生新场次，旧场次的扫码不自动转移', () => {
  const b = backend();
  approve(b);
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 5) });
  b.guardOpen({ machine_id: 'M-1', zone_id: 'RZ-1', at: T(9, 20) });
  b.registerInspection('M-1', { id: 'I-2', version: 2, at: T(9, 30), result: 'pass', covers: { material_batch_id: 'B-1', mold_id: 'D-1' } });
  b.resumeSlot({ session_id: 'S-1', resumed_session_id: 'S-1-R', inspection_id: 'I-2', approved_by: 'org', at: T(9, 40), end: T(10, 0) });
  // 没有在新场次扫码，不能凭旧场次扫码登记
  assert.throws(
    () => b.recordQA({ id: 'Q-1', session_id: 'S-1-R', visitor_id: 'V-1', summary: '问', at: T(9, 45) }),
    (e) => e.code === 'NO_ATTENDANCE',
  );
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1-R', at: T(9, 42) });
  const qa = b.recordQA({ id: 'Q-2', session_id: 'S-1-R', visitor_id: 'V-1', summary: '再问', at: T(9, 45) });
  assert.equal(qa.proof.inspection_version, 2);
  assert.equal(qa.proof.inspection_id, 'I-2');
});

// ---------- 扫码与凭证 ----------

test('重复扫码只计一次', () => {
  const b = backend();
  approve(b);
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 5) });
  assert.throws(
    () => b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 6) }),
    (e) => e instanceof ConflictError && e.code === 'DUPLICATE_SCAN',
  );
});

test('扫码必须落在场次窗口内', () => {
  const b = backend();
  approve(b);
  assert.throws(
    () => b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(8, 59) }),
    (e) => e.code === 'SCAN_OUT_OF_WINDOW',
  );
});

test('未扫码观看的客户不能登记问答/报价/领取样品', () => {
  const b = backend();
  approve(b);
  assert.throws(
    () => b.recordQA({ id: 'Q-1', session_id: 'S-1', visitor_id: 'V-9', summary: '问', at: T(9, 30) }),
    (e) => e.code === 'NO_ATTENDANCE',
  );
});

test('问答/报价必须在演示窗口内，闭馆补录被拒', () => {
  const b = backend();
  approve(b);
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 5) });
  assert.throws(
    () => b.recordQA({ id: 'Q-1', session_id: 'S-1', visitor_id: 'V-1', summary: '问', at: T(9, 50) }),
    (e) => e.code === 'SESSION_ENDED',
  );
});

test('凭证绑定客户真正观看过的设备版本：问答与报价携带检查版本', () => {
  const b = backend();
  approve(b);
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 5) });
  const qa = b.recordQA({ id: 'Q-1', session_id: 'S-1', visitor_id: 'V-1', summary: '参数', at: T(9, 10) });
  const quote = b.recordQuote({ id: 'P-1', session_id: 'S-1', visitor_id: 'V-1', amount: 100, currency: 'CNY', at: T(9, 15) });
  assert.deepEqual(
    { id: qa.proof.inspection_id, v: qa.proof.inspection_version, machine: qa.proof.machine_id, batch: qa.proof.material_batch_id, mold: qa.proof.mold_id },
    { id: 'I-1', v: 1, machine: 'M-1', batch: 'B-1', mold: 'D-1' },
  );
  assert.equal(quote.proof.inspection_id, 'I-1');
});

// ---------- 样品 ----------

test('样品生产绑定场次配置与检查版本，去向必须登记且不得重复', () => {
  const b = backend();
  approve(b);
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 5) });
  const smp = b.produceSample({ id: 'G-1', session_id: 'S-1', material_batch_id: 'B-1', mold_id: 'D-1', at: T(9, 20) });
  assert.equal(smp.inspection_version, 1);
  assert.throws(
    () => b.produceSample({ id: 'G-1', session_id: 'S-1', material_batch_id: 'B-1', mold_id: 'D-1', at: T(9, 21) }),
    (e) => e.code === 'DUPLICATE_SAMPLE',
  );
  assert.throws(() => b.disposeSample({ sample_id: 'G-1', action: 'handed_out', at: T(9, 25) }), (e) => e.code === 'STAFF_REQUIRED');
  assert.throws(
    () => b.disposeSample({ sample_id: 'G-1', action: 'handed_out', staff_id: 'ST-1', at: T(9, 25) }),
    (e) => e.code === 'RECIPIENT_REQUIRED',
  );
  // 领取人未观看本场
  assert.throws(
    () => b.disposeSample({ sample_id: 'G-1', action: 'handed_out', to_visitor_id: 'V-9', staff_id: 'ST-1', at: T(9, 25) }),
    (e) => e.code === 'NO_ATTENDANCE',
  );
  b.disposeSample({ sample_id: 'G-1', action: 'handed_out', to_visitor_id: 'V-1', staff_id: 'ST-1', at: T(9, 26) });
  assert.throws(
    () => b.disposeSample({ sample_id: 'G-1', action: 'discarded', staff_id: 'ST-1', at: T(9, 27) }),
    (e) => e.code === 'ALREADY_DISPOSED',
  );
});

// ---------- 商机边界 ----------

test('围观扫码不自动成为商机；同意 + 有效互动才是商机', () => {
  const b = backend();
  approve(b);
  b.recordScan({ visitor_id: 'BYSTANDER', session_id: 'S-1', at: T(9, 5) });
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 6) });
  b.recordQA({ id: 'Q-1', session_id: 'S-1', visitor_id: 'V-1', summary: '问', at: T(9, 10) });
  // 没有同意：有问答也不是商机
  assert.equal(b.leads().length, 0);
  b.recordConsent({ visitor_id: 'V-1', exhibitor_id: 'EX-1', statement: '同意跟进', channel: '电子', at: T(9, 20) });
  assert.throws(
    () => b.recordConsent({ visitor_id: 'V-1', exhibitor_id: 'EX-1', statement: '重复同意', channel: '电子', at: T(9, 21) }),
    (e) => e.code === 'DUPLICATE_CONSENT',
  );
  // 场次未有效完成前，凭证尚不能入商机
  assert.equal(b.leads().length, 0);
  b.completeSession({ session_id: 'S-1', at: T(9, 45) });
  const leads = b.leads();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].visitor_id, 'V-1');
  assert.equal(leads[0].interactions.length, 1);
});

test('场次冻结未恢复时，已登记互动不构成有效商机', () => {
  const b = backend();
  approve(b);
  b.recordScan({ visitor_id: 'V-1', session_id: 'S-1', at: T(9, 5) });
  b.recordQA({ id: 'Q-1', session_id: 'S-1', visitor_id: 'V-1', summary: '问', at: T(9, 10) });
  b.recordConsent({ visitor_id: 'V-1', exhibitor_id: 'EX-1', statement: '同意跟进', channel: '电子', at: T(9, 12) });
  b.guardOpen({ machine_id: 'M-1', zone_id: 'RZ-1', at: T(9, 20) });
  // 场次未完成也未恢复：商机为空
  assert.equal(b.leads().length, 0);
  const rep = b.reconciliation(T(17, 0));
  assert.ok(rep.frozen_sessions.some((s) => s.slot_id === 'S-1'));
});

// ---------- 导出授权 ----------

test('导出按角色授权，越权拒绝并留痕', () => {
  const b = backend();
  approve(b);
  assert.doesNotThrow(() => b.exportReport({ actor: 'org', role: 'organizer', kind: 'reconciliation', at: T(17, 0) }));
  assert.throws(
    () => b.exportReport({ actor: 'org', role: 'organizer', kind: 'leads', at: T(17, 1) }),
    (e) => e instanceof AuthorizationError && e.code === 'EXPORT_DENIED',
  );
  assert.doesNotThrow(() => b.exportReport({ actor: 's1', role: 'exhibitor', exhibitor_id: 'EX-1', kind: 'leads', at: T(17, 2) }));
  assert.throws(
    () => b.exportReport({ actor: 's1', role: 'exhibitor', exhibitor_id: 'EX-1', for_exhibitor_id: 'EX-2', kind: 'leads', at: T(17, 3) }),
    (e) => e.code === 'EXPORT_DENIED',
  );
  assert.throws(
    () => b.exportReport({ actor: 's1', role: 'exhibitor', exhibitor_id: 'EX-1', kind: 'safety', at: T(17, 4) }),
    (e) => e.code === 'EXPORT_DENIED',
  );
  assert.doesNotThrow(() => b.exportReport({ actor: 'safe', role: 'safety_officer', kind: 'safety', at: T(17, 5) }));
  assert.throws(
    () => b.exportReport({ actor: 'safe', role: 'safety_officer', kind: 'reconciliation', at: T(17, 6) }),
    (e) => e.code === 'EXPORT_DENIED',
  );
  // 被拒绝的尝试也进入审计
  const denied = b.auditLog.filter((a) => !a.allowed);
  assert.ok(denied.length >= 4);
});

// ---------- 端到端：回放现场样例 ----------

test('端到端：fixture 整天事件回放结果符合预期', async () => {
  const raw = await readFile(new URL('../fixtures/exhibition.json', import.meta.url), 'utf8');
  const data = JSON.parse(raw);
  const { report, rejections } = replay(data);

  // 三类安全事件
  assert.deepEqual(report.safety_events.map((e) => e.type).sort(), ['abnormal_stop', 'guard_open', 'param_breach']);
  // 越界冻结了 S-M1-2/S-M1-3；护罩冻结了 S-M2-2
  assert.deepEqual(report.safety_events[0].affected_sessions, ['S-M1-2', 'S-M1-3']);
  assert.deepEqual(report.safety_events[1].affected_sessions, ['S-M2-2']);

  // 有效演示：5 场，含 3 场带新检查版本的恢复场
  assert.equal(report.valid_demos.length, 5);
  const resumed = report.valid_demos.filter((d) => d.resumed_from);
  assert.equal(resumed.length, 3);
  assert.deepEqual(
    resumed.map((d) => [d.slot_id, d.inspection_id, d.inspection_version]).sort(),
    [
      ['S-M1-2-R1', 'INS-5', 3],
      ['S-M1-3-R1', 'INS-5', 3],
      ['S-M2-2-R1', 'INS-6', 2],
    ],
  );

  // 样品全部有去向，发放对象与检查版本一致
  assert.equal(report.sample_dispositions.length, 6);
  assert.deepEqual(report.undisposed_samples, []);
  const handed = report.sample_dispositions.filter((s) => s.disposition.action === 'handed_out');
  assert.deepEqual(handed.map((s) => [s.sample_id, s.disposition.to_visitor_id, s.inspection_version]).sort(), [
    ['SMP-1', 'V-1001', 1],
    ['SMP-3', 'V-1004', 3],
    ['SMP-4', 'V-1006', 2],
  ]);
  assert.ok(handed.every((s) => s.proof_valid === true));

  // 商机：3 条，每条互动凭证都指向已完成场次的具体检查版本；围观客户 V-1002/V-1003/V-1005 不入围
  assert.equal(report.leads.length, 3);
  const leadPairs = report.leads.map((l) => [l.visitor_id, l.exhibitor_id]);
  assert.deepEqual(leadPairs, [
    ['V-1001', 'EX-HC'],
    ['V-1004', 'EX-HC'],
    ['V-1006', 'EX-HC'],
  ]);
  for (const lead of report.leads) {
    for (const i of lead.interactions) {
      assert.equal(report.valid_demos.some((d) => d.slot_id === i.proof.session_id), true);
      assert.ok(i.proof.inspection_version >= 1);
    }
  }
  assert.ok(report.bystanders.includes('V-1003'));
  assert.ok(!report.bystanders.includes('V-1002')); // V-1002 有问答但未同意，属于互动但非商机，也非纯围观
  // V-1002 未同意跟进：不在商机中
  assert.ok(!report.leads.some((l) => l.visitor_id === 'V-1002'));

  // 扫码去重
  assert.equal(report.scan_stats.duplicates, 1);

  // 关键拒绝码全部出现
  const codes = new Set(rejections.map((r) => r.code));
  for (const code of [
    'SLOT_CONFLICT',
    'OPERATOR_NOT_QUALIFIED',
    'INSPECTION_MISMATCH',
    'DUPLICATE_SCAN',
    'PARAM_OUT_OF_RANGE',
    'STALE_INSPECTION',
    'SESSION_NOT_LIVE',
    'SESSION_ENDED',
    'SCAN_OUT_OF_WINDOW',
    'EXPORT_DENIED',
  ]) {
    assert.ok(codes.has(code), `缺少拒绝码 ${code}`);
  }

  // 导出审计包含被拒绝的越权尝试
  const deniedExports = report.export_audit.filter((a) => !a.allowed);
  assert.equal(deniedExports.length, 3);

  // 异常停机时无进行中场次（M-90 恢复场已完成，S-M2-1 早已结束）
  assert.deepEqual(report.safety_events[2].affected_sessions, []);
});
