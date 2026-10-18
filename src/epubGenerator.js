import JSZip from 'jszip'

const CODE_CSS = `
  body { font-family: Georgia, serif; font-size: 1em; line-height: 1.6; padding: 5%; color: #111; }
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
  img { max-width: 100%; height: auto; }
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
 * Builds a valid EPUB 2.0 archive in memory as a Blob.
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

  // 3. OEBPS/style.css
  oebps.file('style.css', CODE_CSS)

  // 4. Chapters (XHTML)
  const manifestItems = []
  const spineItems = []
  const navPoints = []

  chapters.forEach((ch, i) => {
    const filename = `chapter_${i}.xhtml`
    const chId = `ch_${i}`
    const chTitle = ch.title || `Chapter ${i + 1}`

    const xhtmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8" />
  <title>${escapeXml(chTitle)}</title>
  <link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
  ${ch.html || ''}
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

  // 5. OEBPS/toc.ncx (Kindle TOC)
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

  // 6. OEBPS/content.opf
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

  // Generate binary EPUB zip
  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  })

  return blob
}
