import { Capacitor, CapacitorHttp } from '@capacitor/core'

const DELAY_MS = 400
const MAX_PAGES = Infinity

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Normalize URL: strip hash, query parameters, and trailing slash
 */
export function normaliseUrl(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    u.search = ''
    let path = u.pathname
    if (path.endsWith('/') && path !== '/') path = path.slice(0, -1)
    u.pathname = path
    return u.toString()
  } catch {
    return url
  }
}

/**
 * Fetch HTML using Native Android HTTP (bypasses browser CORS) or standard fetch
 */
export async function fetchHtml(url) {
  try {
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({
        url,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      })
      if (response.status && response.status >= 400) {
        console.warn(`[client crawler] HTTP ${response.status} for ${url}`)
        return null
      }
      const data = response.data
      if (typeof data === 'string') return data
      if (data && typeof data === 'object') return JSON.stringify(data)
      return null
    } else {
      const res = await fetch(url)
      if (!res.ok) return null
      return await res.text()
    }
  } catch (err) {
    console.warn(`[client crawler] Failed to fetch ${url}:`, err.message)
    return null
  }
}

function isPathUnderSection(normPath, normPrefix) {
  if (normPath.startsWith(normPrefix + '/')) return true
  if (normPath === normPrefix) return true
  if (normPrefix === '/dsa' && normPath.startsWith('/data-structures/')) return true
  if (normPrefix === '/data-structures' && normPath.startsWith('/dsa/')) return true
  return false
}

/**
 * Extract links from sidebar containers (GFG and docs sidebars)
 */
function extractSidebarLinks(doc, baseOrigin, prefix) {
  const links = []
  const sidebarSelectors = [
    '[class*="LeftbarContainer"]',
    '[class*="leftBarContainer"]',
    '[class*="leftBar"]',
    '[class*="LeftBar"]',
    '[class*="sidebar"]',
    '[class*="Sidebar"]',
    'aside',
    'nav',
  ]

  const visited = new Set()
  const normPrefix = prefix.replace(/\/$/, '')

  for (const sel of sidebarSelectors) {
    const containers = doc.querySelectorAll(sel)
    containers.forEach((container) => {
      const anchorElements = container.querySelectorAll('a[href]')
      anchorElements.forEach((el) => {
        const href = el.getAttribute('href') || ''
        if (!href.startsWith('http') && !href.startsWith('/')) return
        try {
          const u = new URL(href, baseOrigin)
          if (u.origin !== baseOrigin) return
          const normPath = u.pathname.replace(/\/$/, '')
          if (!isPathUnderSection(normPath, normPrefix)) return
          const norm = normaliseUrl(u.toString())
          if (!visited.has(norm)) {
            visited.add(norm)
            links.push(norm)
          }
        } catch {
          // ignore invalid URLs
        }
      })
    })
  }

  return links
}

/**
 * Extract all links on the page that belong to the same section prefix.
 */
function extractPageLinks(doc, baseOrigin, prefix, visited) {
  const links = []
  const normPrefix = prefix.replace(/\/$/, '')
  const anchors = doc.querySelectorAll('a[href]')

  anchors.forEach((el) => {
    const href = el.getAttribute('href') || ''
    if (!href || href.startsWith('javascript') || href.startsWith('#')) return
    try {
      const u = new URL(href, baseOrigin)
      if (u.origin !== baseOrigin) return
      const normPath = u.pathname.replace(/\/$/, '')
      if (!isPathUnderSection(normPath, normPrefix)) return
      const norm = normaliseUrl(u.toString())
      if (!visited.has(norm)) {
        visited.add(norm)
        links.push(norm)
      }
    } catch {
      // ignore
    }
  })

  return links
}

/**
 * Clean article DOM and format into Kindle-compatible HTML
 */
function cleanArticleDom(bodyEl, title, url = '') {
  const stripSelectors = [
    'script',
    'style',
    'noscript',
    'ins',
    'iframe',
    '[class*="LeftbarContainer"]',
    '[class*="RightBar"]',
    '[class*="leftBar"]',
    '[class*="rightBar"]',
    '[class*="sidebar"]',
    '[class*="Sidebar"]',
    '[class*="advertisement"]',
    '[class*="Advertisement"]',
    '[class*="GFG_AD"]',
    '[class*="selfad"]',
    '[class*="promotionalCta"]',
    '[class*="quizHighlight"]',
    '[class*="SuggestCorrection"]',
    '[class*="improvePage"]',
    '[class*="articleTags"]',
    '[class*="feedbackComponent"]',
    '[class*="comment"]',
    '[class*="social"]',
    '[class*="shareButton"]',
    '[class*="cookie"]',
    '[class*="consent"]',
    '[class*="popup"]',
    '[class*="modal"]',
    'nav',
    'header',
    'footer',
  ]

  stripSelectors.forEach((sel) => {
    bodyEl.querySelectorAll(sel).forEach((el) => el.remove())
  })

  // --- Restructure wide tables for 6" to 7" E-ink displays ---
  restructureTablesDom(bodyEl)

  // --- Mark footnotes for native KOReader popup dialogs ---
  markFootnotesDom(bodyEl)

  // Strip inline styles and wrapper classes
  bodyEl.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'))
  bodyEl.querySelectorAll('div, span, section, aside').forEach((el) => {
    if (!el.className?.includes('card-') && !el.className?.includes('noteref') && !el.className?.includes('footnote')) {
      el.removeAttribute('class')
    }
  })

  // --- Normalize and resolve all images ---
  bodyEl.querySelectorAll('img').forEach((img) => {
    let rawSrc =
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('src') ||
      ''

    img.removeAttribute('srcset')
    img.removeAttribute('data-src')
    img.removeAttribute('data-lazy-src')
    img.removeAttribute('data-original')
    img.removeAttribute('loading')

    rawSrc = rawSrc.trim()
    if (!rawSrc || rawSrc.startsWith('data:image/svg')) {
      img.remove()
      return
    }

    try {
      const resolved = new URL(rawSrc, url).toString()
      img.setAttribute('src', resolved)
    } catch {
      img.remove()
    }
  })

  return `<article class="chapter-content">\n<h1>${escapeXml(title)}</h1>\n${bodyEl.innerHTML || ''}\n</article>`
}

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;'
        case '>': return '&gt;'
        case '&': return '&amp;'
        case '\'': return '&apos;'
        case '"': return '&quot;'
      }
    })
}

function restructureTablesDom(bodyEl) {
  if (typeof document === 'undefined') return
  bodyEl.querySelectorAll('table').forEach((table) => {
    const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th')).map((th) => th.textContent.trim())
    const rows = Array.from(table.querySelectorAll('tbody tr, tr'))
    const maxCols = Math.max(headers.length, ...rows.map((r) => r.querySelectorAll('td, th').length))

    if (maxCols > 3) {
      const cardTable = document.createElement('div')
      cardTable.className = 'eink-card-table'
      cardTable.setAttribute('role', 'region')
      cardTable.setAttribute('aria-label', 'Table')

      rows.forEach((r) => {
        if (r.querySelectorAll('th').length > 0 && r.querySelectorAll('td').length === 0) return
        const cells = Array.from(r.querySelectorAll('td, th'))
        if (cells.length === 0) return

        const rowDiv = document.createElement('div')
        rowDiv.className = 'card-row'

        cells.forEach((cell, idx) => {
          const header = headers[idx] || `Field ${idx + 1}`
          const content = cell.innerHTML.trim()
          if (content) {
            const field = document.createElement('div')
            field.className = 'card-field'
            field.innerHTML = `<span class="card-label">${escapeXml(header)}:</span> <span class="card-val">${content}</span>`
            rowDiv.appendChild(field)
          }
        })

        if (rowDiv.children.length > 0) {
          cardTable.appendChild(rowDiv)
        }
      })

      table.replaceWith(cardTable)
    }
  })
}

function markFootnotesDom(bodyEl) {
  if (typeof document === 'undefined') return
  bodyEl.querySelectorAll('a[href^="#"]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    const text = a.textContent.trim()
    if (href.match(/#(fn|footnote|cite_note|ref)/i) || text.match(/^\[?\d+\]?$/) || a.parentElement?.tagName === 'SUP') {
      a.setAttribute('epub:type', 'noteref')
      a.classList.add('noteref')
      if (a.parentElement?.tagName !== 'SUP') {
        const sup = document.createElement('sup')
        a.replaceWith(sup)
        sup.appendChild(a)
      }
    }
  })

  bodyEl.querySelectorAll('[id^="fn"], [id^="footnote"], [id^="cite_note"], .footnote, .footnotes li').forEach((el) => {
    el.setAttribute('epub:type', 'footnote')
    el.classList.add('footnote')
  })
}

/**
 * Extract clean readable article content from HTML (supports GFG and generic websites)
 */
export function extractArticleContent(html, url) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  // Find title
  const titleEl =
    doc.querySelector('h1') ||
    doc.querySelector('meta[property="og:title"]') ||
    doc.querySelector('title')

  let title = ''
  if (titleEl) {
    title = (titleEl.getAttribute?.('content') || titleEl.textContent || '')
      .replace(/ ?[|\-–] .*$/, '')
      .trim()
  }
  if (!title) {
    try {
      const u = new URL(url)
      const parts = u.pathname.split('/').filter(Boolean)
      title = parts[parts.length - 1] || u.hostname
    } catch {
      title = 'Article'
    }
  }

  // Find main content container
  const candidateSelectors = [
    // GFG specific selectors
    '[class*="articleMainContent"]',
    '[class*="article--viewer_content"]',
    '[class*="article-viewer"]',
    '[class*="ArticleContent"]',
    '.article-body',
    // Generic article selectors
    'article',
    '[role="main"]',
    'main',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.markdown-body',
    '#content',
    '.content',
  ]

  let body = null
  for (const sel of candidateSelectors) {
    const el = doc.querySelector(sel)
    if (el && el.textContent.trim().length > 120) {
      body = el
      break
    }
  }

  if (!body) body = doc.body || doc.documentElement

  // Clone node to avoid modifying original
  const clone = body.cloneNode(true)
  const cleanHtml = cleanArticleDom(clone, title, url)
  return { title, html: cleanHtml, url }
}

/**
 * Crawl and extract pages client-side using true BFS.
 * Supports up to MAX_PAGES (200), discovering links on EVERY crawled sub-page.
 *
 * @param {string} startUrl - Starting URL (GFG or any website)
 * @param {object} options - { singlePage: boolean, maxPages: number }
 * @param {function} onProgress - Live progress callback
 */
export async function crawlAndExtractClient(startUrl, options = {}, onProgress = () => {}) {
  const singlePage = options.singlePage || false
  const maxLimit = options.maxPages || MAX_PAGES

  const startNorm = normaliseUrl(startUrl)
  const startParsed = new URL(startNorm)
  const baseOrigin = startParsed.origin
  const pathParts = startParsed.pathname.split('/').filter(Boolean)

  const isGfg = startParsed.hostname.includes('geeksforgeeks.org')

  // Derive section prefix (e.g. /system-design/ or /docs/tutorial/)
  let prefix = '/'
  if (pathParts.length > 0) {
    prefix = '/' + pathParts[0]
  }

  // Derive title from section or URL
  let sectionName = pathParts[0] || startParsed.hostname
  sectionName = sectionName
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())

  onProgress({ status: 'crawling', found: 1, processed: 0, total: 1 })

  let seedHtml = await fetchHtml(startNorm)
  let activeSeedUrl = startNorm

  // If initial GFG page fails (e.g. /system-design/ 404), attempt common article entrypoints
  if (!seedHtml && isGfg) {
    const fallbackPaths = [
      `${prefix}/dsa-tutorial-learn-data-structures-and-algorithms/`,
      `${prefix}/getting-started-with-${pathParts[0]}/`,
      `${prefix}/introduction-to-${pathParts[0]}/`,
      `${prefix}/${pathParts[0]}-tutorial/`,
      `${prefix}/${pathParts[0]}-introduction/`,
      `/data-structures/introduction-to-data-structures/`,
    ]
    for (const fp of fallbackPaths) {
      const tryUrl = baseOrigin + fp
      seedHtml = await fetchHtml(tryUrl)
      if (seedHtml) {
        activeSeedUrl = normaliseUrl(tryUrl)
        break
      }
    }
  }

  if (!seedHtml) {
    throw new Error(`Could not fetch the starting page for: ${startUrl}`)
  }

  // If single page mode, just extract this one page
  if (singlePage) {
    onProgress({ status: 'extracting', found: 1, processed: 0, total: 1 })
    const chapter = extractArticleContent(seedHtml, activeSeedUrl)
    onProgress({ status: 'extracting', found: 1, processed: 1, total: 1 })
    return {
      sectionName: chapter.title || sectionName,
      chapters: [chapter],
    }
  }

  // BFS crawl setup
  const visited = new Set([activeSeedUrl])
  const queue = [activeSeedUrl]
  const chapters = []

  // Extract links from seed document
  const parser = new DOMParser()
  const seedDoc = parser.parseFromString(seedHtml, 'text/html')
  const initialSidebarLinks = extractSidebarLinks(seedDoc, baseOrigin, prefix)

  for (const link of initialSidebarLinks) {
    if (!visited.has(link) && queue.length < maxLimit) {
      visited.add(link)
      queue.push(link)
    }
  }

  // If sidebar gave few links, also scan seed page links
  if (queue.length < 5) {
    const pageLinks = extractPageLinks(seedDoc, baseOrigin, prefix, visited)
    for (const link of pageLinks) {
      if (queue.length >= maxLimit) break
      queue.push(link)
    }
  }

  onProgress({
    status: 'crawling',
    found: visited.size,
    processed: 0,
    total: visited.size,
  })

  // --- BFS Loop: Fetch & Discover up to maxLimit (200 pages) ---
  while (queue.length > 0 && chapters.length < maxLimit) {
    const currentUrl = queue.shift()

    // Fetch page HTML
    let currentHtml = currentUrl === activeSeedUrl ? seedHtml : await fetchHtml(currentUrl)
    if (!currentHtml) continue

    // Extract chapter content
    const chapter = extractArticleContent(currentHtml, currentUrl)
    if (chapter && chapter.html) {
      chapters.push(chapter)
    }

    onProgress({
      status: 'extracting',
      found: visited.size,
      processed: chapters.length,
      total: visited.size,
    })

    // Discover new links from this page to continue BFS crawl up to 200 pages!
    if (visited.size < maxLimit) {
      const pageDoc = parser.parseFromString(currentHtml, 'text/html')
      let newLinks = extractSidebarLinks(pageDoc, baseOrigin, prefix).filter((l) => !visited.has(l))

      if (newLinks.length === 0) {
        newLinks = extractPageLinks(pageDoc, baseOrigin, prefix, visited)
      }

      for (const link of newLinks) {
        if (visited.size >= maxLimit) break
        visited.add(link)
        queue.push(link)
      }

      onProgress({
        status: 'extracting',
        found: visited.size,
        processed: chapters.length,
        total: visited.size,
      })
    }

    await sleep(DELAY_MS)
  }

  if (chapters.length === 0) {
    throw new Error('Could not extract readable article content from the provided website.')
  }

  return {
    sectionName,
    chapters,
  }
}

// Backwards compatibility alias
export const crawlAndExtractGfgClient = crawlAndExtractClient
