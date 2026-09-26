// 组合层：把设备档案、时段审批、现场互动、闭展核对组装成一个后台入口。
// 换料换模在这里联动：设备回到待检查状态的同时，取消所有受影响的已批准场次。
import { createMachineRegistry } from './machines.js';
import { createSchedule } from './schedule.js';
import { createEngagement } from './engagement.js';
import { createAudit } from './audit.js';

export function createBackoffice() {
  const registry = createMachineRegistry();
  const schedule = createSchedule({ registry });
  const engagement = createEngagement({ registry, schedule });
  const audit = createAudit({ registry, schedule, engagement });

  return {
    ...registry,
    ...schedule,
    ...engagement,
    ...audit,
    applyChangeover(input) {
      const record = registry.applyChangeover(input);
      const cancelledSlotIds = schedule.cancelSlotsForChangeover(input.machineId, input.at);
      return { ...record, cancelledSlotIds };
    },
  };
}
