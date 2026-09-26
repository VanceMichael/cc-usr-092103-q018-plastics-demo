import { createBackoffice } from '../../src/index.js';
import { loadExpo, loadFixture } from '../../src/seed.js';

export async function makeBackoffice() {
  const backoffice = createBackoffice();
  loadExpo(backoffice, await loadFixture('expo.json'));
  return backoffice;
}

// 申请并批准一个场次的快捷方式，返回场次。
export async function approvedSlot(backoffice, overrides = {}) {
  const slot = backoffice.requestSlot({
    machineId: 'MCH-01',
    operatorId: 'OP-01',
    start: '2026-09-26T10:00:00Z',
    end: '2026-09-26T10:30:00Z',
    plannedParams: { barrelTempC: 185, clampForceKN: 1000, cycleTimeS: 30 },
    ...overrides,
  });
  backoffice.approveSlot({ slotId: slot.id, approvedBy: 'ORG-01', at: '2026-09-26T09:35:00Z' });
  return slot;
}
