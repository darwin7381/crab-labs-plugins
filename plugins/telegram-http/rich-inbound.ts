// A Telegram rich message (Bot API `Message.rich_message`: RichMessage → blocks: RichBlock[], each with RichText) as markdown text.
//
// 2026-11-17 (Hestia, mail #9758): Joey sent an agent a formatted paste (about 3,000 characters). The Message carried `rich_message` and no
// `text` / `caption`, matched no handler, and was dropped with one `kind=other` log line; he waited an hour and asked 「到底有沒有看到？？」.
// Every rich reply a bot sends (sendRichMessage) is such a message too: forwarded to another agent it was dropped the same way, and a reply to
// one arrived with no reply_to_text. The types below are the official ones (core.telegram.org/bots/api, RichText* / RichBlock*, read 2026-11-23).
// A type this file does not know is named in the output, never skipped silently.

type Any = any

/** RichText: a string, an array of RichText, or a typed object */
export function richText(t: Any): string {
  if (t == null) return ''
  if (typeof t === 'string') return t
  if (Array.isArray(t)) return t.map(richText).join('')
  if (typeof t !== 'object') return String(t)
  const inner = richText(t.text)
  switch (String(t.type ?? '')) {
    case 'bold': return inner ? `**${inner}**` : ''
    case 'italic': return inner ? `*${inner}*` : ''
    case 'strikethrough': return inner ? `~~${inner}~~` : ''
    case 'code': return inner ? `\`${inner}\`` : ''
    case 'url': return t.url && t.url !== inner ? `[${inner || t.url}](${t.url})` : (inner || String(t.url ?? ''))
    case 'email_address': return inner || String(t.email_address ?? '')
    case 'phone_number': return inner || String(t.phone_number ?? '')
    case 'bank_card_number': return inner || String(t.bank_card_number ?? '')
    case 'ton_address': return inner || String(t.address ?? '')
    case 'mention': return inner || (t.username ? `@${t.username}` : '')
    case 'hashtag': return inner || (t.hashtag ? `#${t.hashtag}` : '')
    case 'cashtag': return inner || (t.cashtag ? `$${t.cashtag}` : '')
    case 'bot_command': return inner || String(t.bot_command ?? '')
    case 'custom_emoji': return String(t.alternative_text ?? '')
    case 'mathematical_expression': return t.expression ? `$${t.expression}$` : ''
    case 'button': return `[按鈕：${richText(t.button?.text) || '(無文字)'}]`
    case 'anchor': return ''
    // underline, spoiler, date_time, text_mention, subscript, superscript, marked, anchor_link, reference, reference_link: their text
    default: return inner
  }
}

const caption = (c: Any): string => {
  if (!c) return ''
  const t = richText(c.text ?? c), credit = richText(c.credit)
  return [t, credit ? `（${credit}）` : ''].filter(Boolean).join(' ')
}
const quote = (s: string): string => s.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')
const indent = (s: string, pad: string): string => s.split('\n').map((l, i) => (i === 0 || !l ? l : pad + l)).join('\n')
const media = (label: string, fileId: Any, c: Any): string => `（${label}${fileId ? ` file_id=${fileId}` : ''}）${caption(c) ? ` ${caption(c)}` : ''}`

function listItem(it: Any): string {
  const body = blocks(it?.blocks ?? [])
  const raw = String(it?.label ?? '').trim()
  const label = it?.has_checkbox ? `- [${it.is_checked ? 'x' : ' '}]` : /^\d+[.)]?$/.test(raw) ? `${raw.replace(/[.)]$/, '')}.` : '-'
  return `${label} ${indent(body, '  ')}`
}

function table(b: Any): string {
  const rows: Any[][] = Array.isArray(b.cells) ? b.cells : []
  if (!rows.length) return ''
  const cell = (c: Any): string => richText(c?.text).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
  const width = Math.max(...rows.map(r => r.length))
  const line = (r: Any[]): string => `| ${Array.from({ length: width }, (_, i) => cell(r[i])).join(' | ')} |`
  const out = [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)]
  return [richText(b.caption), out.join('\n')].filter(Boolean).join('\n')
}

/** one RichBlock */
export function block(b: Any): string {
  if (!b || typeof b !== 'object') return ''
  switch (String(b.type ?? '')) {
    case 'paragraph': case 'footer': return richText(b.text)
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(b.size) || 1)))} ${richText(b.text)}`
    case 'pre': return `\`\`\`${b.language ?? ''}\n${richText(b.text)}\n\`\`\``
    case 'divider': return '---'
    case 'mathematical_expression': return b.expression ? `$$${b.expression}$$` : ''
    case 'anchor': return ''
    case 'list': return (b.items ?? []).map(listItem).join('\n')
    case 'blockquote': case 'expandable_blockquote': return quote([blocks(b.blocks ?? []), richText(b.credit) ? `— ${richText(b.credit)}` : ''].filter(Boolean).join('\n'))
    case 'pullquote': return quote([richText(b.text), richText(b.credit) ? `— ${richText(b.credit)}` : ''].filter(Boolean).join('\n'))
    case 'collage': case 'slideshow': return [blocks(b.blocks ?? []), caption(b.caption)].filter(Boolean).join('\n\n')
    case 'table': return table(b)
    case 'details': return [`**${richText(b.summary)}**`, blocks(b.blocks ?? [])].filter(Boolean).join('\n\n')
    case 'map': return `（地圖：${b.location?.latitude ?? '?'}, ${b.location?.longitude ?? '?'}）${caption(b.caption) ? ` ${caption(b.caption)}` : ''}`
    case 'buttons': return `[按鈕：${(b.buttons ?? []).map((x: Any) => richText(x?.text) || '(無文字)').join('｜')}]`
    case 'photo': return media('照片', Array.isArray(b.photo) ? b.photo[b.photo.length - 1]?.file_id : undefined, b.caption)
    case 'animation': return media('動畫', b.animation?.file_id, b.caption)
    case 'audio': return media('音訊', b.audio?.file_id, b.caption)
    case 'document': return media(`檔案${b.document?.file_name ? ` ${b.document.file_name}` : ''}`, b.document?.file_id, b.caption)
    case 'video': return media('影片', b.video?.file_id, b.caption)
    case 'voice_note': return media('語音', b.voice_note?.file_id, b.caption)
    case 'thinking': return ''                                              // a model's thinking block: not part of what was said
    default: return `（無法顯示的區塊類型：${String(b.type ?? '?')}）`
  }
}

export function blocks(bs: Any[]): string {
  return (Array.isArray(bs) ? bs : []).map(block).filter(s => s !== '').join('\n\n')
}

/** the whole rich message as markdown; '' when it has nothing readable */
export function richToMarkdown(rm: Any): string {
  return blocks(rm?.blocks ?? []).trim()
}
