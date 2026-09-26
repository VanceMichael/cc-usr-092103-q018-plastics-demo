// 演示时段审批与安全冻结。
// 演示按时段申请与批准；护罩开启、参数越界、异常停机会冻结受影响场次，
// 恢复必须引用一份新的已通过检查，旧确认一律作废不得沿用。
import { assertDomain } from './errors.js';

export const SAFETY_EVENT_TYPES = ['guard_open', 'param_out_of_range', 'abnormal_stop'];

const overlaps = (aStart, aEnd, bStart, bEnd) => Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);

export function createSchedule({ registry }) {
  const slots = new Map();
  const safetyEvents = [];
  let seq = 0;
  const nextId = (prefix) => `${prefix}-${String(++seq).padStart(4, '0')}`;

  function getSlot(slotId) {
    const slot = slots.get(slotId);
    assertDomain(slot, 'SLOT_UNKNOWN', `不存在的场次 ${slotId}`);
    return slot;
  }

  function assertParamsWithinRange(machine, plannedParams) {
    for (const [name, value] of Object.entries(plannedParams ?? {})) {
      const range = machine.parameterRanges[name];
      assertDomain(range, 'PARAM_UNKNOWN', `设备 ${machine.id} 未声明参数 ${name} 的范围`);
      assertDomain(
        value >= range.min && value <= range.max,
        'PARAM_OUT_OF_RANGE',
        `参数 ${name}=${value} 超出范围 [${range.min}, ${range.max}]`,
      );
    }
  }

  function assertNoConflict({ machineId, operatorId, start, end }) {
    for (const slot of slots.values()) {
      if (slot.status !== 'requested' && slot.status !== 'approved') continue;
      if (!overlaps(start, end, slot.start, slot.end)) continue;
      assertDomain(slot.machineId !== machineId, 'SLOT_CONFLICT', `设备 ${machineId} 在 ${slot.start}~${slot.end} 已有场次 ${slot.id}`);
      assertDomain(slot.operatorId !== operatorId, 'OPERATOR_CONFLICT', `操作员 ${operatorId} 在 ${slot.start}~${slot.end} 已有场次 ${slot.id}`);
    }
  }

  function requestSlot({ machineId, operatorId, start, end, plannedParams = {} }) {
    const machine = registry.getMachine(machineId);
    assertDomain(Date.parse(start) < Date.parse(end), 'SLOT_WINDOW_INVALID', '场次开始时间必须早于结束时间');
    assertDomain(
      registry.operatorQualified(machine, operatorId, start),
      'OPERATOR_NOT_QUALIFIED',
      `操作员 ${operatorId} 不具备设备 ${machineId} 要求的资格或资格已过期`,
    );
    assertParamsWithinRange(machine, plannedParams);
    assertNoConflict({ machineId, operatorId, start, end });

    const slot = {
      id: nextId('SLOT'),
      machineId,
      operatorId,
      start,
      end,
      plannedParams,
      status: 'requested',
      approval: null,
      approvalHistory: [],
      frozenBy: null,
      frozenVersion: null,
    };
    slots.set(slot.id, slot);
    return slot;
  }

  // 批准演示：设备必须处于可演示状态，确认单绑定当前检查版本。
  function approveSlot({ slotId, approvedBy, at }) {
    const slot = getSlot(slotId);
    assertDomain(slot.status === 'requested', 'SLOT_STATE_INVALID', `场次 ${slotId} 当前状态 ${slot.status} 不能批准`);
    const machine = registry.getMachine(slot.machineId);
    assertDomain(machine.status === 'ready', 'MACHINE_NOT_READY', `设备 ${slot.machineId} 未通过检查，不能批准演示`);

    slot.approval = {
      id: nextId('APR'),
      inspectionId: machine.currentInspectionId,
      inspectionVersion: machine.currentVersion,
      approvedBy,
      at,
    };
    slot.status = 'approved';
    return slot;
  }

  function completeSlot({ slotId, at }) {
    const slot = getSlot(slotId);
    assertDomain(slot.status === 'approved', 'SLOT_STATE_INVALID', `场次 ${slotId} 当前状态 ${slot.status} 不能完成`);
    slot.status = 'completed';
    slot.completedAt = at;
    return slot;
  }

  // 安全事件：冻结设备与所有受影响（尚未完成且结束时间不早于事件发生时刻）的场次。
  function reportSafetyEvent({ machineId, type, at, detail = '', reportedBy }) {
    const machine = registry.getMachine(machineId);
    assertDomain(SAFETY_EVENT_TYPES.includes(type), 'SAFETY_EVENT_TYPE_INVALID', `未知的安全事件类型 ${type}`);
    assertDomain(at, 'SAFETY_EVENT_TIME_MISSING', '安全事件必须记录时间');

    machine.status = 'frozen';
    const event = {
      id: nextId('EVT'),
      machineId,
      type,
      at,
      detail,
      reportedBy: reportedBy ?? '',
      affectedSlotIds: [],
    };
    for (const slot of slots.values()) {
      if (slot.machineId !== machineId) continue;
      if (slot.status !== 'approved' && slot.status !== 'requested') continue;
      if (Date.parse(slot.end) < Date.parse(at)) continue;
      if (slot.status === 'approved') {
        slot.frozenBy = event.id;
        slot.frozenVersion = machine.currentVersion;
        slot.status = 'frozen';
        event.affectedSlotIds.push(slot.id);
      } else {
        slot.status = 'cancelled';
        slot.cancelReason = `安全事件 ${event.id} 发生时仍未批准，自动取消`;
      }
    }
    safetyEvents.push(event);
    return event;
  }

  // 恢复被冻结的场次：必须引用一份新的、比冻结时版本更新的已通过检查。
  // 旧确认单进入历史并标记作废，恢复后生成全新的确认单。
  function resumeSlot({ slotId, inspectionId, approvedBy, at }) {
    const slot = getSlot(slotId);
    assertDomain(slot.status === 'frozen', 'SLOT_NOT_FROZEN', `场次 ${slotId} 未处于冻结状态`);
    const machine = registry.getMachine(slot.machineId);
    const inspection = registry.getInspection(inspectionId);

    assertDomain(inspection.machineId === slot.machineId, 'INSPECTION_MACHINE_MISMATCH', '引用的检查不属于该设备');
    assertDomain(inspection.result === 'passed', 'INSPECTION_NOT_PASSED', '恢复必须引用已通过的检查');
    assertDomain(
      inspection.version > slot.frozenVersion,
      'INSPECTION_STALE',
      `检查版本 ${inspection.version} 不高于冻结时版本 ${slot.frozenVersion}，旧确认不得沿用`,
    );
    assertDomain(
      machine.currentInspectionId === inspection.id,
      'INSPECTION_NOT_CURRENT',
      '恢复必须引用设备当前最新的已通过检查',
    );

    slot.approvalHistory.push({ ...slot.approval, supersededBy: inspection.id, supersededAt: at });
    slot.approval = {
      id: nextId('APR'),
      inspectionId: inspection.id,
      inspectionVersion: inspection.version,
      approvedBy,
      at,
      resumedFrom: slot.frozenBy,
    };
    slot.status = 'approved';
    slot.frozenBy = null;
    slot.frozenVersion = null;
    return slot;
  }

  // 换料换模后，尚未完成的场次一律取消，需待重新检查后再申请。
  function cancelSlotsForChangeover(machineId, at) {
    const cancelled = [];
    for (const slot of slots.values()) {
      if (slot.machineId !== machineId) continue;
      if (slot.status !== 'requested' && slot.status !== 'approved') continue;
      if (Date.parse(slot.end) <= Date.parse(at)) continue;
      slot.status = 'cancelled';
      slot.cancelReason = '换料换模后需重新检查并审批';
      cancelled.push(slot.id);
    }
    return cancelled;
  }

  return {
    requestSlot,
    approveSlot,
    completeSlot,
    reportSafetyEvent,
    resumeSlot,
    cancelSlotsForChangeover,
    getSlot,
    listSlots: (machineId) => [...slots.values()].filter((slot) => !machineId || slot.machineId === machineId),
    listSafetyEvents: () => [...safetyEvents],
  };
}
