// test/workflow.test.mjs
// 工作流引擎跳过传播的回归测试。
// 修复的问题：上游失败 → 下游被跳过时未写入 ctx.errors，导致隔级节点
// （下下游）不判跳过、拿原始 ctx.input 照常执行；失败即 break 连累
// 拓扑序靠后但无依赖关系的并行分支（停留 pending、无进度事件）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowEngine } from '../features/workflow.js';

function makeEngine() {
  const e = new WorkflowEngine();
  e.registerNode('ok', async (input) => ({ echoed: input, ok: true }));
  e.registerNode('boom', async () => { throw new Error('explode'); });
  return e;
}

test('上游失败 → 直接下游与隔级节点都级联跳过，不再拿原始输入执行', async () => {
  const engine = makeEngine();
  const statuses = [];
  const ctx = await engine.run({
    nodes: [
      { id: 'a', type: 'boom', config: {} },
      { id: 'b', type: 'ok', config: {} },
      { id: 'c', type: 'ok', config: {} }, // 只依赖 b（拓扑序在 b 后），b 跳过后必须跳过
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  }, 'RAW_INPUT', (ev) => statuses.push(ev.nodeId + ':' + ev.status));

  assert.equal(ctx.results.has('b'), false, 'b 应被跳过而非拿 RAW_INPUT 执行');
  assert.equal(ctx.results.has('c'), false, 'c（隔级）必须级联跳过——旧实现会拿 RAW_INPUT 执行');
  assert.ok(ctx.errors.has('b'), '跳过节点必须写入 ctx.errors 才能级联');
  assert.ok(statuses.includes('c:skipped'), 'c 必须收到 skipped 事件（旧实现停留 pending），实际：' + statuses);
});

test('失败节点之后的无依赖并行分支照常执行（不再被 break 连累）', async () => {
  const engine = makeEngine();
  const statuses = [];
  const ctx = await engine.run({
    nodes: [
      { id: 'bad', type: 'boom', config: {} },
      { id: 'independent', type: 'ok', config: {} }, // 拓扑序在 bad 后，但无依赖关系
    ],
    edges: [], // 两个根节点互不依赖
  }, 'RAW', (ev) => statuses.push(ev.nodeId + ':' + ev.status));

  assert.ok(ctx.results.has('independent'), '无依赖分支不应被失败节点 break 连累');
  assert.ok(statuses.includes('independent:done'), '实际：' + statuses);
});

test('continueOnError 的失败上游不阻断其下游', async () => {
  const engine = makeEngine();
  const ctx = await engine.run({
    nodes: [
      { id: 'a', type: 'boom', config: {}, continueOnError: true },
      { id: 'b', type: 'ok', config: {} },
    ],
    edges: [{ from: 'a', to: 'b' }],
  }, 'RAW');
  assert.ok(ctx.results.has('b'), 'continueOnError 时下游应照常执行');
});

test('重复节点 id 在入口被拒绝（旧实现 nodeMap 静默覆盖）', async () => {
  const engine = makeEngine();
  await assert.rejects(
    engine.run({
      nodes: [
        { id: 'dup', type: 'ok', config: {} },
        { id: 'dup', type: 'boom', config: {} },
      ],
      edges: [],
    }, 'RAW'),
    /重复的节点 id/,
  );
});
