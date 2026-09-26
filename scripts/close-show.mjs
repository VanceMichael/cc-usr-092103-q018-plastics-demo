#!/usr/bin/env node
// 闭展核对：回放现场事件脚本，输出安全事件、有效演示、样品去向、商机线索，
// 以及被拒绝的越权/违规操作清单。
//
// 用法：node scripts/close-show.mjs [fixtures/exhibition.json]

import { readFile } from 'node:fs/promises';
import { replay } from '../src/handover/replay.js';

function line(ch = '-', n = 64) {
  return ch.repeat(n);
}

function print(title) {
  console.log(`\n${line()}\n${title}\n${line()}`);
}

const fixturePath = process.argv[2] ?? new URL('../fixtures/exhibition.json', import.meta.url);
const raw = await readFile(fixturePath, 'utf8');
const data = JSON.parse(raw);
const { report, rejections } = replay(data);

console.log(`闭展核对报告 —— ${data.show?.name ?? data.domain}`);
console.log(`生成时间：${report.generated_at}`);

print('一、安全事件（含冻结范围与恢复依据）');
if (report.safety_events.length === 0) {
  console.log('（无）');
}
for (const inc of report.safety_events) {
  console.log(
    `- [${inc.id}] ${inc.at} 设备 ${inc.machine_id} ${inc.type}\n  ${inc.detail}\n  冻结场次：${inc.affected_sessions.join('、') || '（无进行中场次）'}`,
  );
}
for (const s of report.frozen_sessions) {
  console.log(`- 未恢复冻结：场次 ${s.slot_id}（设备 ${s.machine_id}，${s.frozen_at} 由 ${s.frozen_by} 冻结，旧检查 ${s.inspection_id} v${s.inspection_version} 已失效）`);
}

print('二、有效演示（场次 + 客户实际观看的设备检查版本）');
for (const d of report.valid_demos) {
  const tail = d.resumed_from ? `，由 ${d.resumed_from} 冻结后恢复` : '';
  console.log(
    `- ${d.slot_id} 设备 ${d.machine_id} ${d.window} 操作员 ${d.operator_id}\n  样料 ${d.material_batch_id} / 模具 ${d.mold_id} / 检查 ${d.inspection_id} v${d.inspection_version}${tail}`,
  );
}

print('三、样品去向');
for (const s of report.sample_dispositions) {
  const d = s.disposition;
  const where = d
    ? d.action === 'handed_out'
      ? `已发放给 ${d.to_visitor_id}（经办 ${d.staff_id}），凭证检查版本 v${d.proof.inspection_version}`
      : `${d.action === 'retained' ? '展位留存' : '废弃'}（经办 ${d.staff_id}）`
    : '【缺去向】';
  console.log(`- ${s.sample_id} 设备 ${s.machine_id} 批次 ${s.material_batch_id} 检查 v${s.inspection_version}：${where}`);
}
if (report.undisposed_samples.length > 0) {
  console.log(`  待补登记：${report.undisposed_samples.join('、')}`);
}

print('四、经客户同意的跟进对象（商机）');
for (const lead of report.leads) {
  console.log(
    `- 客户 ${lead.visitor_id} -> 展商 ${lead.exhibitor_id}（${lead.consent.channel}，${lead.consent.at}）\n  授权表述：${lead.consent.statement}\n  互动 ${lead.interactions.length} 条，观看版本：${lead.watched
      .map((w) => `${w.machine_model}=${w.inspection_id} v${w.inspection_version}`)
      .join('；')}`,
  );
}
console.log(`- 围观未转商机客户：${report.bystanders.length === 0 ? '（无）' : report.bystanders.join('、')}`);

print('五、扫码与导出审计');
console.log(`扫码尝试 ${report.scan_stats.attempts} 次，唯一有效 ${report.scan_stats.unique} 次，重复拦截 ${report.scan_stats.duplicates} 次`);
for (const a of report.export_audit) {
  console.log(`- ${a.at} ${a.actor}（${a.role}）导出 ${a.kind}${a.exhibitor_id ? ` / ${a.exhibitor_id}` : ''}：${a.allowed ? '允许' : '拒绝'}`);
}

print('六、被系统拒绝的操作（按时间）');
for (const r of rejections) {
  console.log(`- ${r.at} ${r.type} [${r.code}] ${r.message}`);
}

console.log(`\n汇总：安全事件 ${report.safety_events.length} 起，有效演示 ${report.valid_demos.length} 场，样品 ${report.sample_dispositions.length} 件，商机 ${report.leads.length} 条，拒绝操作 ${rejections.length} 条。`);
