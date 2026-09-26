import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBackoffice, approvedSlot } from './support/helpers.js';

async function checkedInVisitor(backoffice, visitorId = 'V-100') {
  const slot = await approvedSlot(backoffice);
  const { scan } = backoffice.scan({ visitorId, machineId: 'MCH-01', at: '2026-09-26T10:01:00Z' });
  const { attendance } = backoffice.checkIn({ scanId: scan.id, slotId: slot.id, at: '2026-09-26T10:05:00Z' });
  return { slot, scan, attendance };
}

test('重复扫码在 30 分钟内去重，超时后允许重新登记', async () => {
  const backoffice = await makeBackoffice();
  const first = backoffice.scan({ visitorId: 'V-100', machineId: 'MCH-01', at: '2026-09-26T10:00:00Z' });
  const dup = backoffice.scan({ visitorId: 'V-100', machineId: 'MCH-01', at: '2026-09-26T10:20:00Z' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.scan.id, first.scan.id);
  assert.equal(backoffice.listScans().length, 1);

  const later = backoffice.scan({ visitorId: 'V-100', machineId: 'MCH-01', at: '2026-09-26T10:31:00Z' });
  assert.equal(later.duplicate, false);
  assert.equal(backoffice.listScans().length, 2);
});

test('未签到的访客不能记录技术问答、样品或报价', async () => {
  const backoffice = await makeBackoffice();
  const slot = await approvedSlot(backoffice);
  assert.throws(
    () => backoffice.recordEngagement({ type: 'qa', visitorId: 'V-100', slotId: slot.id, at: '2026-09-26T10:10:00Z', details: {} }),
    { code: 'ATTENDANCE_REQUIRED' },
  );
});

test('签到要求场次已批准且时间在时段内', async () => {
  const backoffice = await makeBackoffice();
  const slot = backoffice.requestSlot({
    machineId: 'MCH-01',
    operatorId: 'OP-01',
    start: '2026-09-26T10:00:00Z',
    end: '2026-09-26T10:30:00Z',
    plannedParams: {},
  });
  const { scan } = backoffice.scan({ visitorId: 'V-100', machineId: 'MCH-01', at: '2026-09-26T10:01:00Z' });
  assert.throws(() => backoffice.checkIn({ scanId: scan.id, slotId: slot.id, at: '2026-09-26T10:05:00Z' }), {
    code: 'SLOT_NOT_APPROVED',
  });

  const ok = await approvedSlot(backoffice, { start: '2026-09-26T11:00:00Z', end: '2026-09-26T11:30:00Z' });
  assert.throws(() => backoffice.checkIn({ scanId: scan.id, slotId: ok.id, at: '2026-09-26T10:05:00Z' }), {
    code: 'CHECKIN_OUTSIDE_WINDOW',
  });
});

test('互动记录钉住客户实际观看的检查版本', async () => {
  const backoffice = await makeBackoffice();
  const slot = await approvedSlot(backoffice, { start: '2026-09-26T10:00:00Z', end: '2026-09-26T11:30:00Z' });
  const { scan } = backoffice.scan({ visitorId: 'V-100', machineId: 'MCH-01', at: '2026-09-26T10:01:00Z' });
  backoffice.checkIn({ scanId: scan.id, slotId: slot.id, at: '2026-09-26T10:05:00Z' });
  const qa = backoffice.recordEngagement({
    type: 'qa',
    visitorId: 'V-100',
    slotId: slot.id,
    at: '2026-09-26T10:10:00Z',
    details: { topic: '壁厚控制' },
  });
  assert.equal(qa.machineVersion, 1);

  // 安全事件后重新检查，设备版本前进到 2；此前的互动仍然指向版本 1
  backoffice.reportSafetyEvent({ machineId: 'MCH-01', type: 'guard_open', at: '2026-09-26T10:20:00Z' });
  const inspection = backoffice.recordInspection({ machineId: 'MCH-01', inspectorId: 'SAFE-01', result: 'passed', at: '2026-09-26T10:40:00Z' });
  backoffice.resumeSlot({ slotId: slot.id, inspectionId: inspection.id, approvedBy: 'ORG-01', at: '2026-09-26T10:41:00Z' });
  assert.equal(backoffice.getMachine('MCH-01').currentVersion, 2);
  assert.equal(qa.machineVersion, 1);

  // 恢复后新签到钉住新版本
  const { scan: scan2 } = backoffice.scan({ visitorId: 'V-200', machineId: 'MCH-01', at: '2026-09-26T10:45:00Z' });
  const { attendance } = backoffice.checkIn({ scanId: scan2.id, slotId: slot.id, at: '2026-09-26T10:46:00Z' });
  assert.equal(attendance.machineVersion, 2);
});

test('样品领取必须来自设备当前批次', async () => {
  const backoffice = await makeBackoffice();
  const { slot } = await checkedInVisitor(backoffice);
  assert.throws(
    () =>
      backoffice.recordEngagement({
        type: 'sample',
        visitorId: 'V-100',
        slotId: slot.id,
        at: '2026-09-26T10:10:00Z',
        details: { batchId: 'BAT-PP-01', qty: 1 },
      }),
    { code: 'BATCH_UNKNOWN' },
  );
  const sample = backoffice.recordEngagement({
    type: 'sample',
    visitorId: 'V-100',
    slotId: slot.id,
    at: '2026-09-26T10:10:00Z',
    details: { batchId: 'BAT-PE-01', qty: 2 },
  });
  assert.equal(sample.details.batchId, 'BAT-PE-01');
});

test('围观扫码不能成为商机，必须客户同意且有有效互动', async () => {
  const backoffice = await makeBackoffice();
  const { scan } = backoffice.scan({ visitorId: 'V-300', machineId: 'MCH-01', at: '2026-09-26T10:00:00Z' });
  assert.ok(scan);

  // 只有扫码、没有任何互动
  assert.throws(
    () => backoffice.createLead({ visitorId: 'V-300', consented: true, consentedAt: '2026-09-26T10:30:00Z', ownerId: 'SALES-01', engagementIds: [] }),
    { code: 'NO_VALID_ENGAGEMENT' },
  );

  const { slot } = await checkedInVisitor(backoffice, 'V-400');
  const qa = backoffice.recordEngagement({ type: 'qa', visitorId: 'V-400', slotId: slot.id, at: '2026-09-26T10:10:00Z', details: {} });

  // 未经客户同意
  assert.throws(
    () => backoffice.createLead({ visitorId: 'V-400', consented: false, ownerId: 'SALES-01', engagementIds: [qa.id] }),
    { code: 'CONSENT_REQUIRED' },
  );
  // 引用他人互动
  assert.throws(
    () => backoffice.createLead({ visitorId: 'V-300', consented: true, consentedAt: '2026-09-26T10:35:00Z', ownerId: 'SALES-01', engagementIds: [qa.id] }),
    { code: 'ENGAGEMENT_VISITOR_MISMATCH' },
  );

  const lead = backoffice.createLead({
    visitorId: 'V-400',
    consented: true,
    consentedAt: '2026-09-26T10:40:00Z',
    ownerId: 'SALES-01',
    engagementIds: [qa.id],
  });
  assert.equal(lead.status, 'new');
  assert.throws(
    () => backoffice.createLead({ visitorId: 'V-400', consented: true, consentedAt: '2026-09-26T10:41:00Z', ownerId: 'SALES-02', engagementIds: [qa.id] }),
    { code: 'LEAD_EXISTS' },
  );
});
