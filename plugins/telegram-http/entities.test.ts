import { describe, expect, test } from 'bun:test'
import { expandHiddenEntities } from './entities.ts'

describe('expandHiddenEntities', () => {
  test('no entities → unchanged', () => {
    expect(expandHiddenEntities('hello world')).toBe('hello world')
    expect(expandHiddenEntities('hello world', [])).toBe('hello world')
  })

  test('single text_link expands inline', () => {
    expect(
      expandHiddenEntities('see the doc here', [
        { type: 'text_link', offset: 8, length: 8, url: 'https://md.blocktempo.ai/x' },
      ]),
    ).toBe('see the [doc here](https://md.blocktempo.ai/x)')
  })

  test('multiple links — the Joey document-list case', () => {
    // "PROPOSAL_給Joey.md\nRUNBOOK.md" with each filename carrying a hidden URL
    const text = 'PROPOSAL_給Joey.md\nRUNBOOK.md'
    const out = expandHiddenEntities(text, [
      { type: 'text_link', offset: 0, length: 17, url: 'https://md.blocktempo.ai/p1' },
      { type: 'text_link', offset: 18, length: 10, url: 'https://md.blocktempo.ai/p2' },
    ])
    expect(out).toBe(
      '[PROPOSAL_給Joey.md](https://md.blocktempo.ai/p1)\n[RUNBOOK.md](https://md.blocktempo.ai/p2)',
    )
  })

  test('adjacent links, no separator', () => {
    expect(
      expandHiddenEntities('ab', [
        { type: 'text_link', offset: 0, length: 1, url: 'https://a.example' },
        { type: 'text_link', offset: 1, length: 1, url: 'https://b.example' },
      ]),
    ).toBe('[a](https://a.example)[b](https://b.example)')
  })

  test('emoji (astral, 2 UTF-16 units each) before the link — offsets stay correct', () => {
    // '🚀🚀 doc' → 🚀=2 units, so 'doc' starts at UTF-16 offset 5
    expect(
      expandHiddenEntities('🚀🚀 doc', [{ type: 'text_link', offset: 5, length: 3, url: 'https://e.example' }]),
    ).toBe('🚀🚀 [doc](https://e.example)')
  })

  test('url-type entity (visible URL) untouched', () => {
    const text = 'go to https://example.com now'
    expect(expandHiddenEntities(text, [{ type: 'url', offset: 6, length: 19 }])).toBe(text)
  })

  test('bold/mention/other formatting entities untouched', () => {
    const text = 'hello @someone bold'
    expect(
      expandHiddenEntities(text, [
        { type: 'mention', offset: 6, length: 8 },
        { type: 'bold', offset: 15, length: 4 },
      ]),
    ).toBe(text)
  })

  test('text_mention (hidden user id) expands', () => {
    expect(
      expandHiddenEntities('ask Joey', [{ type: 'text_mention', offset: 4, length: 4, user: { id: 1828173984 } }]),
    ).toBe('ask [Joey](tg://user?id=1828173984)')
  })

  test('label identical to url stays plain', () => {
    const text = 'https://example.com'
    expect(
      expandHiddenEntities(text, [{ type: 'text_link', offset: 0, length: 19, url: 'https://example.com' }]),
    ).toBe(text)
  })

  test('overlapping entities — first wins, no crash', () => {
    expect(
      expandHiddenEntities('abcdef', [
        { type: 'text_link', offset: 0, length: 4, url: 'https://x.example' },
        { type: 'text_link', offset: 2, length: 4, url: 'https://y.example' },
      ]),
    ).toBe('[abcd](https://x.example)ef')
  })

  test('malformed out-of-range offsets are skipped', () => {
    expect(
      expandHiddenEntities('short', [{ type: 'text_link', offset: 3, length: 99, url: 'https://x.example' }]),
    ).toBe('short')
  })

  test('CJK text with link (BMP chars, 1 unit each)', () => {
    expect(
      expandHiddenEntities('看這份文件謝謝', [{ type: 'text_link', offset: 1, length: 4, url: 'https://d.example' }]),
    ).toBe('看[這份文件](https://d.example)謝謝')
  })

  test('unsorted entity array is handled', () => {
    expect(
      expandHiddenEntities('a b c', [
        { type: 'text_link', offset: 4, length: 1, url: 'https://c.example' },
        { type: 'text_link', offset: 0, length: 1, url: 'https://a.example' },
      ]),
    ).toBe('[a](https://a.example) b [c](https://c.example)')
  })
})
