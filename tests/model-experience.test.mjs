import test from 'node:test';
import assert from 'node:assert/strict';
import { answerLabel } from '../public/experience.js';

test('old extractive history is not falsely labeled as unavailable model', () => {
  assert.ok(!answerLabel('extractive').includes('模型暂不可用'));
});

test('new fallback shows safe reason and actual generating model', () => {
  const label = answerLabel('extractive_fallback', {
    fallbackReason: '模型输出达到长度上限，未完成回答',
    modelName: 'Qwen3.5-0.8B-office.Q8_0',
  });
  assert.ok(label.includes('长度上限'));
  assert.ok(label.includes('0.8B'));
});
