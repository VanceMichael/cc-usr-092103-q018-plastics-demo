// 塑机档案与检查版本。
// 每台塑机保存型号、展位、工艺参数范围、样料批次、模具、操作员资格、风险区域；
// 每次检查生成递增的检查版本，只有通过检查的设备才允许批准演示。
import { assertDomain } from './errors.js';

const MACHINE_REQUIRED_FIELDS = ['id', 'exhibitorId', 'model', 'booth', 'requiredQualification'];

export function createMachineRegistry() {
  const machines = new Map();
  const inspections = new Map();
  let seq = 0;
  const nextId = (prefix) => `${prefix}-${String(++seq).padStart(4, '0')}`;

  function registerMachine(input) {
    for (const field of MACHINE_REQUIRED_FIELDS) {
      assertDomain(input[field], 'MACHINE_FIELD_MISSING', `设备资料缺少字段 ${field}`);
    }
    assertDomain(!machines.has(input.id), 'MACHINE_EXISTS', `设备 ${input.id} 已注册`);
    assertDomain(
      input.parameterRanges && Object.keys(input.parameterRanges).length > 0,
      'PARAM_RANGE_MISSING',
      '设备必须声明工艺参数范围',
    );
    assertDomain(Array.isArray(input.operators) && input.operators.length > 0, 'OPERATOR_MISSING', '设备必须登记操作员');
    assertDomain(Array.isArray(input.riskZones) && input.riskZones.length > 0, 'RISK_ZONE_MISSING', '设备必须登记风险区域');

    const machine = {
      ...input,
      materialBatches: input.materialBatches ?? [],
      molds: input.molds ?? [],
      // needs-inspection：待检查；ready：可演示；frozen：安全事件冻结中
      status: 'needs-inspection',
      currentVersion: 0,
      currentInspectionId: null,
      inspectionCount: 0,
      changeovers: [],
    };
    machines.set(machine.id, machine);
    return machine;
  }

  function getMachine(machineId) {
    const machine = machines.get(machineId);
    assertDomain(machine, 'MACHINE_UNKNOWN', `未注册的设备 ${machineId}`);
    return machine;
  }

  function getInspection(inspectionId) {
    const inspection = inspections.get(inspectionId);
    assertDomain(inspection, 'INSPECTION_UNKNOWN', `不存在的检查记录 ${inspectionId}`);
    return inspection;
  }

  // 每次检查（无论通过与否）都占用一个新版本号；只有通过才更新设备当前版本。
  function recordInspection({ machineId, inspectorId, result, checkedItems = [], at, note }) {
    const machine = getMachine(machineId);
    assertDomain(inspectorId, 'INSPECTOR_MISSING', '检查必须记录检查人');
    assertDomain(result === 'passed' || result === 'failed', 'INSPECTION_RESULT_INVALID', '检查结果只能是 passed 或 failed');
    assertDomain(at, 'INSPECTION_TIME_MISSING', '检查必须记录时间');

    const version = machine.inspectionCount + 1;
    const inspection = {
      id: nextId('INS'),
      machineId,
      version,
      result,
      checkedItems,
      inspectorId,
      at,
      note: note ?? '',
    };
    inspections.set(inspection.id, inspection);
    machine.inspectionCount = version;
    if (result === 'passed') {
      machine.currentVersion = version;
      machine.currentInspectionId = inspection.id;
      machine.status = 'ready';
    } else if (machine.status !== 'frozen') {
      machine.status = 'needs-inspection';
    }
    return inspection;
  }

  // 换料换模：更新样料批次与模具，设备回到待检查状态，
  // 由组合层负责取消受影响的已批准场次，恢复演示必须重新检查。
  function applyChangeover({ machineId, at, by, addMaterialBatches = [], removeMaterialBatchIds = [], addMolds = [], removeMoldIds = [] }) {
    const machine = getMachine(machineId);
    assertDomain(machine.status !== 'frozen', 'MACHINE_FROZEN', '安全事件未解除，禁止换料换模');
    assertDomain(by, 'CHANGEOVER_OPERATOR_MISSING', '换料换模必须记录执行人');
    assertDomain(at, 'CHANGEOVER_TIME_MISSING', '换料换模必须记录时间');

    for (const batchId of removeMaterialBatchIds) {
      assertDomain(
        machine.materialBatches.some((batch) => batch.id === batchId),
        'BATCH_UNKNOWN',
        `设备 ${machineId} 没有样料批次 ${batchId}`,
      );
    }
    for (const moldId of removeMoldIds) {
      assertDomain(
        machine.molds.some((mold) => mold.id === moldId),
        'MOLD_UNKNOWN',
        `设备 ${machineId} 没有模具 ${moldId}`,
      );
    }

    machine.materialBatches = machine.materialBatches.filter((batch) => !removeMaterialBatchIds.includes(batch.id));
    machine.molds = machine.molds.filter((mold) => !removeMoldIds.includes(mold.id));
    machine.materialBatches.push(...addMaterialBatches);
    machine.molds.push(...addMolds);
    machine.status = 'needs-inspection';

    const record = {
      id: nextId('CHG'),
      machineId,
      at,
      by,
      addMaterialBatches,
      removeMaterialBatchIds,
      addMolds,
      removeMoldIds,
    };
    machine.changeovers.push(record);
    return record;
  }

  function operatorQualified(machine, operatorId, at) {
    const operator = machine.operators.find((item) => item.id === operatorId);
    if (!operator) return false;
    return operator.qualifications.some(
      (qualification) => qualification.type === machine.requiredQualification && Date.parse(qualification.expiresAt) >= Date.parse(at),
    );
  }

  return {
    registerMachine,
    getMachine,
    getInspection,
    recordInspection,
    applyChangeover,
    operatorQualified,
    listMachines: () => [...machines.values()],
    listInspections: (machineId) => [...inspections.values()].filter((item) => !machineId || item.machineId === machineId),
  };
}
