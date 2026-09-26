// 演示脚本：装载样例资料、回放一天现场事件，然后以主办方身份导出闭展核对报告。
// 运行：npm run report
import { createBackoffice } from './index.js';
import { loadExpo, replayEvents, loadFixture } from './seed.js';

const backoffice = createBackoffice();
loadExpo(backoffice, await loadFixture('expo.json'));
replayEvents(backoffice, await loadFixture('onsite-events.json'));

const report = backoffice.exportReport({ requesterId: 'ORG-01', role: 'organizer', at: '2026-09-26T18:00:00Z' });
console.log(JSON.stringify(report, null, 2));
