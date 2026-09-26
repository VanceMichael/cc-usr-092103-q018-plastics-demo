import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackoffice } from './support/helpers.js';

test('新注册设备必须通过检查才能批准演示', async () => {
  const backoffice = await makeBackoffice();
  backoffice.registerMachine({
    id: 'MCH-09',
    exhibitorId: 'EXH-01',
    model: '测试机',
    booth: 'B-201',
    requiredQualification: 'blow-molding',
    parameterRanges: { barrelTempC: { min: 160, max: 210 } },
    materialBatches: [],
    molds: [],
    riskZones: [{ id: 'RZ-9', name: '合模区', level: 'high' }],
    operators: [{ id: 'OP-09', name: '丙', qualifications: [{ type: 'blow-molding', expiresAt: '2027-01-01T00:00:00Z' }] }],
  });
  assert.equal(backoffice.getMachine('MCH-09').status, 'needs-inspection');

  const slot = backoffice.requestSlot({
    machineId: 'MCH-09',
    operatorId: 'OP-09',
    start: '2026-09-26T13:00:00Z',
    end: '2026-09-26T13:30:00Z',
    plannedParams: { barrelTempC: 180 },
  });
  assert.throws(() => backoffice.approveSlot({ slotId: slot.id, approvedBy: 'ORG-01', at: '2026-09-26T12:00:00Z' }), {
    code: 'MACHINE_NOT_READY',
  });

  backoffice.recordInspection({ machineId: 'MCH-09', inspectorId: 'SAFE-01', result: 'passed', at: '2026-09-26T12:10:00Z' });
  assert.equal(backoffice.getMachine('MCH-09').status, 'ready');
  backoffice.approveSlot({ slotId: slot.id, approvedBy: 'ORG-01', at: '2026-09-26T12:11:00Z' });
  assert.equal(backoffice.getSlot(slot.id).status, 'approved');
});

test('检查版本递增，未通过的检查不更新当前版本', async () => {
  const backoffice = await makeBackoffice();
  const before = backoffice.getMachine('MCH-01');
  assert.equal(before.currentVersion, 1);

  const failed = backoffice.recordInspection({ machineId: 'MCH-01', inspectorId: 'SAFE-01', result: 'failed', at: '2026-09-26T12:00:00Z' });
  assert.equal(failed.version, 2);
  const machine = backoffice.getMachine('MCH-01');
  assert.equal(machine.currentVersion, 1);
  assert.equal(machine.status, 'needs-inspection');

  const passed = backoffice.recordInspection({ machineId: 'MCH-01', inspectorId: 'SAFE-01', result: 'passed', at: '2026-09-26T12:30:00Z' });
  assert.equal(passed.version, 3);
  assert.equal(backoffice.getMachine('MCH-01').currentVersion, 3);
});

test('换料换模更新批次与模具，并使设备回到待检查状态', async () => {
  const backoffice = await makeBackoffice();
  const record = backoffice.applyChangeover({
    machineId: 'MCH-01',
    at: '2026-09-26T11:00:00Z',
    by: 'OP-01',
    addMaterialBatches: [{ id: 'BAT-PE-02', material: 'HDPE' }],
    addMolds: [{ id: 'MOLD-20L', name: '20L 桶模' }],
    removeMoldIds: ['MOLD-5L'],
  });
  assert.ok(record.id.startsWith('CHG-'));
  const machine = backoffice.getMachine('MCH-01');
  assert.equal(machine.status, 'needs-inspection');
  assert.deepEqual(
    machine.materialBatches.map((batch) => batch.id),
    ['BAT-PE-01', 'BAT-PE-02'],
  );
  assert.deepEqual(
    machine.molds.map((mold) => mold.id),
    ['MOLD-20L'],
  );
});

test('安全事件未解除时禁止换料换模', async () => {
  const backoffice = await makeBackoffice();
  backoffice.reportSafetyEvent({ machineId: 'MCH-01', type: 'abnormal_stop', at: '2026-09-26T10:00:00Z' });
  assert.throws(() => backoffice.applyChangeover({ machineId: 'MCH-01', at: '2026-09-26T10:05:00Z', by: 'OP-01' }), {
    code: 'MACHINE_FROZEN',
  });
});

test('移除不存在的批次或模具会被拒绝', async () => {
  const backoffice = await makeBackoffice();
  assert.throws(
    () => backoffice.applyChangeover({ machineId: 'MCH-01', at: '2026-09-26T11:00:00Z', by: 'OP-01', removeMaterialBatchIds: ['BAT-XX'] }),
    { code: 'BATCH_UNKNOWN' },
  );
});
