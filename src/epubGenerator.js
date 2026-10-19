import JSZip from 'jszip'
import { Capacitor, CapacitorHttp } from '@capacitor/core'

const CODE_CSS = `
  body { font-family: Georgia, serif; font-size: 1em; line-height: 1.6; padding: 2%; color: #111; }
  h1 { font-size: 1.6em; font-weight: bold; margin-bottom: 0.5em; }
  h2 { font-size: 1.3em; font-weight: bold; margin-top: 1em; }
  h3 { font-size: 1.1em; font-weight: bold; margin-top: 0.8em; }
  p { margin: 0.8em 0; }
  pre {
    background: #f4f4f4;
    border: 1px solid #ddd;
    padding: 0.8em;
    font-size: 0.85em;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
  code {
    font-family: "Courier New", Courier, monospace;
    background: #f4f4f4;
    padding: 0.1em 0.3em;
    font-size: 0.9em;
  }
  table { border-collapse: collapse; width: 100%; margin: 0.5em 0; }
  th, td { border: 1px solid #ccc; padding: 0.3em 0.5em; }
  th { background: #eee; }
  img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
  .img-placeholder {
    display: block;
    margin: 1em 0;
    padding: 0.8em;
    background: #f0f0f0;
    border: 1px dashed #bbb;
    font-size: 0.9em;
    color: #666;
    text-align: center;
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

/**
 * Fetch image data as Blob using native CapacitorHttp or standard fetch
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
          // If Capacitor returned base64 string
          const base64Data = res.data.startsWith('data:') ? res.data.split(',')[1] : res.data
          const binary = atob(base64Data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }
          const mime = res.headers?.['content-type'] || 'image/jpeg'
          return new Blob([bytes], { type: mime })
        }
      }
    } catch (err) {
      console.warn(`[epubGenerator] CapacitorHttp failed for ${url}:`, err.message)
    }
  }

  // Browser fetch fallback
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.blob()
}

/**
 * Convert WebP or unsupported image to JPEG using Canvas for 100% Kindle compatibility
 */
async function processImageForKindle(blob, originalUrl) {
  const isWebp = blob.type === 'image/webp' || /\.webp(\?.*)?$/i.test(originalUrl)
  const isPng = blob.type === 'image/png' || /\.png(\?.*)?$/i.test(originalUrl)
  const isGif = blob.type === 'image/gif' || /\.gif(\?.*)?$/i.test(originalUrl)
  const isSvg = blob.type === 'image/svg+xml' || /\.svg(\?.*)?$/i.test(originalUrl)

  // WebP is not supported by Amazon Kindle devices. Convert to JPEG!
  if (isWebp && typeof document !== 'undefined') {
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

      // White background for any transparent pixels
      ctx.fillStyle = '#FFFFFF'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0)

      const jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
      if (jpegBlob) {
        return {
          buffer: await jpegBlob.arrayBuffer(),
          ext: 'jpg',
          mimeType: 'image/jpeg',
        }
      }
    } catch (convErr) {
      console.warn('[epubGenerator] WebP to JPEG canvas conversion failed:', convErr)
    }
  }

  let ext = 'jpg'
  let mimeType = 'image/jpeg'

  if (isPng) { ext = 'png'; mimeType = 'image/png' }
  else if (isGif) { ext = 'gif'; mimeType = 'image/gif' }
  else if (isSvg) { ext = 'svg'; mimeType = 'image/svg+xml' }

  return {
    buffer: await blob.arrayBuffer(),
    ext,
    mimeType,
  }
}

/**
 * Builds a valid, self-contained EPUB 2.0 archive with all images stored locally in OEBPS/images/.
 *
 * @param {Object} options
 * @param {string} options.title - Book title
 * @param {string} [options.author] - Author name
 * @param {Array<{ title: string, html: string }>} options.chapters
 * @returns {Promise<Blob>}
 */
export async function generateEpubBlob({ title, author = 'KindleWebpageMaker', chapters = [] }) {
  const zip = new JSZip()
  const bookTitle = title || 'eBook'
  const bookAuthor = author || 'KindleWebpageMaker'
  const bookId = `urn:uuid:${Math.random().toString(36).substring(2)}-${Date.now()}`

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
  oebps.file('style.css', CODE_CSS)

  // 4. Scan all chapters for images and download them
  console.log(`[epubGenerator] Scanning ${chapters.length} chapters for images...`)
  const parser = new DOMParser()
  const imageMap = new Map() // originalUrl -> { localFilename, mimeType, buffer }

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

  console.log(`[epubGenerator] Found ${imageMap.size} unique images. Downloading & bundling...`)

  const imageUrls = Array.from(imageMap.keys())
  let savedCount = 0

  // Download images in batches of 4
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
  }

  console.log(`[epubGenerator] Successfully saved ${savedCount} images into OEBPS/images/.`)

  // 5. Rewrite chapters HTML to reference local images/
  const manifestItems = []
  const spineItems = []
  const navPoints = []

  chapters.forEach((ch, i) => {
    const filename = `chapter_${i}.xhtml`
    const chId = `ch_${i}`
    const chTitle = ch.title || `Chapter ${i + 1}`

    const doc = parser.parseFromString(ch.html || '', 'text/html')

    doc.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src')
      const alt = img.getAttribute('alt') || 'Diagram'
      if (imageMap.has(src) && imageMap.get(src)) {
        const local = imageMap.get(src).localFilename
        img.setAttribute('src', `images/${local}`)
        img.removeAttribute('srcset')
      } else if (src && src.startsWith('http')) {
        // Fallback placeholder instead of broken remote link
        const placeholder = doc.createElement('div')
        placeholder.className = 'img-placeholder'
        placeholder.textContent = `[Image: ${alt}]`
        img.replaceWith(placeholder)
      }
    })

    const bodyContent = doc.body.innerHTML || ''

    const xhtmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
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

  // 6. OEBPS/toc.ncx (Kindle TOC)
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

  // 7. OEBPS/content.opf
  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:creator opf:role="aut">${escapeXml(bookAuthor)}</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="BookID" opf:scheme="UUID">${bookId}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
    ${manifestItems.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spineItems.join('\n    ')}
  </spine>
</package>`
  oebps.file('content.opf', contentOpf)

  // 8. Generate binary EPUB blob
  console.log('[epubGenerator] Compacting EPUB archive...')
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  })

  return blob
}
