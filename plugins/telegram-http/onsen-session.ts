const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** Fleet Core accepts a member's numbered conversations. Encoding all 128 bits avoids a lookup table on recovery. */
export function reportSession(session: string, roamerMember?: string): string {
  if (!uuid.test(session)) return session
  if (!roamerMember) return 'main'
  return roamerMember + '.roam.' + BigInt('0x' + session.replaceAll('-', '')).toString()
}

export function receivingUUID(member: string, session?: string | null): string | null {
  if (!session) return null
  if (uuid.test(session)) return session.toLowerCase()  // pre-4b.80 history
  const prefix = member + '.roam.'
  if (!session.startsWith(prefix)) return null
  const number = session.slice(prefix.length)
  if (!/^(?:0|[1-9][0-9]{0,38})$/.test(number)) return null
  const hex = BigInt(number).toString(16).padStart(32, '0')
  if (hex.length !== 32) return null
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
