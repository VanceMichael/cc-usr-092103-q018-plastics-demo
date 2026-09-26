// 闭展核对与导出管控。
// 核对报告把安全事件、有效演示、样品去向、经客户同意的跟进对象分别列清；
// 导出仅限主办方与安全负责人角色，越权导出会被拦截并留痕。
import { assertDomain } from './errors.js';

const EXPORT_ROLES = ['organizer', 'safety_officer'];

const SAFETY_EVENT_LABELS = {
  guard_open: '护罩开启',
  param_out_of_range: '参数越界',
  abnormal_stop: '异常停机',
};

export function createAudit({ registry, schedule, engagement }) {
  const exportLog = [];

  function closingReport() {
    const safetyIncidents = schedule.listSafetyEvents().map((event) => {
      const machine = registry.getMachine(event.machineId);
      const resolvingInspection = registry
        .listInspections(event.machineId)
        .find((item) => item.result === 'passed' && Date.parse(item.at) > Date.parse(event.at));
      return {
        eventId: event.id,
        type: event.type,
        label: SAFETY_EVENT_LABELS[event.type] ?? event.type,
        machineId: event.machineId,
        booth: machine.booth,
        at: event.at,
        detail: event.detail,
        affectedSlotIds: event.affectedSlotIds,
        resolved: Boolean(resolvingInspection),
        resolvedByInspectionId: resolvingInspection?.id ?? null,
      };
    });

    const validDemos = schedule
      .listSlots()
      .filter((slot) => slot.status === 'completed')
      .map((slot) => {
        const machine = registry.getMachine(slot.machineId);
        return {
          slotId: slot.id,
          machineId: slot.machineId,
          model: machine.model,
          booth: machine.booth,
          operatorId: slot.operatorId,
          start: slot.start,
          end: slot.end,
          completedAt: slot.completedAt,
          inspectionId: slot.approval.inspectionId,
          inspectionVersion: slot.approval.inspectionVersion,
        };
      });

    const sampleWhereabouts = engagement.listEngagements('sample').map((item) => ({
      engagementId: item.id,
      visitorId: item.visitorId,
      machineId: item.machineId,
      machineVersion: item.machineVersion,
      slotId: item.slotId,
      batchId: item.details.batchId,
      qty: item.details.qty,
      at: item.at,
    }));

    const consentedFollowUps = engagement.listLeads().map((lead) => ({
      leadId: lead.id,
      visitorId: lead.visitorId,
      ownerId: lead.ownerId,
      consentedAt: lead.consentedAt,
      engagementIds: lead.engagementIds,
    }));

    return { safetyIncidents, validDemos, sampleWhereabouts, consentedFollowUps };
  }

  function exportReport({ requesterId, role, at }) {
    assertDomain(requesterId, 'REQUESTER_MISSING', '导出必须记录操作人');
    if (!EXPORT_ROLES.includes(role)) {
      exportLog.push({ requesterId, role, at: at ?? null, result: 'denied' });
      assertDomain(false, 'EXPORT_FORBIDDEN', `角色 ${role} 无权导出闭展核对报告`);
    }
    exportLog.push({ requesterId, role, at: at ?? null, result: 'granted' });
    return closingReport();
  }

  return {
    closingReport,
    exportReport,
    listExportLog: () => [...exportLog],
  };
}
