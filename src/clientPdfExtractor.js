import * as pdfjsLib from 'pdfjs-dist'

// Set worker source for pdfjs-dist
if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cleanPageText(text) {
  const lines = text.split('\n')
  const cleaned = []

  for (let line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      cleaned.push('')
      continue
    }
    if (/^(?:page\s+)?\d+(?:\s+of\s+\d+)?$/i.test(trimmed)) continue
    if (/^-\s*\d+\s*-$/.test(trimmed)) continue
    cleaned.push(line)
  }

  return cleaned.join('\n')
}

function textToHtml(rawText, title) {
  const cleaned = cleanPageText(rawText)
  const blocks = cleaned.split(/\n\s*\n+/)
  const htmlParts = []

  if (title) {
    htmlParts.push(`<h1>${escapeHtml(title)}</h1>`)
  }

  let inList = false
  let listType = 'ul'

  function closeList() {
    if (inList) {
      htmlParts.push(`</${listType}>`)
      inList = false
    }
  }

  for (let block of blocks) {
    const trimmedBlock = block.trim()
    if (!trimmedBlock) continue

    const lines = trimmedBlock.split('\n')

    // Code block check
    const isIndentedCode = lines.length > 1 && lines.every((l) => l.startsWith('    ') || l.startsWith('\t'))
    if (isIndentedCode) {
      closeList()
      htmlParts.push(`<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>`)
      continue
    }

    // Heading check
    if (lines.length === 1 && trimmedBlock.length < 90 && !trimmedBlock.endsWith('.')) {
      if (/^(?:chapter|section|part|module)\s+[0-9ivxlcdm]+/i.test(trimmedBlock) || /^#{1,4}\s+/.test(trimmedBlock)) {
        closeList()
        const headingText = trimmedBlock.replace(/^#{1,4}\s+/, '')
        htmlParts.push(`<h2>${escapeHtml(headingText)}</h2>`)
        continue
      }
      if (/^[A-Z0-9\s,:\-–]{4,60}$/.test(trimmedBlock) && /[A-Z]{3,}/.test(trimmedBlock)) {
        closeList()
        htmlParts.push(`<h3>${escapeHtml(trimmedBlock)}</h3>`)
        continue
      }
    }

    // Lists
    const isBulletList = lines.every((l) => /^\s*[\u2022\u25E6\u2023\u2219\*\-\+]\s+/.test(l))
    const isNumberedList = lines.every((l) => /^\s*\d+[\.\)]\s+/.test(l))

    if (isBulletList) {
      if (!inList || listType !== 'ul') {
        closeList()
        htmlParts.push('<ul>')
        inList = true
        listType = 'ul'
      }
      for (const line of lines) {
        const itemText = line.replace(/^\s*[\u2022\u25E6\u2023\u2219\*\-\+]\s+/, '').trim()
        htmlParts.push(`<li>${escapeHtml(itemText)}</li>`)
      }
      continue
    }

    if (isNumberedList) {
      if (!inList || listType !== 'ol') {
        closeList()
        htmlParts.push('<ol>')
        inList = true
        listType = 'ol'
      }
      for (const line of lines) {
        const itemText = line.replace(/^\s*\d+[\.\)]\s+/, '').trim()
        htmlParts.push(`<li>${escapeHtml(itemText)}</li>`)
      }
      continue
    }

    closeList()

    // Regular paragraph
    let joined = ''
    for (let i = 0; i < lines.length; i++) {
      const cur = lines[i].trim()
      if (!cur) continue
      if (joined.endsWith('-') && /^[a-z]/i.test(cur)) {
        joined = joined.slice(0, -1) + cur
      } else if (joined) {
        joined += ' ' + cur
      } else {
        joined = cur
      }
    }

    if (joined) {
      htmlParts.push(`<p>${escapeHtml(joined)}</p>`)
    }
  }

  closeList()
  return htmlParts.join('\n')
}

/**
 * Parses a PDF file buffer directly in the browser or mobile webview.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {Object} options
 * @param {Function} [options.onProgress]
 * @returns {Promise<{ title: string, author: string, totalPages: number, chapters: Array<{ title: string, html: string }> }>}
 */
export async function parsePdfClient(arrayBuffer, options = {}) {
  const onProgress = options.onProgress || (() => {})

  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer })
  const pdfDoc = await loadingTask.promise
  const totalPages = pdfDoc.numPages

  let docTitle = options.fallbackTitle || ''
  let docAuthor = options.customAuthor || ''

  try {
    const metadata = await pdfDoc.getMetadata()
    if (!docTitle && metadata?.info?.Title) docTitle = metadata.info.Title
    if (!docAuthor && metadata?.info?.Author) docAuthor = metadata.info.Author
  } catch {
    // Ignore metadata failure
  }

  if (!docTitle) docTitle = 'Untitled PDF Document'
  if (!docAuthor) docAuthor = 'Unknown Author'

  const pages = []

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    onProgress({
      processed: pageNum,
      total: totalPages,
      phase: 'parsing',
    })

    const page = await pdfDoc.getPage(pageNum)
    const textContent = await page.getTextContent()

    // Group items by line based on transform Y position
    let lastY = null
    let pageText = ''
    for (const item of textContent.items) {
      if (item.str === undefined) continue
      const currentY = item.transform ? Math.round(item.transform[5]) : null
      if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 5) {
        pageText += '\n' + item.str
      } else {
        pageText += (pageText.endsWith(' ') || !pageText ? '' : ' ') + item.str
      }
      lastY = currentY
    }

    pages.push({ num: pageNum, text: pageText })
  }

  // Chapters structuring
  const chapters = []
  const chapterRegex = /^\s*(?:chapter|part|section)\s+([0-9ivxlcdm]+|[a-z0-9]+)\b[:\-\.]?\s*([^\n]*)/im

  const detectedChapters = []
  pages.forEach((p, idx) => {
    const match = p.text.match(chapterRegex)
    if (match) {
      let chTitle = match[0].trim()
      if (chTitle.length > 60) chTitle = chTitle.slice(0, 57) + '...'
      detectedChapters.push({ pageIndex: idx, title: chTitle })
    }
  })

  if (detectedChapters.length >= 2) {
    for (let i = 0; i < detectedChapters.length; i++) {
      const start = detectedChapters[i].pageIndex
      const end = i < detectedChapters.length - 1 ? detectedChapters[i + 1].pageIndex : totalPages
      const chapterPages = pages.slice(start, end)
      const combinedText = chapterPages.map((cp) => cp.text).join('\n\n')
      const chTitle = detectedChapters[i].title

      chapters.push({
        title: chTitle,
        html: textToHtml(combinedText, chTitle),
      })
    }
  } else {
    let groupSize = 1
    if (totalPages > 50) groupSize = 10
    else if (totalPages > 15) groupSize = 5

    for (let i = 0; i < totalPages; i += groupSize) {
      const chunk = pages.slice(i, i + groupSize)
      const startPage = i + 1
      const endPage = Math.min(i + groupSize, totalPages)
      const chTitle = startPage === endPage ? `Page ${startPage}` : `Pages ${startPage}–${endPage}`

      const combinedText = chunk.map((p) => p.text).join('\n\n')
      chapters.push({
        title: chTitle,
        html: textToHtml(combinedText, chTitle),
      })
    }
  }

  return {
    title: docTitle,
    author: docAuthor,
    totalPages,
    chapters,
  }
}
