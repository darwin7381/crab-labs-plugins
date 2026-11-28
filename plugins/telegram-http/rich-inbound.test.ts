// Hestia #9758 (2026-11-17): a Message with `rich_message` and no text was dropped (kind=other). Its blocks as markdown, and through a real daemon:
// the rich message reaches the session as text; a reply to a rich message carries reply_to_text.
import { test, expect } from 'bun:test'
import { richToMarkdown, richText } from './rich-inbound.ts'

const DOC = { blocks: [
  { type: 'heading', text: '需求', size: 2 },
  { type: 'paragraph', text: ['先做 ', { type: 'bold', text: '登入' }, '，再做 ', { type: 'code', text: 'export' }, '；文件在 ', { type: 'url', text: '這裡', url: 'https://example.com/a' }] },
  { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text: '第一點' }] }, { label: '•', blocks: [{ type: 'paragraph', text: '第二點' }, { type: 'pre', text: 'a = 1', language: 'py' }] }] },
  { type: 'list', items: [{ label: '1.', blocks: [{ type: 'paragraph', text: '甲' }] }, { label: '', has_checkbox: true, is_checked: true, blocks: [{ type: 'paragraph', text: '做完的' }] }] },
  { type: 'table', cells: [[{ text: '名稱', is_header: true }, { text: '值', is_header: true }], [{ text: 'a|b' }, { text: ['1', { type: 'italic', text: '2' }] }]] },
  { type: 'blockquote', blocks: [{ type: 'paragraph', text: '引用的話' }], credit: '某人' },
  { type: 'divider' },
  { type: 'photo', photo: [{ file_id: 'small' }, { file_id: 'BIG' }], caption: { text: '一張圖' } },
  { type: 'thinking', text: '不該出現' },
  { type: 'hologram', text: '未來的型別' },
] }

test('blocks flatten to markdown; an unknown block type is named, a thinking block is not content', () => {
  const md = richToMarkdown(DOC)
  expect(md).toContain('## 需求')
  expect(md).toContain('先做 **登入**，再做 `export`；文件在 [這裡](https://example.com/a)')
  expect(md).toContain('- 第一點\n- 第二點\n\n  ```py\n  a = 1\n  ```')
  expect(md).toContain('1. 甲\n- [x] 做完的')
  expect(md).toContain('| 名稱 | 值 |\n| --- | --- |\n| a\\|b | 1*2* |')
  expect(md).toContain('> 引用的話\n> — 某人')
  expect(md).toContain('---')
  expect(md).toContain('（照片 file_id=BIG） 一張圖')
  expect(md).not.toContain('不該出現')
  expect(md).toContain('（無法顯示的區塊類型：hologram）')
  expect(richToMarkdown({ blocks: [] })).toBe('')
  expect(richToMarkdown(undefined)).toBe('')
  expect(richText({ type: 'url', text: 'https://x.y', url: 'https://x.y' })).toBe('https://x.y')
  expect(richText({ type: 'spoiler', text: ['a', { type: 'underline', text: 'b' }] })).toBe('ab')
})
