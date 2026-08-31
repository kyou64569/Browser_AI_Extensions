// test/prompt-templates.test.mjs
// Prompt 模板库（shared/prompt-templates.js）的回归测试。
// 插值逻辑直接决定发给模型的最终 prompt，错吞内容 / 错丢变量的代价是整轮对话报废。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTemplate, listTemplateVars, cloneTemplate, validateTemplate,
  BUILTIN_TEMPLATES, TEMPLATE_VARS,
} from '../shared/prompt-templates.js';

test('applyTemplate: 基本变量替换', () => {
  const r = applyTemplate('总结 {{page_title}}：{{input}}', { page_title: '新闻页', input: '正文…' });
  assert.equal(r.text, '总结 新闻页：正文…');
  assert.deepEqual(r.usedVars, ['page_title', 'input']);
});

test('applyTemplate: 未知变量原样保留（不吞内容）', () => {
  const r = applyTemplate('A {{nope}} B {{input}}', { input: 'x' });
  assert.equal(r.text, 'A {{nope}} B x');
  assert.deepEqual(r.usedVars, ['input']);
});

test('applyTemplate: 值为 null/undefined 替换为空串', () => {
  const r = applyTemplate('[{{selection}}]尾', { selection: null });
  assert.equal(r.text, '[]尾');
  const r2 = applyTemplate('[{{selection}}]尾', { selection: undefined });
  assert.equal(r2.text, '[]尾');
});

test('applyTemplate: 大小写敏感，{{DATE}} 不是变量', () => {
  const r = applyTemplate('{{date}} {{DATE}}', { date: '2026/08/31' });
  assert.equal(r.text, '2026/08/31 {{DATE}}');
});

test('applyTemplate: 同一变量多次出现只记一次 usedVars', () => {
  const r = applyTemplate('{{input}}\n{{input}}', { input: 'a' });
  assert.equal(r.text, 'a\na');
  assert.deepEqual(r.usedVars, ['input']);
});

test('applyTemplate: 空输入健壮', () => {
  assert.deepEqual(applyTemplate(''), { text: '', usedVars: [] });
  assert.deepEqual(applyTemplate(null), { text: '', usedVars: [] });
});

test('listTemplateVars: 列出模板引用的已知变量（去重、按出现顺序）', () => {
  assert.deepEqual(listTemplateVars('{{selection}} 和 {{input}} 和 {{selection}}'), ['selection', 'input']);
  assert.deepEqual(listTemplateVars('无变量'), []);
  assert.deepEqual(listTemplateVars('{{unknown_var}}'), []);
});

test('BUILTIN_TEMPLATES: 内置模板合法且 id 唯一、变量均为已知', () => {
  const ids = new Set();
  for (const t of BUILTIN_TEMPLATES) {
    assert.ok(!ids.has(t.id), '重复 id: ' + t.id);
    ids.add(t.id);
    assert.ok(validateTemplate(t).length === 0, '非法模板: ' + t.name);
    for (const v of listTemplateVars(t.content)) {
      assert.ok(v in TEMPLATE_VARS, '未知变量 ' + v);
    }
  }
});

test('cloneTemplate: 生成可编辑副本（新 id、builtin=false、名称带副本后缀）', () => {
  const copy = cloneTemplate(BUILTIN_TEMPLATES[0]);
  assert.notEqual(copy.id, BUILTIN_TEMPLATES[0].id);
  assert.equal(copy.builtin, false);
  assert.ok(copy.name.includes('副本'));
  assert.equal(copy.content, BUILTIN_TEMPLATES[0].content);
});

test('validateTemplate: 名称/内容为空或超长时报错', () => {
  assert.deepEqual(validateTemplate({ name: 'a', content: 'b' }), []);
  assert.ok(validateTemplate({ name: '', content: 'b' }).length > 0);
  assert.ok(validateTemplate({ name: 'a', content: ' ' }).length > 0);
  assert.ok(validateTemplate({ name: 'x'.repeat(41), content: 'b' }).length > 0);
  assert.ok(validateTemplate(null).length > 0);
});
