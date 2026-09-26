import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackoffice } from '../src/index.js';
import { loadExpo, replayEvents, loadFixture } from '../src/seed.js';

async function replayedDay() {
  const backoffice = createBackoffice();
  loadExpo(backoffice, await loadFixture('expo.json'));
  const keys = await replayEvents(backoffice, await loadFixture('onsite-events.json'));
  return { backoffice, keys };
}

test('闭展核对把安全事件、有效演示、样品去向、跟进对象分别列清', async () => {
  const { backoffice, keys } = await replayedDay();
  const report = backoffice.closingReport();

  // 安全事件：两起，护罩开启已凭新检查恢复，参数越界到闭展仍未恢复
  assert.equal(report.safetyIncidents.length, 2);
  const guardOpen = report.safetyIncidents.find((item) => item.type === 'guard_open');
  assert.equal(guardOpen.resolved, true);
  assert.ok(guardOpen.resolvedByInspectionId);
  assert.deepEqual(guardOpen.affectedSlotIds.sort(), [keys.get('S1'), keys.get('S2')].sort());
  const paramOut = report.safetyIncidents.find((item) => item.type === 'param_out_of_range');
  assert.equal(paramOut.resolved, false);
  assert.deepEqual(paramOut.affectedSlotIds, [keys.get('S3')]);

  // 有效演示：只有 S1 完成，且确认单对应恢复后的检查版本 2
  assert.equal(report.validDemos.length, 1);
  assert.equal(report.validDemos[0].slotId, keys.get('S1'));
  assert.equal(report.validDemos[0].inspectionVersion, 2);
  assert.equal(report.validDemos[0].booth, 'A-101');

  // 样品去向：V-001 领取 BAT-PE-01 两件，对应观看时的版本 1
  assert.equal(report.sampleWhereabouts.length, 1);
  assert.deepEqual(report.sampleWhereabouts[0], {
    engagementId: keys.get('E-SP1'),
    visitorId: 'V-001',
    machineId: 'MCH-01',
    machineVersion: 1,
    slotId: keys.get('S1'),
    batchId: 'BAT-PE-01',
    qty: 2,
    at: '2026-09-26T10:12:00Z',
  });

  // 跟进对象：只有经同意的 V-001；围观扫码的 V-009 不在其中
  assert.equal(report.consentedFollowUps.length, 1);
  assert.equal(report.consentedFollowUps[0].visitorId, 'V-001');
  assert.deepEqual(
    report.consentedFollowUps[0].engagementIds.sort(),
    [keys.get('E-QA1'), keys.get('E-SP1'), keys.get('E-QT1')].sort(),
  );
  assert.ok(!report.consentedFollowUps.some((item) => item.visitorId === 'V-009'));
});

test('换料换模取消了受影响的 S2，S4 在新检查后重新批准', async () => {
  const { backoffice, keys } = await replayedDay();
  assert.equal(backoffice.getSlot(keys.get('S2')).status, 'cancelled');
  assert.equal(backoffice.getSlot(keys.get('S4')).status, 'approved');
  assert.equal(backoffice.getSlot(keys.get('S4')).approval.inspectionVersion, 3);
});

test('越权导出被拦截并留痕，主办方与安全负责人可导出', async () => {
  const { backoffice } = await replayedDay();
  assert.throws(() => backoffice.exportReport({ requesterId: 'EXH-01', role: 'exhibitor', at: '2026-09-26T18:00:00Z' }), {
    code: 'EXPORT_FORBIDDEN',
  });
  assert.throws(() => backoffice.exportReport({ requesterId: 'SALES-01', role: 'sales', at: '2026-09-26T18:01:00Z' }), {
    code: 'EXPORT_FORBIDDEN',
  });

  const report = backoffice.exportReport({ requesterId: 'ORG-01', role: 'organizer', at: '2026-09-26T18:02:00Z' });
  assert.ok(report.safetyIncidents.length > 0);
  backoffice.exportReport({ requesterId: 'SAFE-01', role: 'safety_officer', at: '2026-09-26T18:03:00Z' });

  const log = backoffice.listExportLog();
  assert.deepEqual(
    log.map((entry) => entry.result),
    ['denied', 'denied', 'granted', 'granted'],
  );
});
