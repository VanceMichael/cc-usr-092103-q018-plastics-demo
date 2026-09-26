import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackoffice, approvedSlot } from './support/helpers.js';

test('同一设备时段冲突的申请被拒绝，相邻时段可以接受', async () => {
  const backoffice = await makeBackoffice();
  await approvedSlot(backoffice);
  assert.throws(
    () =>
      backoffice.requestSlot({
        machineId: 'MCH-01',
        operatorId: 'OP-01',
        start: '2026-09-26T10:15:00Z',
        end: '2026-09-26T10:45:00Z',
        plannedParams: {},
      }),
    { code: 'SLOT_CONFLICT' },
  );
  const adjacent = backoffice.requestSlot({
    machineId: 'MCH-01',
    operatorId: 'OP-01',
    start: '2026-09-26T10:30:00Z',
    end: '2026-09-26T11:00:00Z',
    plannedParams: {},
  });
  assert.equal(adjacent.status, 'requested');
});

test('同一操作员不能同时在两台设备上演示', async () => {
  const backoffice = await makeBackoffice();
  backoffice.registerMachine({
    id: 'MCH-08',
    exhibitorId: 'EXH-01',
    model: '另一台吹塑机',
    booth: 'A-103',
    requiredQualification: 'blow-molding',
    parameterRanges: { barrelTempC: { min: 160, max: 210 } },
    materialBatches: [],
    molds: [],
    riskZones: [{ id: 'RZ-8', name: '合模区', level: 'high' }],
    operators: [{ id: 'OP-01', name: '操作员甲（虚构）', qualifications: [{ type: 'blow-molding', expiresAt: '2027-03-31T00:00:00Z' }] }],
  });
  await approvedSlot(backoffice);
  assert.throws(
    () =>
      backoffice.requestSlot({
        machineId: 'MCH-08',
        operatorId: 'OP-01',
        start: '2026-09-26T10:15:00Z',
        end: '2026-09-26T10:45:00Z',
        plannedParams: {},
      }),
    { code: 'OPERATOR_CONFLICT' },
  );
});

test('计划参数越界或未声明范围时拒绝申请', async () => {
  const backoffice = await makeBackoffice();
  assert.throws(
    () =>
      backoffice.requestSlot({
        machineId: 'MCH-01',
        operatorId: 'OP-01',
        start: '2026-09-26T10:00:00Z',
        end: '2026-09-26T10:30:00Z',
        plannedParams: { barrelTempC: 250 },
      }),
    { code: 'PARAM_OUT_OF_RANGE' },
  );
  assert.throws(
    () =>
      backoffice.requestSlot({
        machineId: 'MCH-01',
        operatorId: 'OP-01',
        start: '2026-09-26T10:00:00Z',
        end: '2026-09-26T10:30:00Z',
        plannedParams: { unknownParam: 1 },
      }),
    { code: 'PARAM_UNKNOWN' },
  );
});

test('操作员资格过期不能申请场次', async () => {
  const backoffice = await makeBackoffice();
  assert.throws(
    () =>
      backoffice.requestSlot({
        machineId: 'MCH-01',
        operatorId: 'OP-01',
        start: '2027-04-01T10:00:00Z',
        end: '2027-04-01T10:30:00Z',
        plannedParams: {},
      }),
    { code: 'OPERATOR_NOT_QUALIFIED' },
  );
});

test('安全事件冻结受影响场次，已完成与未批准场次分别处理', async () => {
  const backoffice = await makeBackoffice();
  const done = await approvedSlot(backoffice);
  backoffice.completeSlot({ slotId: done.id, at: '2026-09-26T10:30:00Z' });

  const running = await approvedSlot(backoffice, { start: '2026-09-26T11:00:00Z', end: '2026-09-26T11:30:00Z' });
  const pending = backoffice.requestSlot({
    machineId: 'MCH-01',
    operatorId: 'OP-01',
    start: '2026-09-26T12:00:00Z',
    end: '2026-09-26T12:30:00Z',
    plannedParams: {},
  });

  const event = backoffice.reportSafetyEvent({ machineId: 'MCH-01', type: 'guard_open', at: '2026-09-26T11:10:00Z', detail: '护罩误开' });
  assert.deepEqual(event.affectedSlotIds, [running.id]);
  assert.equal(backoffice.getSlot(running.id).status, 'frozen');
  assert.equal(backoffice.getSlot(done.id).status, 'completed');
  assert.equal(backoffice.getSlot(pending.id).status, 'cancelled');
  assert.equal(backoffice.getMachine('MCH-01').status, 'frozen');
});

test('恢复必须引用新检查，旧确认不得沿用', async () => {
  const backoffice = await makeBackoffice();
  const slot = await approvedSlot(backoffice);
  const oldApprovalId = slot.approval.id;
  const oldInspectionId = slot.approval.inspectionId;

  backoffice.reportSafetyEvent({ machineId: 'MCH-01', type: 'param_out_of_range', at: '2026-09-26T10:10:00Z' });
  assert.equal(backoffice.getSlot(slot.id).status, 'frozen');

  // 引用冻结时的旧检查：拒绝
  assert.throws(() => backoffice.resumeSlot({ slotId: slot.id, inspectionId: oldInspectionId, approvedBy: 'ORG-01', at: '2026-09-26T10:20:00Z' }), {
    code: 'INSPECTION_STALE',
  });

  backoffice.recordInspection({ machineId: 'MCH-01', inspectorId: 'SAFE-01', result: 'passed', at: '2026-09-26T10:25:00Z' });
  const newer = backoffice.recordInspection({ machineId: 'MCH-01', inspectorId: 'SAFE-01', result: 'passed', at: '2026-09-26T10:28:00Z' });

  // 引用不是当前最新的检查：拒绝
  const staleCurrent = backoffice.listInspections('MCH-01').find((item) => item.version === 2);
  assert.throws(() => backoffice.resumeSlot({ slotId: slot.id, inspectionId: staleCurrent.id, approvedBy: 'ORG-01', at: '2026-09-26T10:30:00Z' }), {
    code: 'INSPECTION_NOT_CURRENT',
  });

  // 引用最新检查：恢复成功，且生成全新确认单，旧确认进入历史
  backoffice.resumeSlot({ slotId: slot.id, inspectionId: newer.id, approvedBy: 'ORG-01', at: '2026-09-26T10:31:00Z' });
  const resumed = backoffice.getSlot(slot.id);
  assert.equal(resumed.status, 'approved');
  assert.notEqual(resumed.approval.id, oldApprovalId);
  assert.equal(resumed.approval.inspectionVersion, 3);
  assert.equal(resumed.approvalHistory.length, 1);
  assert.equal(resumed.approvalHistory[0].id, oldApprovalId);
  assert.ok(resumed.approvalHistory[0].supersededBy);
});

test('未冻结的场次不能走恢复流程', async () => {
  const backoffice = await makeBackoffice();
  const slot = await approvedSlot(backoffice);
  const inspectionId = backoffice.getMachine('MCH-01').currentInspectionId;
  assert.throws(() => backoffice.resumeSlot({ slotId: slot.id, inspectionId, approvedBy: 'ORG-01', at: '2026-09-26T10:00:00Z' }), {
    code: 'SLOT_NOT_FROZEN',
  });
});

test('换料换模取消受影响场次，重新检查后才能再批准', async () => {
  const backoffice = await makeBackoffice();
  const slot = await approvedSlot(backoffice, { start: '2026-09-26T11:30:00Z', end: '2026-09-26T12:00:00Z' });

  const changeover = backoffice.applyChangeover({
    machineId: 'MCH-01',
    at: '2026-09-26T11:00:00Z',
    by: 'OP-01',
    addMolds: [{ id: 'MOLD-20L', name: '20L 桶模' }],
  });
  assert.deepEqual(changeover.cancelledSlotIds, [slot.id]);
  assert.equal(backoffice.getSlot(slot.id).status, 'cancelled');

  const next = backoffice.requestSlot({
    machineId: 'MCH-01',
    operatorId: 'OP-01',
    start: '2026-09-26T11:30:00Z',
    end: '2026-09-26T12:00:00Z',
    plannedParams: {},
  });
  assert.throws(() => backoffice.approveSlot({ slotId: next.id, approvedBy: 'ORG-01', at: '2026-09-26T11:05:00Z' }), {
    code: 'MACHINE_NOT_READY',
  });
  backoffice.recordInspection({ machineId: 'MCH-01', inspectorId: 'SAFE-01', result: 'passed', at: '2026-09-26T11:20:00Z' });
  backoffice.approveSlot({ slotId: next.id, approvedBy: 'ORG-01', at: '2026-09-26T11:21:00Z' });
  assert.equal(backoffice.getSlot(next.id).status, 'approved');
});
