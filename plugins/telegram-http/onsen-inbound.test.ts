import { expect, test } from 'bun:test'
import { clientMetaOf, applyClientMeta, CLIENT_META_FIXED, TG_OWN_FILE_NAME } from './onsen-inbound.ts'

test('WO-197: client.meta → tag attributes: every key as is (no key named here); other JSON values as their text; not an attribute name: left out', () => {
  expect(clientMetaOf({ meta: { a: '1', b: 'x y', reply_to_user_id: '42', n: 3, o: { k: 1 } } })).toEqual({ a: '1', b: 'x y', reply_to_user_id: '42', n: '3', o: '{"k":1}' })
  for (const c of [null, {}, { meta: null }, { meta: [] }, { meta: {} }, { meta: { '1x': 'a', 'a-b': 'b', z: null } }]) expect(clientMetaOf(c)).toBe(null)
})

test('WO-197 rule A (Chiron 16:1xZ): client.meta over the tag\'s own values, a new key last; the fixed list (chat_id, message_id, ts, source, topic, user_id) never', () => {
  const meta: Record<string, string> = { chat_id: '1828', message_id: '5', user: 'joey', user_id: '1828', ts: 'T', topic: '3', reply_to_user: 'joey-test', reply_to_text: 'x' }
  applyClientMeta(meta, { reply_to_user: 'awesometon5', chat_id: '9', message_id: '9', ts: 'U', source: 's', topic: '9', user_id: '9', forward_origin: 'user' })
  expect(meta).toEqual({ chat_id: '1828', message_id: '5', user: 'joey', user_id: '1828', ts: 'T', topic: '3', reply_to_user: 'awesometon5', reply_to_text: 'x', forward_origin: 'user' })
  expect(Object.keys(meta).at(-1)).toBe('forward_origin')
  expect([...CLIENT_META_FIXED].sort()).toEqual(['chat_id', 'message_id', 'source', 'topic', 'ts', 'user_id'])
  applyClientMeta(meta, null); applyClientMeta(meta, undefined)
  expect(meta.reply_to_user).toBe('awesometon5')
  // a local image path is never taken from client.meta (the agent Reads it), nor added
  const img: Record<string, string> = { chat_id: '1', image_path: '/home/x/.telegram-state/inbox/a.jpg' }
  applyClientMeta(img, { image_path: '/etc/passwd', image_path_2: '/etc/shadow', image_pathx: 'kept' })
  expect(img).toEqual({ chat_id: '1', image_path: '/home/x/.telegram-state/inbox/a.jpg', image_pathx: 'kept' })
})

test('WO-197 (lab 1007): Telegram\'s own file name (a nameless file\'s, the file path\'s last part) is told from a name the person gave', () => {
  for (const n of ['file_7.oga', 'file_9.mp4', 'file_12', 'file_0.jpg']) expect(TG_OWN_FILE_NAME.test(n)).toBe(true)
  for (const n of ['r.pdf', 'song.mp3', 'file_7.oga.pdf', 'my file_7.oga', 'file_x.oga', '👍']) expect(TG_OWN_FILE_NAME.test(n)).toBe(false)
})
