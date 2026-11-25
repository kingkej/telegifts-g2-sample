import { byteLength, characters, fitNativeText, nativeTextBytes } from './displayText.ts'
import type { CompanionToolPage } from './contracts/tools.ts'

export function wrap(text: string, width: number): string[] {
  const words = text.replace(/[\u202a-\u202e\u2066-\u2069]/gu, '').trim().split(/\s+/u)
  const lines: string[] = []
  let line: string[] = []
  for (const word of words) {
    const letters = characters(word)
    if (line.length && line.length + letters.length + 1 > width) {
      lines.push(line.join(''))
      line = []
    }
    let start = 0
    while (letters.length - start > width) {
      lines.push(letters.slice(start, start + width).join(''))
      start += width
    }
    if (line.length) line.push(' ')
    line.push(...letters.slice(start))
  }
  if (line.length) lines.push(line.join(''))
  return lines
}

function compact(text: string, width: number, rows: number): string[] {
  const lines = wrap(text, width)
  if (lines.length <= rows) return lines
  return [...lines.slice(0, rows - 1), characters(lines[rows - 1]!).slice(0, width - 1).join('') + '…']
}

const back = 'Double-tap to go back'

function browseContent(lines: string[], hints: string[], swipe?: string) {
  const navigation = swipe ? fitNativeText(swipe, 120) + '\n' + back : back
  const body = lines.join('\n')
  const budget = nativeTextBytes - byteLength(navigation) - 2
  const hint = fitNativeText(hints.join('\n'), budget - Math.min(byteLength(body), Math.floor(budget / 2)))
  const footer = hint ? hint + '\n' + navigation : navigation
  return fitNativeText(body, nativeTextBytes - byteLength(footer) - 1) + '\n' + footer
}

function readingPages(title: string, lines: string[], maxRows: number, footerBytes: number) {
  const heading = fitNativeText(title, 192, '')
  const rows = title === heading ? lines : [title.slice(heading.length), ...lines]
  const bodyBudget = nativeTextBytes - byteLength(heading) - footerBytes
  let page = [heading]
  const pages = [page]
  let available = bodyBudget
  for (let row of rows) {
    while (row) {
      let chunk = page.length <= maxRows ? fitNativeText(row, available - 1, '') : ''
      if (!chunk && page.length > 1) {
        page = [heading]
        pages.push(page)
        available = bodyBudget
        continue
      }
      if (chunk) {
        row = row.slice(chunk.length)
      } else {
        row = row.slice(characters(row)[0]!.length)
        chunk = '[Read on phone]'
      }
      page.push(chunk)
      available -= byteLength(chunk) + 1
    }
  }
  return pages
}

export function followUpAnswerPages(title: string, answer: string) {
  const pages = readingPages(title, wrap(answer, 43), 3, 160)
  return pages.map((lines, index) => [...lines, pages.length > 1 ? `Swipe to read · ${index + 1}/${pages.length}` : ''])
}

export function toolView(page: CompanionToolPage, cursor: number, chartIssue?: 'empty' | 'failed', phoneVisible = true) {
  const width = (page.chart || page.framePixels) && !chartIssue ? 23 : 43
  const chartHint = chartIssue === 'empty' ? 'No floor observations' : chartIssue === 'failed' ? 'Menu → Retry chart' : undefined
  const heading = wrap(page.title, width)
  const first = heading[0] ?? 'Companion tools'
  if (page.browse) {
    const action = phoneVisible ? page.actions.find(item => item.id === page.browse?.open && !item.requiresConfirmation) : undefined
    const swipe = phoneVisible
      ? (page.browse.next || page.browse.previous
          ? page.browse.swipeHint ?? 'Swipe to browse tasks'
          : page.browse.swipeHint)
      : undefined
    const browseHints = phoneVisible
      ? (action ? compact('Tap → ' + action.label, width, 2) : [])
      : ['Unlock your phone to use tool actions.']
    const content = [...compact(page.title, width, 2), ...(chartHint ? [chartHint] : []), ...page.lines.flatMap(line => compact(line, width, 1))]
    return { content: browseContent(content, browseHints, swipe), position: 0, total: 1, action }
  }
  const lines = [...heading.slice(1), ...(chartHint ? [chartHint] : []), ...page.lines.flatMap(line => wrap(line, width))]
  const actions = phoneVisible ? page.actions : []
  const actionHints = actions.map(action =>
    fitNativeText(compact((action.requiresConfirmation ? 'Menu → ' : 'Tap → ') + action.label, width, 2).join('\n'), 240),
  )
  const locked = !phoneVisible && page.actions.length ? 'Unlock your phone to use tool actions.' : ''
  const maxPages = page.title.length + lines.reduce((n, line) => n + line.length, 0) + actions.length + 1
  const navigationBytes = byteLength(`\nSwipe   ${maxPages} / ${maxPages}\n${back}`)
  const hintBytes = actionHints.reduce((max, hint) => Math.max(max, byteLength(hint)), byteLength(locked))
  const pages = readingPages(first, lines, 4, navigationBytes + (hintBytes ? hintBytes + 1 : 0))
  const total = pages.length + Math.max(0, actions.length - 1)
  const position = Math.max(0, Math.min(cursor, total - 1))
  const actionIndex = position - pages.length + 1
  const content = [...pages[Math.min(position, pages.length - 1)]!]
  const hint = actionHints[actionIndex] || locked
  if (hint) content.push(hint)
  if (total > 1) content.push('Swipe   ' + (position + 1) + ' / ' + total)
  content.push(back)
  return { content: content.join('\n'), position, total, action: actions[actionIndex] }
}
