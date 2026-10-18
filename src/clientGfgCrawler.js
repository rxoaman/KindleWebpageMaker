import { Capacitor, CapacitorHttp } from '@capacitor/core'

const DELAY_MS = 600
const MAX_PAGES = 150

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normaliseUrl(url) {
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

async function fetchHtml(url) {
  try {
    if (Capacitor.isNativePlatform()) {
      // Native Android HTTP (bypasses browser CORS)
      const response = await CapacitorHttp.get({
        url,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      })
      return response.data || null
    } else {
      // Standard fetch (with fallback proxy if needed)
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
  if (normPrefix === '/dsa' && normPath.startsWith('/data-structures/')) return true
  if (normPrefix === '/data-structures' && normPath.startsWith('/dsa/')) return true
  return false
}

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
    const container = doc.querySelector(sel)
    if (!container) continue
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
        // Skip invalid URLs
      }
    })
  }

  return links
}

function cleanArticleDom(bodyEl, title) {
  const stripSelectors = [
    'script',
    'style',
    'noscript',
    'ins',
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

  // Strip inline styles and wrapper classes
  bodyEl.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'))
  bodyEl.querySelectorAll('div, span, p, section, aside').forEach((el) => el.removeAttribute('class'))

  return `<h1>${title}</h1>\n${bodyEl.innerHTML || ''}`
}

function extractArticleContent(html, url) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  const titleEl = doc.querySelector('h1') || doc.querySelector('title')
  const title = titleEl ? titleEl.textContent.replace(/ ?[|\-–] .*$/, '').trim() : url

  const bodySelectors = [
    '[class*="articleMainContent"]',
    '[class*="article--viewer_content"]',
    '[class*="article-viewer"]',
    '[class*="ArticleContent"]',
    '.article-body',
    'article',
    '.entry-content',
    'main',
  ]

  let body = null
  for (const sel of bodySelectors) {
    const el = doc.querySelector(sel)
    if (el && el.textContent.trim().length > 100) {
      body = el
      break
    }
  }

  if (!body) body = doc.body

  const cleanHtml = cleanArticleDom(body, title)
  return { title, html: cleanHtml }
}

export async function crawlAndExtractGfgClient(startUrl, onProgress = () => {}) {
  const startNorm = normaliseUrl(startUrl)
  const startParsed = new URL(startNorm)
  const baseOrigin = startParsed.origin
  const pathParts = startParsed.pathname.split('/').filter(Boolean)
  const prefix = '/' + (pathParts[0] || 'dsa')

  onProgress({ status: 'crawling', found: 1, processed: 0, total: 1 })

  let seedHtml = await fetchHtml(startNorm)
  let activeSeedUrl = startNorm

  if (!seedHtml) {
    const fallbackPaths = [
      `${prefix}/dsa-tutorial-learn-data-structures-and-algorithms/`,
      `${prefix}/getting-started-with-${pathParts[0]}/`,
      `${prefix}/introduction-to-${pathParts[0]}/`,
      `${prefix}/${pathParts[0]}-tutorial/`,
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
    throw new Error(`Could not fetch the GFG starting page for: ${startUrl}`)
  }

  const parser = new DOMParser()
  const seedDoc = parser.parseFromString(seedHtml, 'text/html')
  const sidebarLinks = extractSidebarLinks(seedDoc, baseOrigin, prefix)

  const urlsToCrawl = [activeSeedUrl]
  const visited = new Set([activeSeedUrl])

  sidebarLinks.forEach((link) => {
    if (!visited.has(link) && urlsToCrawl.length < MAX_PAGES) {
      visited.add(link)
      urlsToCrawl.push(link)
    }
  })

  onProgress({
    status: 'extracting',
    found: urlsToCrawl.length,
    processed: 0,
    total: urlsToCrawl.length,
  })

  const chapters = []

  // Extract first page
  const firstChapter = extractArticleContent(seedHtml, activeSeedUrl)
  if (firstChapter) chapters.push(firstChapter)

  onProgress({
    status: 'extracting',
    found: urlsToCrawl.length,
    processed: 1,
    total: urlsToCrawl.length,
  })

  // Extract remaining pages
  for (let i = 1; i < urlsToCrawl.length; i++) {
    const pageUrl = urlsToCrawl[i]
    await sleep(DELAY_MS)

    const pageHtml = await fetchHtml(pageUrl)
    if (pageHtml) {
      const chapter = extractArticleContent(pageHtml, pageUrl)
      if (chapter) chapters.push(chapter)
    }

    onProgress({
      status: 'extracting',
      found: urlsToCrawl.length,
      processed: i + 1,
      total: urlsToCrawl.length,
    })
  }

  if (chapters.length === 0) {
    throw new Error('Could not extract readable article content from any page.')
  }

  // Derive Section Name
  const sectionName = (pathParts[0] || 'GeeksForGeeks')
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

  return {
    sectionName,
    chapters,
  }
}
