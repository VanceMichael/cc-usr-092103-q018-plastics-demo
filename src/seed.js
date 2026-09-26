// 从样例资料装载展商设备，并按时间顺序回放现场事件。
// 事件之间通过 key 互相引用（例如签到引用某次扫码、恢复引用某次检查），
// 回放器维护 key 到系统生成标识的映射。
import { readFile } from 'node:fs/promises';
import { assertDomain } from './errors.js';

export function loadExpo(backoffice, expo) {
  for (const machine of expo.machines ?? []) {
    backoffice.registerMachine(machine);
  }
  for (const inspection of expo.inspections ?? []) {
    backoffice.recordInspection(inspection);
  }
  return backoffice;
}

export function replayEvents(backoffice, events) {
  const keys = new Map();
  const resolve = (key) => {
    const id = keys.get(key);
    assertDomain(id, 'EVENT_KEY_UNKNOWN', `事件引用了未知的 key ${key}`);
    return id;
  };

  for (const event of events) {
    switch (event.action) {
      case 'requestSlot': {
        const slot = backoffice.requestSlot(event);
        if (event.key) keys.set(event.key, slot.id);
        break;
      }
      case 'approveSlot':
        backoffice.approveSlot({ slotId: resolve(event.slotKey), approvedBy: event.approvedBy, at: event.at });
        break;
      case 'completeSlot':
        backoffice.completeSlot({ slotId: resolve(event.slotKey), at: event.at });
        break;
      case 'safetyEvent': {
        const record = backoffice.reportSafetyEvent(event);
        if (event.key) keys.set(event.key, record.id);
        break;
      }
      case 'recordInspection': {
        const inspection = backoffice.recordInspection(event);
        if (event.key) keys.set(event.key, inspection.id);
        break;
      }
      case 'resumeSlot':
        backoffice.resumeSlot({
          slotId: resolve(event.slotKey),
          inspectionId: resolve(event.inspectionKey),
          approvedBy: event.approvedBy,
          at: event.at,
        });
        break;
      case 'changeover':
        backoffice.applyChangeover(event);
        break;
      case 'scan': {
        const { scan } = backoffice.scan(event);
        if (event.key) keys.set(event.key, scan.id);
        break;
      }
      case 'checkIn':
        backoffice.checkIn({ scanId: resolve(event.scanKey), slotId: resolve(event.slotKey), at: event.at });
        break;
      case 'engagement': {
        const engagement = backoffice.recordEngagement({
          type: event.type,
          visitorId: event.visitorId,
          slotId: resolve(event.slotKey),
          at: event.at,
          details: event.details,
        });
        if (event.key) keys.set(event.key, engagement.id);
        break;
      }
      case 'lead':
        backoffice.createLead({
          visitorId: event.visitorId,
          consented: true,
          consentedAt: event.consentedAt,
          ownerId: event.ownerId,
          engagementIds: event.engagementKeys.map(resolve),
          note: event.note,
        });
        break;
      default:
        assertDomain(false, 'EVENT_ACTION_UNKNOWN', `未知的事件动作 ${event.action}`);
    }
  }
  return keys;
}

export async function loadFixture(name) {
  const raw = await readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
  return JSON.parse(raw);
}
