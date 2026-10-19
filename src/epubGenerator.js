import JSZip from 'jszip'
import { Capacitor, CapacitorHttp } from '@capacitor/core'

/**
 * High-contrast monochrome CSS optimized specifically for KOReader on E-ink screens.
 * Uses relative rem/em typography for smooth font scaling, borders on code/tables,
 * word-break preventing horizontal overflow, and dedicated footnote styling.
 */
const KO_READER_EINK_CSS = `
  @page {
    margin: 1.2rem 0.8rem;
  }
  body {
    font-family: Georgia, "Nimbus Roman No9 L", "Times New Roman", serif;
    font-size: 1rem;
    line-height: 1.55;
    color: #000000;
    background-color: #ffffff;
    margin: 0;
    padding: 0;
    text-align: justify;
    text-justify: inter-word;
    hyphens: auto;
    -webkit-hyphens: auto;
  }
  article.chapter-content {
    margin: 0 auto;
    max-width: 100%;
  }
  h1, h2, h3, h4, h5, h6 {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-weight: bold;
    color: #000000;
    line-height: 1.25;
    page-break-after: avoid;
    break-after: avoid;
  }
  h1 {
    font-size: 1.55rem;
    margin-top: 1.2rem;
    margin-bottom: 0.6rem;
    padding-bottom: 0.3rem;
    border-bottom: 2px solid #000000;
  }
  h2 { font-size: 1.3rem; margin-top: 1.1rem; margin-bottom: 0.45rem; }
  h3 { font-size: 1.1rem; margin-top: 0.9rem; margin-bottom: 0.35rem; }
  p { margin: 0.75rem 0; text-indent: 0; }
  blockquote {
    margin: 0.8rem 0.6rem;
    padding: 0.4rem 0.8rem;
    border-left: 3px solid #000000;
    background: #f8f8f8;
    font-style: italic;
  }
  pre {
    font-family: "Courier New", Courier, monospace;
    background: #f0f0f0;
    border: 1px solid #000000;
    padding: 0.6rem;
    font-size: 0.85rem;
    line-height: 1.35;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0.85rem 0;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  code {
    font-family: "Courier New", Courier, monospace;
    background: #f0f0f0;
    padding: 0.1rem 0.25rem;
    font-size: 0.88rem;
    border: 1px solid #d0d0d0;
    border-radius: 2px;
  }
  /* Standard simple tables (<= 3 columns) */
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1rem 0;
    font-size: 0.88rem;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  th, td {
    border: 1px solid #000000;
    padding: 0.4rem 0.5rem;
    text-align: left;
    vertical-align: top;
  }
  th {
    background-color: #f0f0f0;
    font-weight: bold;
  }
  /* Restructured wide tables (> 3 columns) for 6"-7" E-ink displays */
  .eink-card-table {
    margin: 1rem 0;
    border: 1px solid #000000;
    padding: 0.5rem;
    background: #ffffff;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .eink-card-table .card-row {
    margin-bottom: 0.6rem;
    padding-bottom: 0.6rem;
    border-bottom: 1px dashed #777777;
  }
  .eink-card-table .card-row:last-child {
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom: none;
  }
  .eink-card-table .card-label {
    font-weight: bold;
    color: #000000;
    display: block;
    font-size: 0.88rem;
  }
  .eink-card-table .card-val {
    display: block;
    margin-left: 0.4rem;
    font-size: 0.88rem;
  }
  /* Images: centered, 100% max width, crisp e-ink rendering */
  img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1.2rem auto;
    page-break-inside: avoid;
    break-inside: avoid;
    image-rendering: -webkit-optimize-contrast;
    image-rendering: crisp-edges;
  }
  .img-placeholder {
    display: block;
    margin: 1rem 0;
    padding: 0.6rem;
    background: #f0f0f0;
    border: 1px dashed #000000;
    font-size: 0.85rem;
    color: #000000;
    text-align: center;
  }
  /* Footnotes & semantic popups in KOReader */
  aside[epub\\:type="footnote"], .footnote {
    margin: 0.8rem 0;
    padding: 0.4rem 0.6rem;
    border-left: 2px solid #555555;
    font-size: 0.85rem;
    background: #fafafa;
  }
  a[epub\\:type="noteref"], .noteref {
    font-weight: bold;
    text-decoration: none;
    color: #000000;
    vertical-align: super;
    font-size: 0.75rem;
    padding: 0 0.15rem;
  }
  a {
    color: #000000;
    text-decoration: underline;
  }
  nav#toc ol {
    padding-left: 1.2rem;
    line-height: 1.7;
  }
  nav#toc li {
    margin: 0.4rem 0;
  }
`

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

/**
 * Fetch image data as Blob using native CapacitorHttp or standard fetch with proxy fallback
 */
async function fetchImageBlob(url) {
  if (Capacitor.isNativePlatform()) {
    try {
      const res = await CapacitorHttp.get({
        url,
        responseType: 'blob',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      })

      if (res.data) {
        if (res.data instanceof Blob) return res.data
        if (typeof res.data === 'string') {
          const base64Data = res.data.startsWith('data:') ? res.data.split(',')[1] : res.data
          const binary = atob(base64Data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          const mime =
            res.headers?.['content-type'] ||
            res.headers?.['Content-Type'] ||
            (/\.webp/i.test(url) ? 'image/webp' : /\.png/i.test(url) ? 'image/png' : 'image/jpeg')
          return new Blob([bytes], { type: mime })
        }
      }
    } catch (err) {
      console.warn(`[epubGenerator] CapacitorHttp failed for ${url}:`, err.message)
    }
  }

  // Browser fetch with backend proxy fallback
  try {
    const res = await fetch(url)
    if (res.ok) return await res.blob()
  } catch (corsErr) {
    try {
      const proxyRes = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`)
      if (proxyRes.ok) return await proxyRes.blob()
    } catch {}
  }

  try {
    const proxyRes = await fetch(`/api/proxy-image?url=${encodeURIComponent(url)}`)
    if (proxyRes.ok) return await proxyRes.blob()
  } catch {}

  throw new Error(`Failed to fetch image ${url}`)
}

/**
 * Convert image to high-contrast monochrome E-ink JPEG using Canvas
 */
async function processImageForKindle(blob, originalUrl) {
  const isSvg = blob.type === 'image/svg+xml' || /\.svg(\?.*)?$/i.test(originalUrl)
  if (isSvg) {
    return {
      buffer: await blob.arrayBuffer(),
      ext: 'svg',
      mimeType: 'image/svg+xml',
    }
  }

  if (typeof document !== 'undefined') {
    try {
      let bitmap
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(blob)
      } else {
        bitmap = await new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = reject
          img.src = URL.createObjectURL(blob)
        })
      }

      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width || bitmap.naturalWidth || 800
      canvas.height = bitmap.height || bitmap.naturalHeight || 600
      const ctx = canvas.getContext('2d')

      // White background
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0)

      // Contrast-enhanced 16-level E-ink grayscale conversion
      try {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const d = imgData.data
        for (let p = 0; p < d.length; p += 4) {
          const gray = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]
          // Boost contrast slightly for razor-sharp diagrams on E-ink
          const enhanced = Math.min(255, Math.max(0, (gray - 128) * 1.15 + 128))
          d[p] = enhanced
          d[p + 1] = enhanced
          d[p + 2] = enhanced
        }
        ctx.putImageData(imgData, 0, 0)
      } catch (pxErr) {
        // Fallback to basic grayscale filter if pixel manipulation restricted
        ctx.filter = 'grayscale(100%)'
        ctx.drawImage(bitmap, 0, 0)
      }

      const jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
      if (jpegBlob) {
        return {
          buffer: await jpegBlob.arrayBuffer(),
          ext: 'jpg',
          mimeType: 'image/jpeg',
        }
      }
    } catch (convErr) {
      console.warn('[epubGenerator] Canvas E-ink image conversion failed, using original:', convErr)
    }
  }

  const isPng = blob.type === 'image/png' || /\.png(\?.*)?$/i.test(originalUrl)
  return {
    buffer: await blob.arrayBuffer(),
    ext: isPng ? 'png' : 'jpg',
    mimeType: isPng ? 'image/png' : 'image/jpeg',
  }
}

/**
 * Builds a valid, self-contained EPUB3 archive optimized for KOReader on E-ink screens.
 *
 * @param {Object} options
 * @param {Object} options
 * @param {string} options.title - Book title
 * @param {string} [options.author] - Author name
 * @param {Array<{ title: string, html: string, url?: string }>} options.chapters
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<Blob>}
 */
export async function generateEpubBlob({
  title,
  author = 'KindleWebpageMaker',
  chapters = [],
  onProgress = () => {},
}) {
  const zip = new JSZip()
  const bookTitle = title || 'eBook'
  const bookAuthor = author || 'KindleWebpageMaker'
  const bookId = `urn:uuid:${Math.random().toString(36).substring(2)}-${Date.now()}`
  const isoDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  // 1. mimetype (MUST be first, uncompressed)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  // 2. META-INF/container.xml
  zip.folder('META-INF').file(
    'container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  )

  const oebps = zip.folder('OEBPS')
  const imagesFolder = oebps.folder('images')

  // 3. OEBPS/style.css
  oebps.file('style.css', KO_READER_EINK_CSS)

  // 4. Build Intra-Book Link Dictionary
  const urlToChapter = new Map()
  chapters.forEach((ch, idx) => {
    if (ch.url) {
      urlToChapter.set(normaliseUrl(ch.url), `chapter_${idx}.xhtml`)
    }
  })

  // 5. Scan all chapters for images and download them
  console.log(`[epubGenerator] Scanning ${chapters.length} chapters for images...`)
  const parser = new DOMParser()
  const imageMap = new Map()

  chapters.forEach((ch) => {
    if (!ch.html) return
    const doc = parser.parseFromString(ch.html, 'text/html')
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src')
      if (src && src.startsWith('http') && !imageMap.has(src)) {
        imageMap.set(src, null)
      }
    })
  })

  console.log(`[epubGenerator] Found ${imageMap.size} unique images. Downloading & converting to E-ink grayscale...`)

  const imageUrls = Array.from(imageMap.keys())
  let savedCount = 0

  onProgress({
    status: 'building',
    found: chapters.length,
    processed: 0,
    total: imageUrls.length || chapters.length || 1,
    message: imageUrls.length > 0
      ? `Found ${imageUrls.length} images to optimize for E-ink...`
      : 'Packaging EPUB3 chapters...',
  })

  for (let i = 0; i < imageUrls.length; i += 4) {
    const batch = imageUrls.slice(i, i + 4)
    await Promise.all(
      batch.map(async (url, batchIdx) => {
        try {
          const blob = await fetchImageBlob(url)
          if (blob && blob.size > 0) {
            const processed = await processImageForKindle(blob, url)
            const id = i + batchIdx + 1
            const localFilename = `image_${id}.${processed.ext}`
            imageMap.set(url, {
              localFilename,
              mimeType: processed.mimeType,
              buffer: processed.buffer,
            })
            imagesFolder.file(localFilename, processed.buffer)
            savedCount++
          }
        } catch (imgErr) {
          console.warn(`[epubGenerator] Could not download image ${url}:`, imgErr.message)
        }
      })
    )
    const curr = Math.min(i + batch.length, imageUrls.length)
    onProgress({
      status: 'building',
      found: imageUrls.length,
      processed: curr,
      total: imageUrls.length,
      message: `Converting images to 16-shade E-ink grayscale (${curr}/${imageUrls.length})...`,
    })
  }

  console.log(`[epubGenerator] Successfully saved ${savedCount} high-contrast E-ink images into OEBPS/images/.`)

  // 6. Rewrite chapters HTML (Images + Intra-book links)
  const manifestItems = []
  const spineItems = []
  const navPoints = []
  const navListItems = []

  chapters.forEach((ch, i) => {
    const filename = `chapter_${i}.xhtml`
    const chId = `ch_${i}`
    const chTitle = ch.title || `Chapter ${i + 1}`

    if (i % 5 === 0 || i === chapters.length - 1) {
      onProgress({
        status: 'building',
        found: chapters.length,
        processed: i + 1,
        total: chapters.length,
        message: `Packaging chapter ${i + 1} of ${chapters.length}...`,
      })
    }

    const doc = parser.parseFromString(ch.html || '', 'text/html')

    // Rewrite images
    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src')
      const alt = img.getAttribute('alt') || 'Diagram'
      if (imageMap.has(src) && imageMap.get(src)) {
        const local = imageMap.get(src).localFilename
        img.setAttribute('src', `images/${local}`)
        img.removeAttribute('srcset')
      } else if (src && src.startsWith('http')) {
        const placeholder = doc.createElement('div')
        placeholder.className = 'img-placeholder'
        placeholder.textContent = `[Image: ${alt}]`
        img.replaceWith(placeholder)
      }
    })

    // Rewrite intra-book internal links
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return
      try {
        const parsed = new URL(href, ch.url || window.location?.origin || 'https://localhost')
        const norm = normaliseUrl(parsed.toString())
        if (urlToChapter.has(norm)) {
          const targetFile = urlToChapter.get(norm)
          const fragment = parsed.hash || ''
          a.setAttribute('href', `${targetFile}${fragment}`)
        }
      } catch {}
    })

    const bodyContent = doc.body.innerHTML || ''

    // Standard EPUB3 XHTML format with epub namespace
    const xhtmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(chTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  ${bodyContent}
</body>
</html>`

    oebps.file(filename, xhtmlContent)

    manifestItems.push(`<item id="${chId}" href="${filename}" media-type="application/xhtml+xml"/>`)
    spineItems.push(`<itemref idref="${chId}"/>`)
    navPoints.push(`
    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(chTitle)}</text></navLabel>
      <content src="${filename}"/>
    </navPoint>`)
    navListItems.push(`      <li><a href="${filename}">${escapeXml(chTitle)}</a></li>`)
  })

  // Add all downloaded images to manifest
  let imgIndex = 1
  for (const [_, info] of imageMap.entries()) {
    if (info) {
      manifestItems.push(
        `<item id="img_${imgIndex++}" href="images/${info.localFilename}" media-type="${info.mimeType}"/>`
      )
    }
  }

  // 7. OEBPS/nav.xhtml (Standard EPUB3 Navigation Document)
  const navXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
  <meta charset="utf-8" />
  <title>Table of Contents</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
${navListItems.join('\n')}
    </ol>
  </nav>
  <nav epub:type="landmarks" id="landmarks" hidden="hidden">
    <h2>Landmarks</h2>
    <ol>
      <li><a epub:type="bodymatter" href="chapter_0.xhtml">Start of Reading</a></li>
    </ol>
  </nav>
</body>
</html>`
  oebps.file('nav.xhtml', navXhtml)

  // 8. OEBPS/toc.ncx (EPUB2 backward compatibility for Crengine in KOReader)
  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${bookId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
  <docAuthor><text>${escapeXml(bookAuthor)}</text></docAuthor>
  <navMap>
    ${navPoints.join('\n')}
  </navMap>
</ncx>`
  oebps.file('toc.ncx', tocNcx)

  // 9. OEBPS/content.opf (Standard EPUB3 Package Document)
  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookID" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="BookID">${bookId}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:creator>${escapeXml(bookAuthor)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${isoDate}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>`
  oebps.file('content.opf', contentOpf)

  // 10. Generate binary EPUB blob
  console.log('[epubGenerator] Packaging KOReader EPUB3 archive...')
  onProgress({
    status: 'building',
    found: chapters.length,
    processed: chapters.length,
    total: chapters.length,
    message: 'Compressing and finalizing EPUB3 archive...',
  })
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  })

  return blob
}
