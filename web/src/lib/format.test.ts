import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, cleanCode, isValidCode, newClientId, parseAmount, price, qty, signed, usd, usdWhole } from './format.ts'

test('usd and usdWhole format and never overstate headroom', () => {
  assert.equal(usd(1234.5), '$1,234.50')
  assert.equal(usd(-3.2), '-$3.20')
  assert.equal(usd(null), '--')
  assert.equal(usdWhole(412.9), '$412')
  assert.equal(usdWhole(-5), '$0')
  assert.equal(usdWhole(NaN), '--')
  assert.equal(signed(5), '+$5.00')
  assert.equal(signed(-5), '-$5.00')
})

test('price and qty use sensible precision', () => {
  assert.equal(price(61052.1), '61,052.10')
  assert.equal(price(72.388), '72.388')
  assert.equal(qty(0.25, 0.0001), '0.2500')
  assert.equal(qty(100, 10), '100')
})

test('cleanCode keeps up to six digits from pasted text', () => {
  assert.equal(cleanCode('123 456'), '123456')
  assert.equal(cleanCode('12-34-56-78'), '123456')
  assert.equal(cleanCode('abc'), '')
  assert.ok(isValidCode('123456'))
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 3456']) assert.ok(!isValidCode(bad))
})

test('parseAmount accepts plain numbers and rejects junk', () => {
  assert.equal(parseAmount('500'), 500)
  assert.equal(parseAmount('$1,200.50'), 1200.5)
  for (const bad of ['', 'abc', '-5', '1e3', '5 5x', '1.2.3', '0x10']) assert.equal(parseAmount(bad), null, bad)
})

test('ago and newClientId', () => {
  assert.equal(ago(4000), '4s ago')
  assert.equal(ago(125_000), '2m ago')
  assert.equal(ago(7_300_000), '2h ago')
  const a = newClientId()
  assert.match(a, /^[0-9a-f]{24}$/)
  assert.notEqual(a, newClientId())
})
