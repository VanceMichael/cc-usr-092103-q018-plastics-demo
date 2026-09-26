// 塑机演示与商机交接后台。
//
// 核心约定：
// - 每台塑机保存型号、展位、工艺参数范围、样料批次、模具、操作员资格、风险区域与检查版本；
// - 演示按时段批准，批准时必须引用覆盖当前“样料批次 + 模具”的合格检查；
// - 护罩开启、参数越界、异常停机会冻结受影响场次（同机同配置），恢复必须引用更新的合格检查，
//   旧确认不得沿用；恢复产生新场次，旧场次的扫码与凭证不自动转移；
// - 每条技术问答、样品领取、报价都必须能落到“客户观看过的设备版本”（场次 + 检查版本）；
// - 围观扫码只是到场记录，只有客户明确同意跟进的才成为商机；
// - 导出按角色授权，越权一律拒绝并留痕。

import { DomainError, ConflictError, AuthorizationError } from './errors.js';

const LIVE_STATUSES = new Set(['approved', 'resumed']);
const INCIDENT_TYPES = new Set(['guard_open', 'param_breach', 'abnormal_stop']);

function ts(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new DomainError('BAD_TIME', `时间格式无效：${iso}`);
  return t;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return ts(aStart) < ts(bEnd) && ts(bStart) < ts(aEnd);
}

export class HandoverBackend {
  constructor({ exhibitors = [], operators = [], machines = [] } = {}) {
    this.exhibitors = new Map(exhibitors.map((e) => [e.id, e]));
    this.operators = new Map(operators.map((o) => [o.id, o]));
    this.machines = new Map();
    for (const m of machines) {
      this.machines.set(m.id, {
        ...m,
        inspections: [...(m.inspections ?? [])],
      });
    }
    this.sessions = new Map(); // slot_id -> 场次
    this.incidents = []; // 安全事件
    this.attendance = new Map(); // visitor_id -> Map(session_id -> 扫码记录)
    this.scanAttempts = []; // 全部扫码尝试（含重复）
    this.qa = [];
    this.quotes = [];
    this.samples = new Map();
    this.consents = new Map(); // `${visitor_id}|${exhibitor_id}` -> 同意记录
    this.auditLog = []; // 导出审计（含被拒绝的尝试）
  }

  // ---------- 基础校验 ----------

  #machine(machineId) {
    const m = this.machines.get(machineId);
    if (!m) throw new DomainError('UNKNOWN_MACHINE', `未知设备：${machineId}`);
    return m;
  }

  #session(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new DomainError('UNKNOWN_SESSION', `未知场次：${sessionId}`);
    return s;
  }

  #assertOperatorQualified(operatorId, machine, start) {
    const op = this.operators.get(operatorId);
    if (!op) throw new DomainError('UNKNOWN_OPERATOR', `未知操作员：${operatorId}`);
    const ok = (op.certs ?? []).some(
      (c) => c.type === machine.required_cert && ts(c.valid_until) >= ts(start),
    );
    if (!ok) {
      throw new DomainError(
        'OPERATOR_NOT_QUALIFIED',
        `操作员 ${operatorId} 不具备 ${machine.model} 所需的 ${machine.required_cert} 有效资格`,
      );
    }
  }

  #assertInspectionCovers(machine, inspectionId, batchId, moldId) {
    const ins = machine.inspections.find((i) => i.id === inspectionId);
    if (!ins) throw new DomainError('UNKNOWN_INSPECTION', `设备 ${machine.id} 无检查记录 ${inspectionId}`);
    if (ins.result !== 'pass') {
      throw new DomainError('INSPECTION_NOT_PASSED', `检查 ${inspectionId} 未合格，不能用于批准演示`);
    }
    if (ins.covers.material_batch_id !== batchId || ins.covers.mold_id !== moldId) {
      throw new DomainError(
        'INSPECTION_MISMATCH',
        `检查 ${inspectionId} 覆盖 ${ins.covers.material_batch_id}/${ins.covers.mold_id}，` +
          `与本场 ${batchId}/${moldId} 不一致`,
      );
    }
    return ins;
  }

  #assertConfig(machine, batchId, moldId) {
    if (!machine.material_batches.some((b) => b.id === batchId)) {
      throw new DomainError('UNKNOWN_BATCH', `设备 ${machine.id} 无样料批次 ${batchId}`);
    }
    if (!machine.molds.some((m) => m.id === moldId)) {
      throw new DomainError('UNKNOWN_MOLD', `设备 ${machine.id} 无模具 ${moldId}`);
    }
  }

  // ---------- 检查版本 ----------

  registerInspection(machineId, inspection) {
    const machine = this.#machine(machineId);
    if (!inspection?.id || !inspection?.at || !inspection?.result || !inspection?.covers) {
      throw new DomainError('BAD_INSPECTION', '检查记录缺少必要字段');
    }
    if (machine.inspections.some((i) => i.id === inspection.id)) {
      throw new ConflictError('DUPLICATE_INSPECTION', `检查 ${inspection.id} 已存在，不得重复登记`);
    }
    const prevVersion = machine.inspections.reduce((v, i) => Math.max(v, i.version ?? 0), 0);
    const version = inspection.version ?? prevVersion + 1;
    if (version <= prevVersion) {
      throw new DomainError('INSPECTION_VERSION_REGRESSION', `检查版本必须递增（当前 ${prevVersion}）`);
    }
    this.#assertConfig(machine, inspection.covers.material_batch_id, inspection.covers.mold_id);
    const record = { ...inspection, version };
    machine.inspections.push(record);
    return record;
  }

  // ---------- 时段批准与冲突 ----------

  approveSlot({ slot_id, machine_id, start, end, operator_id, material_batch_id, mold_id, inspection_id, approved_by }) {
    if (this.sessions.has(slot_id)) {
      throw new ConflictError('DUPLICATE_SLOT', `场次编号 ${slot_id} 已被占用`);
    }
    if (ts(start) >= ts(end)) {
      throw new DomainError('BAD_WINDOW', `场次 ${slot_id} 起止时间无效`);
    }
    const machine = this.#machine(machine_id);
    this.#assertOperatorQualified(operator_id, machine, start);
    this.#assertConfig(machine, material_batch_id, mold_id);
    const inspection = this.#assertInspectionCovers(machine, inspection_id, material_batch_id, mold_id);

    for (const s of this.sessions.values()) {
      if (!LIVE_STATUSES.has(s.status)) continue;
      if (!overlaps(start, end, s.start, s.end)) continue;
      if (s.machine_id === machine_id) {
        throw new ConflictError('SLOT_CONFLICT', `设备 ${machine_id} 在 ${s.start}~${s.end} 已有场次 ${s.slot_id}`);
      }
      if (s.operator_id === operator_id) {
        throw new ConflictError('OPERATOR_DOUBLE_BOOKED', `操作员 ${operator_id} 在 ${s.start}~${s.end} 已排定场次 ${s.slot_id}`);
      }
    }

    const session = {
      slot_id,
      machine_id,
      exhibitor_id: machine.exhibitor_id,
      start,
      end,
      operator_id,
      material_batch_id,
      mold_id,
      inspection_id,
      inspection_version: inspection.version,
      status: 'approved',
      approved_by,
      frozen_at: null,
      frozen_by: null,
      resumed_from: null,
      resumed_with: null,
      completed_at: null,
    };
    this.sessions.set(slot_id, session);
    return session;
  }

  // ---------- 工艺参数 ----------

  // 记录场次实际工艺参数；任何一项超出设备登记范围即判定越界并冻结同配置场次。
  recordParams({ session_id, params, at }) {
    const s = this.#session(session_id);
    if (!LIVE_STATUSES.has(s.status)) {
      throw new DomainError('SESSION_NOT_LIVE', `场次 ${session_id} 当前状态为 ${s.status}，不能记录参数`);
    }
    if (ts(at) > ts(s.end)) {
      throw new DomainError('SESSION_ENDED', `场次 ${session_id} 演示窗口已结束，不能补录参数`);
    }
    const machine = this.#machine(s.machine_id);
    const breaches = [];
    for (const [key, value] of Object.entries(params)) {
      const range = machine.param_ranges[key];
      if (!range) {
        throw new DomainError('UNKNOWN_PARAM', `设备 ${machine.id} 无工艺参数 ${key}`);
      }
      if (value < range[0] || value > range[1]) {
        breaches.push({ param: key, value, range });
      }
    }
    s.recorded_params = { ...(s.recorded_params ?? {}), ...params };
    if (breaches.length > 0) {
      const detail = breaches
        .map((b) => `${b.param}=${b.value}（允许 ${b.range[0]}~${b.range[1]}）`)
        .join('；');
      this.#recordIncident(machine, 'param_breach', at, `工艺参数越界：${detail}`, s, {
        readings: { ...s.recorded_params },
        breaches,
      });
      throw new DomainError('PARAM_OUT_OF_RANGE', `场次 ${session_id} 参数越界，已冻结：${detail}`);
    }
    return s.recorded_params;
  }

  // ---------- 安全事件与冻结 ----------

  // 冻结同机、同样料批次+模具配置的进行中/已批准场次；参数越界时以读数所属场次配置为准。
  #freeze(machine, at, incident, configRef) {
    const affected = [];
    for (const s of this.sessions.values()) {
      if (s.machine_id !== machine.id || !LIVE_STATUSES.has(s.status)) continue;
      if (ts(s.end) < ts(at)) continue; // 已过结束时间的场次无需冻结，补录由窗口校验拦截
      if (s.material_batch_id !== configRef.material_batch_id || s.mold_id !== configRef.mold_id) continue;
      s.status = 'frozen';
      s.frozen_at = at;
      s.frozen_by = incident.id;
      affected.push(s.slot_id);
    }
    incident.affected_sessions = affected;
  }

  #recordIncident(machine, type, at, detail, configRef, extra = {}) {
    const incident = {
      id: `INC-${this.incidents.length + 1}`,
      machine_id: machine.id,
      type,
      at,
      detail,
      ...extra,
    };
    this.#freeze(machine, at, incident, configRef);
    this.incidents.push(incident);
    return incident;
  }

  guardOpen({ machine_id, zone_id, at }) {
    const machine = this.#machine(machine_id);
    if (!machine.risk_zones.some((z) => z.id === zone_id)) {
      throw new DomainError('UNKNOWN_ZONE', `设备 ${machine_id} 无风险区域 ${zone_id}`);
    }
    const live = [...this.sessions.values()].find(
      (s) => s.machine_id === machine_id && LIVE_STATUSES.has(s.status),
    );
    const configRef = live ?? this.#latestConfig(machine_id);
    return this.#recordIncident(machine, 'guard_open', at, `风险区域 ${zone_id} 护罩开启`, configRef, { zone_id });
  }

  abnormalStop({ machine_id, at, detail = '异常停机' }) {
    const machine = this.#machine(machine_id);
    const live = [...this.sessions.values()].find(
      (s) => s.machine_id === machine_id && LIVE_STATUSES.has(s.status),
    );
    const configRef = live ?? this.#latestConfig(machine_id);
    return this.#recordIncident(machine, 'abnormal_stop', at, detail, configRef);
  }

  #latestConfig(machineId) {
    const sessions = [...this.sessions.values()].filter((s) => s.machine_id === machineId);
    const last = sessions[sessions.length - 1];
    if (last) return { material_batch_id: last.material_batch_id, mold_id: last.mold_id };
    const machine = this.#machine(machineId);
    return {
      material_batch_id: machine.material_batches[0].id,
      mold_id: machine.molds[0].id,
    };
  }

  // 恢复被冻结的时段：必须引用一张新的、覆盖原配置的合格检查；旧确认不得沿用。
  resumeSlot({ session_id, resumed_session_id, inspection_id, approved_by, at, end }) {
    const old = this.#session(session_id);
    if (old.status !== 'frozen') {
      throw new DomainError('NOT_FROZEN', `场次 ${session_id} 未处于冻结状态，无需恢复`);
    }
    if (this.sessions.has(resumed_session_id)) {
      throw new ConflictError('DUPLICATE_SLOT', `场次编号 ${resumed_session_id} 已被占用`);
    }
    if (old.inspection_id === inspection_id) {
      throw new DomainError('STALE_INSPECTION', `不得沿用旧检查 ${inspection_id} 恢复演示，必须引用新的合格检查`);
    }
    const machine = this.#machine(old.machine_id);
    const inspection = this.#assertInspectionCovers(machine, inspection_id, old.material_batch_id, old.mold_id);
    if (ts(inspection.at) <= ts(old.frozen_at)) {
      throw new DomainError('INSPECTION_TOO_EARLY', `检查 ${inspection_id} 早于冻结时间，不能作为恢复依据`);
    }
    const newEnd = end ?? old.end;
    if (ts(at) >= ts(newEnd)) {
      throw new DomainError('BAD_WINDOW', `恢复场次 ${resumed_session_id} 的窗口无效（${at} ~ ${newEnd}）`);
    }
    for (const other of this.sessions.values()) {
      if (!LIVE_STATUSES.has(other.status) || other.slot_id === old.slot_id) continue;
      if (!overlaps(at, newEnd, other.start, other.end)) continue;
      if (other.machine_id === old.machine_id) {
        throw new ConflictError('SLOT_CONFLICT', `设备 ${old.machine_id} 在 ${other.start}~${other.end} 已有场次 ${other.slot_id}`);
      }
      if (other.operator_id === old.operator_id) {
        throw new ConflictError('OPERATOR_DOUBLE_BOOKED', `操作员 ${old.operator_id} 在 ${other.start}~${other.end} 已排定场次 ${other.slot_id}`);
      }
    }
    const session = {
      slot_id: resumed_session_id,
      machine_id: old.machine_id,
      exhibitor_id: old.exhibitor_id,
      start: at,
      end: newEnd,
      operator_id: old.operator_id,
      material_batch_id: old.material_batch_id,
      mold_id: old.mold_id,
      inspection_id,
      inspection_version: inspection.version,
      status: 'resumed',
      approved_by,
      frozen_at: null,
      frozen_by: null,
      resumed_from: old.slot_id,
      resumed_with: inspection_id,
      completed_at: null,
    };
    old.status = 'superseded';
    this.sessions.set(resumed_session_id, session);
    return session;
  }

  completeSession({ session_id, at }) {
    const s = this.#session(session_id);
    if (!LIVE_STATUSES.has(s.status)) {
      throw new DomainError('NOT_LIVE', `场次 ${session_id} 当前状态为 ${s.status}，不能标记完成`);
    }
    s.status = 'completed';
    s.completed_at = at;
    return s;
  }

  // ---------- 扫码与观看凭证 ----------

  recordScan({ visitor_id, session_id, at }) {
    const s = this.#session(session_id);
    if (ts(at) < ts(s.start) || ts(at) > ts(s.end)) {
      throw new DomainError('SCAN_OUT_OF_WINDOW', `扫码时间不在场次 ${session_id} 的演示窗口内`);
    }
    this.scanAttempts.push({ visitor_id, session_id, at });
    let byVisitor = this.attendance.get(visitor_id);
    if (!byVisitor) {
      byVisitor = new Map();
      this.attendance.set(visitor_id, byVisitor);
    }
    if (byVisitor.has(session_id)) {
      throw new ConflictError('DUPLICATE_SCAN', `访客 ${visitor_id} 已扫过场次 ${session_id}，重复扫码不计入`);
    }
    const record = { visitor_id, session_id, at };
    byVisitor.set(session_id, record);
    return record;
  }

  // 观看凭证快照：客户在该场次窗口内扫过码。凭证固定场次当时引用的设备检查版本；
  // 场次是否“真正有效完成”由闭展核对时统一判定（未完成场的互动不进商机）。
  #witness(visitorId, sessionId) {
    const s = this.#session(sessionId);
    const seen = this.attendance.get(visitorId)?.get(sessionId);
    if (!seen) {
      throw new DomainError('NO_ATTENDANCE', `访客 ${visitorId} 未扫码观看场次 ${sessionId}`);
    }
    const machine = this.#machine(s.machine_id);
    return {
      scanned_at: seen.at,
      session_id: s.slot_id,
      machine_id: s.machine_id,
      machine_model: machine.model,
      inspection_id: s.inspection_id,
      inspection_version: s.inspection_version,
      material_batch_id: s.material_batch_id,
      mold_id: s.mold_id,
    };
  }

  // ---------- 技术问答 / 报价 / 样品 ----------

  recordQA({ id, session_id, visitor_id, summary, at }) {
    const s = this.#session(session_id);
    if (!LIVE_STATUSES.has(s.status)) {
      throw new DomainError('SESSION_NOT_LIVE', `场次 ${session_id} 当前状态为 ${s.status}，不能登记问答`);
    }
    if (ts(at) > ts(s.end)) {
      throw new DomainError('SESSION_ENDED', `场次 ${session_id} 演示窗口已结束，不能补录问答`);
    }
    const proof = this.#witness(visitor_id, session_id);
    const record = { id, visitor_id, summary, at, proof };
    this.qa.push(record);
    return record;
  }

  recordQuote({ id, session_id, visitor_id, amount, currency, at }) {
    const s = this.#session(session_id);
    if (!LIVE_STATUSES.has(s.status)) {
      throw new DomainError('SESSION_NOT_LIVE', `场次 ${session_id} 当前状态为 ${s.status}，不能登记报价`);
    }
    if (ts(at) > ts(s.end)) {
      throw new DomainError('SESSION_ENDED', `场次 ${session_id} 演示窗口已结束，不能补录报价`);
    }
    const proof = this.#witness(visitor_id, session_id);
    const record = { id, visitor_id, amount, currency, at, proof };
    this.quotes.push(record);
    return record;
  }

  produceSample({ id, session_id, material_batch_id, mold_id, at }) {
    if (this.samples.has(id)) {
      throw new ConflictError('DUPLICATE_SAMPLE', `样品编号 ${id} 已存在`);
    }
    const s = this.#session(session_id);
    if (!LIVE_STATUSES.has(s.status)) {
      throw new DomainError('SESSION_NOT_LIVE', `场次 ${session_id} 当前状态为 ${s.status}，不能登记样品`);
    }
    if (ts(at) > ts(s.end)) {
      throw new DomainError('SESSION_ENDED', `场次 ${session_id} 演示窗口已结束，不能补录样品`);
    }
    if (s.material_batch_id !== material_batch_id || s.mold_id !== mold_id) {
      throw new DomainError('SAMPLE_CONFIG_MISMATCH', `样品配置与本场 ${s.material_batch_id}/${s.mold_id} 不一致`);
    }
    const machine = this.#machine(s.machine_id);
    const sample = {
      id,
      session_id,
      machine_id: s.machine_id,
      machine_model: machine.model,
      inspection_id: s.inspection_id,
      inspection_version: s.inspection_version,
      material_batch_id,
      mold_id,
      produced_at: at,
      disposition: null,
    };
    this.samples.set(id, sample);
    return sample;
  }

  disposeSample({ sample_id, action, to_visitor_id = null, staff_id, at }) {
    const sample = this.samples.get(sample_id);
    if (!sample) throw new DomainError('UNKNOWN_SAMPLE', `未知样品：${sample_id}`);
    if (sample.disposition) {
      throw new ConflictError('ALREADY_DISPOSED', `样品 ${sample_id} 已有去向记录，不得重复处置`);
    }
    if (!staff_id) throw new DomainError('STAFF_REQUIRED', '样品去向必须登记经办人');
    if (action === 'handed_out') {
      if (!to_visitor_id) throw new DomainError('RECIPIENT_REQUIRED', '样品发放必须登记领取客户');
      // 领取必须对应客户观看过的设备版本
      const proof = this.#witness(to_visitor_id, sample.session_id);
      sample.disposition = { action, to_visitor_id, staff_id, at, proof };
    } else if (action === 'retained' || action === 'discarded') {
      sample.disposition = { action, staff_id, at };
    } else {
      throw new DomainError('BAD_DISPOSITION', `未知样品去向：${action}`);
    }
    return sample;
  }

  // ---------- 客户同意与商机 ----------

  recordConsent({ visitor_id, exhibitor_id, statement, channel, at }) {
    if (!this.exhibitors.has(exhibitor_id)) {
      throw new DomainError('UNKNOWN_EXHIBITOR', `未知展商：${exhibitor_id}`);
    }
    if (!statement) throw new DomainError('CONSENT_TEXT_REQUIRED', '同意跟进必须留存授权表述');
    const key = `${visitor_id}|${exhibitor_id}`;
    if (this.consents.has(key)) {
      throw new ConflictError('DUPLICATE_CONSENT', `访客 ${visitor_id} 对展商 ${exhibitor_id} 的同意已记录`);
    }
    const record = { visitor_id, exhibitor_id, statement, channel, at };
    this.consents.set(key, record);
    return record;
  }

  #hasConsent(visitorId, exhibitorId) {
    return this.consents.has(`${visitorId}|${exhibitorId}`);
  }

  // 凭证有效：互动所挂场次最终有效完成。冻结未恢复/未完成场次的互动不算数。
  #isValidProof(proof) {
    return this.sessions.get(proof.session_id)?.status === 'completed';
  }

  // 商机 = 客户明确同意跟进 + 有有效观看凭证的互动（问答/报价/样品领取）。
  // 围观扫码只算到场，不产生商机。
  leads() {
    const leads = new Map(); // `${visitor}|${exhibitor}` -> lead
    const ensure = (visitorId, exhibitorId) => {
      const key = `${visitorId}|${exhibitorId}`;
      if (!leads.has(key)) {
        leads.set(key, {
          visitor_id: visitorId,
          exhibitor_id: exhibitorId,
          consent: this.consents.get(key),
          watched: [],
          interactions: [],
        });
      }
      return leads.get(key);
    };
    for (const q of this.qa) {
      const s = this.#session(q.proof.session_id);
      if (!this.#hasConsent(q.visitor_id, s.exhibitor_id)) continue;
      if (!this.#isValidProof(q.proof)) continue;
      const lead = ensure(q.visitor_id, s.exhibitor_id);
      lead.interactions.push({ kind: 'qa', id: q.id, proof: q.proof });
    }
    for (const q of this.quotes) {
      const s = this.#session(q.proof.session_id);
      if (!this.#hasConsent(q.visitor_id, s.exhibitor_id)) continue;
      if (!this.#isValidProof(q.proof)) continue;
      const lead = ensure(q.visitor_id, s.exhibitor_id);
      lead.interactions.push({ kind: 'quote', id: q.id, proof: q.proof });
    }
    for (const sample of this.samples.values()) {
      if (sample.disposition?.action !== 'handed_out') continue;
      const visitorId = sample.disposition.to_visitor_id;
      const s = this.#session(sample.session_id);
      if (!this.#hasConsent(visitorId, s.exhibitor_id)) continue;
      if (!this.#isValidProof(sample.disposition.proof)) continue;
      const lead = ensure(visitorId, s.exhibitor_id);
      lead.interactions.push({ kind: 'sample', id: sample.id, proof: sample.disposition.proof });
    }
    for (const lead of leads.values()) {
      const sessionIds = new Set(lead.interactions.map((i) => i.proof.session_id));
      lead.watched = [...sessionIds].map((id) => {
        const s = this.#session(id);
        const machine = this.#machine(s.machine_id);
        return {
          session_id: id,
          machine_id: s.machine_id,
          machine_model: machine.model,
          inspection_id: s.inspection_id,
          inspection_version: s.inspection_version,
        };
      });
    }
    return [...leads.values()];
  }

  // ---------- 导出授权与审计 ----------

  exportReport({ actor, role, kind, exhibitor_id = null, for_exhibitor_id = null, at }) {
    const target = for_exhibitor_id ?? exhibitor_id;
    let allowed = false;
    let reason = '';
    if (role === 'organizer') {
      allowed = kind !== 'leads';
      reason = allowed ? '' : '主办方不导出展商商机，商机归展商所有';
    } else if (role === 'safety_officer') {
      allowed = kind === 'safety';
      reason = allowed ? '' : '安全员仅可导出安全事件';
    } else if (role === 'exhibitor') {
      allowed = kind === 'leads' && exhibitor_id && target === exhibitor_id;
      reason = allowed ? '' : '展商仅可导出本展位的商机';
    } else {
      reason = `未知角色：${role}`;
    }
    this.auditLog.push({ actor, role, kind, exhibitor_id: target, at, allowed });
    if (!allowed) {
      throw new AuthorizationError('EXPORT_DENIED', `拒绝 ${actor}（${role}）导出 ${kind}：${reason}`);
    }
    switch (kind) {
      case 'safety':
        return { kind, generated_at: at, safety_events: this.incidents };
      case 'demos':
        return { kind, generated_at: at, sessions: [...this.sessions.values()] };
      case 'samples':
        return { kind, generated_at: at, samples: [...this.samples.values()] };
      case 'leads':
        return { kind, generated_at: at, exhibitor_id: target, leads: this.leads().filter((l) => l.exhibitor_id === target) };
      case 'reconciliation':
        return this.reconciliation(at);
      default:
        throw new DomainError('BAD_EXPORT_KIND', `未知导出类型：${kind}`);
    }
  }

  // ---------- 闭展核对 ----------

  reconciliation(at) {
    const sessions = [...this.sessions.values()];
    const validDemos = sessions
      .filter((s) => s.status === 'completed')
      .map((s) => ({
        slot_id: s.slot_id,
        machine_id: s.machine_id,
        window: `${s.start} ~ ${s.end}`,
        operator_id: s.operator_id,
        inspection_id: s.inspection_id,
        inspection_version: s.inspection_version,
        material_batch_id: s.material_batch_id,
        mold_id: s.mold_id,
        resumed_from: s.resumed_from,
        completed_at: s.completed_at,
      }));
    const frozen = sessions
      .filter((s) => s.status === 'frozen')
      .map((s) => ({
        slot_id: s.slot_id,
        machine_id: s.machine_id,
        frozen_at: s.frozen_at,
        frozen_by: s.frozen_by,
        inspection_id: s.inspection_id,
        inspection_version: s.inspection_version,
      }));

    const samples = [...this.samples.values()];
    const sampleDispositions = samples.map((s) => ({
      sample_id: s.id,
      machine_id: s.machine_id,
      inspection_id: s.inspection_id,
      inspection_version: s.inspection_version,
      material_batch_id: s.material_batch_id,
      mold_id: s.mold_id,
      disposition: s.disposition,
      // 已发放样品必须仍能指向一场有效完成的演示，否则领取凭证需复核。
      proof_valid:
        s.disposition?.action !== 'handed_out'
          ? null
          : this.#isValidProof(s.disposition.proof),
    }));
    const undisposed = samples.filter((s) => !s.disposition).map((s) => s.id);
    const disputed_samples = sampleDispositions
      .filter((s) => s.proof_valid === false)
      .map((s) => s.sample_id);

    const leads = this.leads();
    const leadVisitorIds = new Set(leads.map((l) => l.visitor_id));
    const interactedVisitorIds = new Set([
      ...this.qa.map((q) => q.visitor_id),
      ...this.quotes.map((q) => q.visitor_id),
      ...samples.filter((s) => s.disposition?.action === 'handed_out').map((s) => s.disposition.to_visitor_id),
    ]);
    // 围观：扫过码但既未同意跟进、也没有任何有效互动
    const bystanders = [...this.attendance.keys()].filter(
      (v) => !leadVisitorIds.has(v) && !interactedVisitorIds.has(v),
    );

    return {
      generated_at: at,
      safety_events: this.incidents,
      valid_demos: validDemos,
      frozen_sessions: frozen,
      sample_dispositions: sampleDispositions,
      undisposed_samples: undisposed,
      disputed_samples,
      leads,
      bystanders,
      scan_stats: {
        attempts: this.scanAttempts.length,
        unique: [...this.attendance.values()].reduce((n, m) => n + m.size, 0),
        duplicates: this.scanAttempts.length - [...this.attendance.values()].reduce((n, m) => n + m.size, 0),
      },
      export_audit: this.auditLog,
    };
  }
}

export { INCIDENT_TYPES };
