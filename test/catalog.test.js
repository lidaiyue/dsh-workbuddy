import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseCreditMultiplier, parseUpstreamModel, selectCliModels } from '../lib/catalog.js'

function upstream(overrides = {}) {
  return {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 64_000,
    credits: 'x0.69',
    supportsImages: true,
    descriptionZh: '中文描述',
    reasoning: { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    ...overrides,
  }
}

test('parseCreditMultiplier reads the upstream rate string', () => {
  assert.equal(parseCreditMultiplier('x0.69'), 0.69)
  assert.equal(parseCreditMultiplier('x 1.62 credits'), 1.62)
  assert.equal(parseCreditMultiplier('x0.00'), 0)
  assert.equal(parseCreditMultiplier('free'), undefined)
  assert.equal(parseCreditMultiplier(undefined), undefined)
})

test('parseUpstreamModel keeps windows, rate, reasoning and description', () => {
  const model = parseUpstreamModel(upstream())
  assert.equal(model.id, 'glm-5.3')
  assert.equal(model.contextWindow, 1_000_000)
  assert.equal(model.maxTokens, 64_000)
  assert.equal(model.creditMultiplier, 0.69)
  assert.equal(model.supportsImages, true)
  assert.deepEqual(model.reasoning, { supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high' })
  assert.equal(model.description, '中文描述')
})

test('parseUpstreamModel drops unusable rows', () => {
  assert.equal(parseUpstreamModel(upstream({ disabled: true })), undefined)
  assert.equal(parseUpstreamModel(upstream({ maxInputTokens: 0 })), undefined)
  assert.equal(parseUpstreamModel(upstream({ maxOutputTokens: 0 })), undefined)
  assert.equal(parseUpstreamModel(null), undefined)
})

test('parseUpstreamModel folds the singular reasoning effort into a default', () => {
  const model = parseUpstreamModel(upstream({ reasoning: { effort: 'high', summary: 'auto' } }))
  assert.deepEqual(model.reasoning, { effort: 'high' })
})

test('parseUpstreamModel honours disabledMultimodal as a veto', () => {
  const model = parseUpstreamModel(upstream({ supportsImages: true, disabledMultimodal: true }))
  assert.equal(model.supportsImages, false)
})

test('selectCliModels keeps the cli roster order and drops routers', () => {
  const models = [
    upstream({ id: 'auto', name: 'Auto', credits: undefined }),
    upstream({ id: 'glm-5.3' }),
    upstream({ id: 'kimi-k3', name: 'Kimi-K3', maxInputTokens: 256_000 }),
    upstream({ id: 'hidden', disabled: true }),
  ]
  const selected = selectCliModels(models, [{ name: 'cli', models: ['auto', 'kimi-k3', 'glm-5.3'] }])
  assert.deepEqual(selected.map(model => model.id), ['kimi-k3', 'glm-5.3'])
})

test('selectCliModels removes repeated roster IDs without merging different models', () => {
  const models = [upstream({ id: 'hy4flash-free', name: 'Hy4 flash', credits: 'x0.00' })]
  const selected = selectCliModels(models, [{ name: 'cli', models: ['hy4flash-free', 'hy4flash-free'] }])
  assert.deepEqual(selected.map(model => model.id), ['hy4flash-free'])
})

test('selectCliModels falls back to the whole document without a cli roster', () => {
  const selected = selectCliModels([upstream({ id: 'a' }), upstream({ id: 'b' })], [])
  assert.deepEqual(selected.map(model => model.id), ['a', 'b'])
})

test('selectCliModels throws instead of disarming the provider silently', () => {
  assert.throws(() => selectCliModels([upstream({ id: 'auto' })], [{ name: 'cli', models: ['auto'] }]), /empty list/u)
  assert.throws(() => selectCliModels([], []), /empty list/u)
})
