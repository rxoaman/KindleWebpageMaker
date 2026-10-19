import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/**
 * Converts a Blob to a base64 encoded string.
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const dataUrl = reader.result
      const base64 = dataUrl.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * Saves and delivers an EPUB file on Android and Web.
 *
 * On Android (Native):
 * 1. Writes the EPUB file to device storage (Documents or Cache directory).
 * 2. Invokes Android's native Share/Open intent, enabling the user to immediately:
 *    - Open with Amazon Kindle
 *    - Open with Moon+ Reader / Google Play Books / any E-Reader
 *    - Save to Downloads / Google Drive / Files
 *
 * On Browser / PC:
 * Triggers standard browser file download via temporary anchor element.
 */
export async function saveAndDeliverEpub(blobOrUrl, filename = 'book.epub') {
  let blob = blobOrUrl
  if (typeof blobOrUrl === 'string') {
    try {
      const res = await fetch(blobOrUrl)
      blob = await res.blob()
    } catch (e) {
      console.warn('[fileDownloader] Could not fetch blob from URL:', e)
    }
  }

  if (Capacitor.isNativePlatform() && blob instanceof Blob) {
    try {
      console.log('[fileDownloader] Converting EPUB blob to base64...')
      const base64Data = await blobToBase64(blob)

      // Clean filename to prevent filesystem path issues
      const cleanFilename = filename.replace(/[/\\?%*:|"<>]/g, '-')

      let fileUri = null

      // Try writing to Documents directory first (visible in Files app)
      try {
        const result = await Filesystem.writeFile({
          path: cleanFilename,
          data: base64Data,
          directory: Directory.Documents,
          recursive: true,
        })
        fileUri = result.uri
        console.log('[fileDownloader] Saved to Documents:', fileUri)
      } catch (docErr) {
        console.warn('[fileDownloader] Writing to Documents failed, falling back to Cache:', docErr)
        const result = await Filesystem.writeFile({
          path: cleanFilename,
          data: base64Data,
          directory: Directory.Cache,
          recursive: true,
        })
        fileUri = result.uri
        console.log('[fileDownloader] Saved to Cache:', fileUri)
      }

      // Launch native Android Share / Open Sheet
      if (fileUri) {
        try {
          await Share.share({
            title: cleanFilename,
            text: `Open ${cleanFilename} with Kindle or your preferred reader`,
            url: fileUri,
            dialogTitle: 'Open EPUB with Kindle or E-Reader',
          })
        } catch (shareErr) {
          console.log('[fileDownloader] Native share dismissed or completed:', shareErr)
        }
      }

      return {
        success: true,
        path: fileUri,
        message: 'Saved to Documents and opened share dialog!',
      }
    } catch (err) {
      console.error('[fileDownloader] Error in native save & share:', err)
      // Fallback to browser blob download if native method hit an unexpected error
      triggerBrowserDownload(blob, filename)
      return { success: false, error: err.message }
    }
  } else {
    // Desktop / Web browser download
    triggerBrowserDownload(blob, filename)
    return { success: true, message: 'Browser download initiated.' }
  }
}

export function triggerBrowserDownload(blobOrUrl, filename) {
  if (typeof blobOrUrl === 'string') {
    const a = document.createElement('a')
    a.href = blobOrUrl
    a.download = filename || 'download.epub'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return
  }

  const url = URL.createObjectURL(blobOrUrl)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || 'book.epub'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
