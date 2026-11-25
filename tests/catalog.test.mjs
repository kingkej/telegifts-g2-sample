import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPrice, rankCollections } from '../src/catalog.ts'

test('orders browse cards by floor and retains the lowest eligible quote and its marketplace', () => {
  const collections = rankCollections({ collection_floors: {
    'Heart Locket': { portals: 200 },
    'Plush Pepe': { mrkt: '42.5', portals: 50, tonnel: 0, fragment: -3, last_update: '2026-11-19T12:00:00Z' },
  } })
  assert.deepEqual(collections.map(item => item.name), ['Heart Locket', 'Plush Pepe'])
  const collection = collections[1]
  assert.deepEqual(collection.quotes, [{ marketplace: 'MRKT', price: 42.5 }, { marketplace: 'Portals', price: 50 }])
  assert.deepEqual(collection.floor, collection.quotes[0])
  assert.equal(collection.updatedAt, '2026-11-19T12:00:00Z')
})

test('falls back by floor descending and skips Getgems-only rows as Explore does', () => {
  const collections = rankCollections({ collection_floors: {
    'Plush Pepe': { getgems: 500 },
    'Toy Bear': { mrkt: 10 },
    'Heart Locket': { getgems: 11, portals: 20 },
  } })
  assert.deepEqual(collections.map(item => item.name), ['Heart Locket', 'Toy Bear'])
  assert.deepEqual(collections[0].floor, { marketplace: 'Getgems', price: 11 })
})

test('an empty catalog differs from a malformed response, and tiny floors never display as zero', () => {
  assert.deepEqual(rankCollections({ collection_floors: { A: { portals: null, tonnel: 'unavailable' } } }), [])
  assert.throws(() => rankCollections({ error: 'unavailable' }), /Invalid collection/)
  assert.equal(formatPrice(0.001), '<0.01 GRAM')
  assert.equal(formatPrice(1042.5), '1,042.5 GRAM')
})
