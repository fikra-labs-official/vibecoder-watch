// Width-safe native text rows; source ranges exclude newline delimiters.
export function textRows(value, width, textSize, measure = () => null, previous = []) {
  // Rewrap only the final row when appending a transport chunk.
  if (previous.length) {
    const last = previous[previous.length - 1]
    const tail = textRows(last.text + last.separator + value, width, textSize, measure)
      .map(row => ({ ...row, start: row.start + last.start, end: row.end + last.start }))
    return previous.slice(0, -1).concat(tail)
  }
  const glyphs = Array.from(value)
  const widths = new Map()
  let marks
  try { marks = new RegExp('\\p{Mark}', 'u') }
  catch (error) { marks = /[\u0300-\u036f\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed\u093a-\u094f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/u }
  const joinsPrevious = glyph => marks.test(glyph) || /[\u200d\ufe00-\ufe0f]/u.test(glyph) ||
    (glyph.codePointAt(0) >= 0x1f3fb && glyph.codePointAt(0) <= 0x1f3ff)
  const regional = glyph => glyph && glyph.codePointAt(0) >= 0x1f1e6 && glyph.codePointAt(0) <= 0x1f1ff
  const glyphWidth = glyph => {
    if (joinsPrevious(glyph)) return 0
    if (widths.has(glyph)) return widths.get(glyph)
    let measured = 0
    try {
      const layout = measure(glyph, { text_size: textSize, text_width: 0, wrapped: 0 })
      if (layout && layout.result !== -1 && layout.width > 0 && layout.width <= textSize * 2) measured = layout.width
    } catch (error) {}
    const fallback = textSize * (/\s/u.test(glyph) ? 0.4 : /[MWmwЖШЩЮФжшщюф]|[^\u0000-\u052f]/u.test(glyph) ? 1.05 : 0.68)
    const result = Math.max(measured, fallback) + 0.5
    widths.set(glyph, result)
    return result
  }
  const rows = []
  let index = 0, offset = 0
  while (index < glyphs.length) {
    let end = index, used = 0, wordEnd = -1, regionalRun = 0
    while (end < glyphs.length && glyphs[end] !== '\n') {
      const next = glyphWidth(glyphs[end])
      const joined = end > index && (glyphs[end - 1] === '\u200d' || joinsPrevious(glyphs[end]) ||
        (regional(glyphs[end]) && regionalRun % 2 === 1))
      if (end > index && used + next > width && !joined) break
      used += next
      regionalRun = regional(glyphs[end]) ? regionalRun + 1 : 0
      end++
      if (/\s/u.test(glyphs[end - 1])) wordEnd = end
    }
    if (end < glyphs.length && glyphs[end] !== '\n' && wordEnd > index + (end - index) / 2) end = wordEnd
    const text = glyphs.slice(index, end).join('')
    const separator = glyphs[end] === '\n' ? '\n' : ''
    rows.push({ text, display: text.trim() ? text : '↵', start: offset, end: offset + text.length, separator })
    offset += text.length + separator.length
    index = end + separator.length
  }
  return rows
}
