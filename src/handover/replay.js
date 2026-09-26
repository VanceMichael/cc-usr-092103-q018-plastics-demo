// 按时间顺序回放现场事件脚本，驱动交接后台，并收集被拒绝的事件。
// 被拒绝的事件不影响其他事件：每条拒绝都留下原因码，供闭展核对时解释现场差异。

import { HandoverBackend } from './backend.js';
import { DomainError } from './errors.js';

const DISPATCH = {
  register_inspection: (b, e) => b.registerInspection(e.machine_id, { ...e.inspection, at: e.inspection.at ?? e.at }),
  approve_slot: (b, e) => b.approveSlot({
    slot_id: e.slot_id,
    machine_id: e.machine_id,
    start: e.start,
    end: e.end,
    operator_id: e.operator_id,
    material_batch_id: e.material_batch_id,
    mold_id: e.mold_id,
    inspection_id: e.inspection_id,
    approved_by: e.approved_by,
  }),
  resume_slot: (b, e) => b.resumeSlot({
    session_id: e.session_id,
    resumed_session_id: e.resumed_session_id,
    inspection_id: e.inspection_id,
    approved_by: e.approved_by,
    at: e.start ?? e.at,
    end: e.end,
  }),
  complete_session: (b, e) => b.completeSession({ session_id: e.session_id, at: e.at }),
  scan: (b, e) => b.recordScan({ visitor_id: e.visitor_id, session_id: e.session_id, at: e.at }),
  record_params: (b, e) => b.recordParams({ session_id: e.session_id, params: e.params, at: e.at }),
  record_qa: (b, e) => b.recordQA({
    id: e.id, session_id: e.session_id, visitor_id: e.visitor_id, summary: e.summary, at: e.at,
  }),
  record_quote: (b, e) => b.recordQuote({
    id: e.id, session_id: e.session_id, visitor_id: e.visitor_id,
    amount: e.amount, currency: e.currency, at: e.at,
  }),
  record_consent: (b, e) => b.recordConsent({
    visitor_id: e.visitor_id, exhibitor_id: e.exhibitor_id,
    statement: e.statement, channel: e.channel, at: e.at,
  }),
  produce_sample: (b, e) => b.produceSample({
    id: e.id, session_id: e.session_id,
    material_batch_id: e.material_batch_id, mold_id: e.mold_id, at: e.at,
  }),
  dispose_sample: (b, e) => b.disposeSample({
    sample_id: e.sample_id, action: e.action,
    to_visitor_id: e.to_visitor_id ?? null, staff_id: e.staff_id, at: e.at,
  }),
  guard_open: (b, e) => b.guardOpen({ machine_id: e.machine_id, zone_id: e.zone_id, at: e.at }),
  abnormal_stop: (b, e) => b.abnormalStop({ machine_id: e.machine_id, detail: e.detail, at: e.at }),
  export: (b, e) => b.exportReport({
    actor: e.actor, role: e.role, kind: e.kind,
    exhibitor_id: e.exhibitor_id ?? null, for_exhibitor_id: e.for_exhibitor_id ?? null, at: e.at,
  }),
};

export function replay(data, { generatedAt } = {}) {
  const backend = new HandoverBackend({
    exhibitors: data.exhibitors,
    operators: data.operators,
    machines: data.machines,
  });
  const events = [...data.events].sort((a, b2) => a.at.localeCompare(b2.at));
  const rejections = [];
  const applied = [];
  for (const event of events) {
    const handler = DISPATCH[event.type];
    if (!handler) {
      rejections.push({ at: event.at, type: event.type, code: 'UNKNOWN_EVENT', message: `未知事件类型：${event.type}` });
      continue;
    }
    try {
      const result = handler(backend, event);
      applied.push({ at: event.at, type: event.type, result });
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      rejections.push({
        at: event.at,
        type: event.type,
        code: err.code,
        message: err.message,
        event,
      });
    }
  }
  const at = generatedAt ?? events[events.length - 1]?.at;
  return { backend, report: backend.reconciliation(at), rejections, applied };
}
