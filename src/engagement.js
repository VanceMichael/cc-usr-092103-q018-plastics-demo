// 现场互动与商机授权。
// 扫码只代表“围观”，签到才证明客户观看了某台设备的某个检查版本；
// 技术问答、样品领取、报价都必须挂在有效签到上；
// 只有客户明确同意且存在有效互动，才允许生成跟进商机。
import { assertDomain } from './errors.js';

const SCAN_DEDUP_WINDOW_MS = 30 * 60 * 1000;
export const ENGAGEMENT_TYPES = ['qa', 'sample', 'quote'];

export function createEngagement({ registry, schedule }) {
  const scans = [];
  const attendances = [];
  const engagements = [];
  const leads = [];
  let seq = 0;
  const nextId = (prefix) => `${prefix}-${String(++seq).padStart(4, '0')}`;

  // 扫码登记：同一访客在同一设备 30 分钟内重复扫码只保留首条记录。
  function scan({ visitorId, machineId, at }) {
    registry.getMachine(machineId);
    assertDomain(visitorId, 'VISITOR_MISSING', '扫码必须携带访客标识');
    assertDomain(at, 'SCAN_TIME_MISSING', '扫码必须记录时间');

    const existing = scans.find(
      (item) =>
        item.visitorId === visitorId &&
        item.machineId === machineId &&
        Math.abs(Date.parse(at) - Date.parse(item.at)) <= SCAN_DEDUP_WINDOW_MS,
    );
    if (existing) {
      return { scan: existing, duplicate: true };
    }
    const record = { id: nextId('SCAN'), visitorId, machineId, at };
    scans.push(record);
    return { scan: record, duplicate: false };
  }

  // 签到：把扫码绑定到具体场次，并钉住客户实际观看的设备检查版本。
  function checkIn({ scanId, slotId, at }) {
    const scanRecord = scans.find((item) => item.id === scanId);
    assertDomain(scanRecord, 'SCAN_UNKNOWN', `不存在的扫码记录 ${scanId}`);
    const slot = schedule.getSlot(slotId);
    assertDomain(scanRecord.machineId === slot.machineId, 'SCAN_SLOT_MISMATCH', '扫码设备与场次设备不一致');
    assertDomain(slot.status === 'approved', 'SLOT_NOT_APPROVED', `场次 ${slotId} 未处于可演示状态，不能签到`);
    assertDomain(
      Date.parse(at) >= Date.parse(slot.start) && Date.parse(at) <= Date.parse(slot.end),
      'CHECKIN_OUTSIDE_WINDOW',
      '签到时间不在场次时段内',
    );

    const machine = registry.getMachine(slot.machineId);
    assertDomain(
      slot.approval.inspectionVersion === machine.currentVersion,
      'VERSION_STALE',
      '场次确认单对应的检查版本已失效，需重新审批',
    );

    const existing = attendances.find((item) => item.visitorId === scanRecord.visitorId && item.slotId === slotId);
    if (existing) {
      return { attendance: existing, duplicate: true };
    }
    const attendance = {
      id: nextId('ATT'),
      visitorId: scanRecord.visitorId,
      slotId,
      machineId: slot.machineId,
      machineVersion: machine.currentVersion,
      at,
    };
    attendances.push(attendance);
    return { attendance, duplicate: false };
  }

  // 技术问答 / 样品领取 / 报价：必须基于有效签到，版本号继承签到时钉住的版本。
  function recordEngagement({ type, visitorId, slotId, at, details = {} }) {
    assertDomain(ENGAGEMENT_TYPES.includes(type), 'ENGAGEMENT_TYPE_INVALID', `未知的互动类型 ${type}`);
    const attendance = attendances.find((item) => item.visitorId === visitorId && item.slotId === slotId);
    assertDomain(attendance, 'ATTENDANCE_REQUIRED', '客户未签到该场次，不能记录互动');

    const slot = schedule.getSlot(slotId);
    assertDomain(
      slot.status === 'approved' || slot.status === 'completed',
      'SLOT_NOT_VALID',
      `场次 ${slotId} 状态 ${slot.status} 不允许记录互动`,
    );

    const machine = registry.getMachine(slot.machineId);
    if (type === 'sample') {
      assertDomain(
        machine.materialBatches.some((batch) => batch.id === details.batchId),
        'BATCH_UNKNOWN',
        `样料批次 ${details.batchId} 不在设备 ${machine.id} 当前批次中`,
      );
      assertDomain(Number.isInteger(details.qty) && details.qty > 0, 'SAMPLE_QTY_INVALID', '样品领取数量必须为正整数');
    }
    if (type === 'quote') {
      assertDomain(typeof details.amount === 'number' && details.amount > 0, 'QUOTE_AMOUNT_INVALID', '报价金额必须为正数');
      assertDomain(details.currency, 'QUOTE_CURRENCY_MISSING', '报价必须记录币种');
    }

    const engagement = {
      id: nextId('ENG'),
      type,
      visitorId,
      slotId,
      machineId: slot.machineId,
      machineVersion: attendance.machineVersion,
      at,
      details,
    };
    engagements.push(engagement);
    return engagement;
  }

  // 生成商机：围观扫码本身永远不够，必须客户同意且至少有一条有效互动。
  function createLead({ visitorId, consented, consentedAt, ownerId, engagementIds, note = '' }) {
    assertDomain(consented === true && consentedAt, 'CONSENT_REQUIRED', '未经客户明确同意，不能生成跟进商机');
    assertDomain(ownerId, 'LEAD_OWNER_MISSING', '商机必须指定跟进人');
    assertDomain(!leads.some((lead) => lead.visitorId === visitorId), 'LEAD_EXISTS', `访客 ${visitorId} 已存在商机`);

    const owned = (engagementIds ?? []).map((id) => {
      const engagement = engagements.find((item) => item.id === id);
      assertDomain(engagement, 'ENGAGEMENT_UNKNOWN', `不存在的互动记录 ${id}`);
      assertDomain(engagement.visitorId === visitorId, 'ENGAGEMENT_VISITOR_MISMATCH', `互动 ${id} 不属于访客 ${visitorId}`);
      return engagement;
    });
    assertDomain(owned.length > 0, 'NO_VALID_ENGAGEMENT', '仅围观扫码不能生成商机，需要至少一条有效互动');

    const lead = {
      id: nextId('LEAD'),
      visitorId,
      consentedAt,
      ownerId,
      engagementIds: owned.map((item) => item.id),
      note,
      status: 'new',
    };
    leads.push(lead);
    return lead;
  }

  return {
    scan,
    checkIn,
    recordEngagement,
    createLead,
    listScans: () => [...scans],
    listAttendances: () => [...attendances],
    listEngagements: (type) => engagements.filter((item) => !type || item.type === type),
    listLeads: () => [...leads],
  };
}
