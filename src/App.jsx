import { useState, useRef, useCallback, useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { generateEpubBlob } from './epubGenerator'
import { parsePdfClient } from './clientPdfExtractor'
import { crawlAndExtractGfgClient } from './clientGfgCrawler'
import { saveAndDeliverEpub } from './fileDownloader'

// ── Status badge colours ────────────────────────────────────────────────────
const STATUS_LABELS = {
  queued: 'Queued',
  crawling: 'Crawling pages…',
  extracting: 'Extracting content…',
  toc_preview: 'Table of Contents Customizer',
  building: 'Compiling KOReader EPUB3…',
  done: 'Done!',
  error: 'Error',
}

const STATUS_COLORS = {
  queued: 'bg-gray-100 text-gray-600',
  crawling: 'bg-blue-100 text-blue-700',
  extracting: 'bg-purple-100 text-purple-700',
  toc_preview: 'bg-indigo-100 text-indigo-700',
  building: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
}

function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="w-full bg-slate-700 rounded-full h-3 overflow-hidden">
      <div
        className="h-3 rounded-full bg-green-500 transition-all duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

const EXAMPLES = [
  { label: 'GFG System Design', url: 'https://www.geeksforgeeks.org/system-design/getting-started-with-system-design/' },
  { label: 'GFG DSA Tutorial', url: 'https://www.geeksforgeeks.org/dsa/dsa-tutorial-learn-data-structures-and-algorithms/' },
  { label: 'Wikipedia Systems Design', url: 'https://en.wikipedia.org/wiki/Systems_design' },
]

export default function App() {
  const isNative = Capacitor.isNativePlatform()

  const [mode, setMode] = useState('web') // 'web' | 'pdf'
  const [crawlScope, setCrawlScope] = useState('crawl') // 'crawl' | 'single'
  const [engineMode, setEngineMode] = useState(isNative ? 'native' : 'auto') // 'native' | 'server' | 'auto'
  const [serverUrl, setServerUrl] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  const [url, setUrl] = useState('')
  const [pdfFile, setPdfFile] = useState(null)
  const [pdfUrl, setPdfUrl] = useState('')
  const [pdfTitle, setPdfTitle] = useState('')
  const [pdfAuthor, setPdfAuthor] = useState('')
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef(null)

  // TOC Preview & Customization State
  const [tocChapters, setTocChapters] = useState([])
  const [customBookTitle, setCustomBookTitle] = useState('')
  const [customAuthor, setCustomAuthor] = useState('')

  const [jobId, setJobId] = useState(null)
  const [downloadBlob, setDownloadBlob] = useState(null)
  const [downloadUrl, setDownloadUrl] = useState(null)
  const [downloadFilename, setDownloadFilename] = useState(null)
  const [downloadStatusMsg, setDownloadStatusMsg] = useState('')
  const [progress, setProgress] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const eventSourceRef = useRef(null)

  // Listen to incoming Android Share Sheet URLs
  useEffect(() => {
    if (window.__INITIAL_SHARED_URL__) {
      setUrl(window.__INITIAL_SHARED_URL__)
    }
    const handleShare = (e) => {
      if (e.detail) setUrl(e.detail)
    }
    window.addEventListener('incomingSharedUrl', handleShare)
    window.handleIncomingShare = (sharedUrl) => {
      if (sharedUrl) setUrl(sharedUrl)
    }
    return () => {
      window.removeEventListener('incomingSharedUrl', handleShare)
    }
  }, [])

  const reset = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    setJobId(null)
    setDownloadBlob(null)
    setDownloadUrl(null)
    setDownloadFilename(null)
    setDownloadStatusMsg('')
    setProgress(null)
    setStatus(null)
    setError(null)
    setLoading(false)
    setTocChapters([])
    setCustomBookTitle('')
    setCustomAuthor('')
  }, [])

  const startSSE = useCallback((id, base = '') => {
    if (eventSourceRef.current) eventSourceRef.current.close()

    const sseEndpoint = base ? `${base.replace(/\/$/, '')}/api/progress/${id}` : `/api/progress/${id}`
    const es = new EventSource(sseEndpoint)
    eventSourceRef.current = es

    es.onmessage = (e) => {
      const data = JSON.parse(e.data)

      if (data.type === 'progress') {
        setStatus(data.status)
        setProgress({ found: data.found, processed: data.processed, total: data.total })
      } else if (data.type === 'done') {
        setStatus('done')
        const dl = base ? `${base.replace(/\/$/, '')}/api/download/${id}` : `/api/download/${id}`
        setDownloadUrl(dl)
        if (data.filename) setDownloadFilename(data.filename)
        setLoading(false)
        es.close()
        saveAndDeliverEpub(dl, data.filename).then((res) => {
          if (res.message) setDownloadStatusMsg(res.message)
        })
      } else if (data.type === 'error') {
        setError(data.message)
        setStatus('error')
        setLoading(false)
        es.close()
      }
    }

    es.onerror = () => {
      setError('Lost connection to server. The job may still be running — refresh to check status.')
      setLoading(false)
      es.close()
    }
  }, [])

  // ── Handle Web / Directory Crawl Submit ─────────────────────────────────────
  const handleWebSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      reset()

      const trimmed = url.trim()
      if (!trimmed) return

      setLoading(true)
      setError(null)
      setStatus('crawling')

      const isSingle = crawlScope === 'single'
      const useInApp = isNative ? engineMode !== 'server' : engineMode === 'native'

      if (useInApp) {
        try {
          const { sectionName, chapters } = await crawlAndExtractGfgClient(
            trimmed,
            { singlePage: isSingle },
            ({ status, found, processed, total }) => {
              setStatus(status)
              setProgress({ found, processed, total })
            }
          )

          const isGfg = trimmed.includes('geeksforgeeks.org')
          const defaultAuthor = isGfg ? 'GeeksForGeeks' : new URL(trimmed).hostname
          const defaultTitle = sectionName || (isGfg ? 'GeeksForGeeks Guide' : 'eBook')

          // If directory mode with multiple chapters: Show TOC Preview & Customizer
          if (!isSingle && chapters.length > 1) {
            setTocChapters(
              chapters.map((ch, idx) => ({
                id: idx,
                title: ch.title || `Chapter ${idx + 1}`,
                html: ch.html,
                url: ch.url,
                selected: true,
              }))
            )
            setCustomBookTitle(defaultTitle)
            setCustomAuthor(defaultAuthor)
            setStatus('toc_preview')
            setLoading(false)
            return
          }

          // Single page mode: compile directly
          setStatus('building')
          setProgress({ found: chapters.length, processed: chapters.length, total: chapters.length })

          const safeName = defaultTitle.replace(/[/\\?%*:|"<>]/g, '').trim().replace(/\s+/g, '-')
          const finalFilename = `${safeName}.epub`

          const blob = await generateEpubBlob({
            title: defaultTitle,
            author: defaultAuthor,
            chapters,
          })

          const blobUrl = URL.createObjectURL(blob)
          setDownloadBlob(blob)
          setDownloadUrl(blobUrl)
          setDownloadFilename(finalFilename)
          setStatus('done')
          setLoading(false)

          const deliverRes = await saveAndDeliverEpub(blob, finalFilename)
          if (deliverRes.message) setDownloadStatusMsg(deliverRes.message)
        } catch (err) {
          console.error('[App] Crawl error:', err)
          setError(err.message || 'Failed to crawl and extract webpage content.')
          setStatus('error')
          setLoading(false)
        }
        return
      }

      // Backend route (PC browser default or when explicitly selected)
      const apiBase = serverUrl.trim()
      const crawlEndpoint = apiBase ? `${apiBase.replace(/\/$/, '')}/api/crawl-pages` : '/api/crawl-pages'

      try {
        const res = await fetch(crawlEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed, singlePage: isSingle }),
        })
        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.error || 'Failed to start job.')
        }

        const isGfg = trimmed.includes('geeksforgeeks.org')
        const defaultAuthor = isGfg ? 'GeeksForGeeks' : new URL(trimmed).hostname
        const defaultTitle = data.sectionName || 'eBook'

        if (!isSingle && data.chapters?.length > 1) {
          setTocChapters(
            data.chapters.map((ch, idx) => ({
              id: idx,
              title: ch.title || `Chapter ${idx + 1}`,
              html: ch.html,
              url: ch.url,
              selected: true,
            }))
          )
          setCustomBookTitle(defaultTitle)
          setCustomAuthor(defaultAuthor)
          setStatus('toc_preview')
          setLoading(false)
          return
        }

        // Single page fallback
        compileCustomToc(data.chapters, defaultTitle, defaultAuthor)
      } catch (err) {
        console.error('[App] Backend request failed:', err)
        setError(err.message || 'Failed to connect to backend server. Make sure the backend is running on port 3001.')
        setStatus('error')
        setLoading(false)
      }
    },
    [url, crawlScope, reset, engineMode, isNative, serverUrl]
  )

  // ── Compile Customized TOC ────────────────────────────────────────────────
  const compileCustomToc = async (chaptersToCompile, bookTitleArg, authorArg) => {
    const list = chaptersToCompile || tocChapters.filter((c) => c.selected)
    if (!list || list.length === 0) {
      setError('Please select at least one chapter to include in your EPUB.')
      return
    }

    setLoading(true)
    setError(null)
    setStatus('building')
    setProgress({ found: list.length, processed: list.length, total: list.length })

    const finalTitle = bookTitleArg || customBookTitle || 'KOReader-Guide'
    const finalAuthor = authorArg || customAuthor || 'KindleWebpageMaker'
    const safeName = finalTitle.replace(/[/\\?%*:|"<>]/g, '').trim().replace(/\s+/g, '-')
    const finalFilename = `${safeName}.epub`

    const useInApp = isNative ? engineMode !== 'server' : engineMode === 'native'

    if (useInApp || !serverUrl) {
      try {
        const blob = await generateEpubBlob({
          title: finalTitle,
          author: finalAuthor,
          chapters: list,
        })

        const blobUrl = URL.createObjectURL(blob)
        setDownloadBlob(blob)
        setDownloadUrl(blobUrl)
        setDownloadFilename(finalFilename)
        setStatus('done')
        setLoading(false)

        const deliverRes = await saveAndDeliverEpub(blob, finalFilename)
        if (deliverRes.message) setDownloadStatusMsg(deliverRes.message)
      } catch (err) {
        console.error('[compileCustomToc] In-app build error:', err)
        setError(err.message || 'Failed to generate EPUB archive.')
        setStatus('error')
        setLoading(false)
      }
    } else {
      // Backend compile route
      const apiBase = serverUrl.trim()
      const compileEndpoint = apiBase ? `${apiBase.replace(/\/$/, '')}/api/compile-epub` : '/api/compile-epub'

      try {
        const res = await fetch(compileEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: finalTitle,
            author: finalAuthor,
            chapters: list,
          }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Backend compilation failed.')

        const dl = apiBase ? `${apiBase.replace(/\/$/, '')}${data.downloadUrl}` : data.downloadUrl
        setDownloadUrl(dl)
        setDownloadFilename(data.filename || finalFilename)
        setStatus('done')
        setLoading(false)

        saveAndDeliverEpub(dl, data.filename || finalFilename).then((r) => {
          if (r.message) setDownloadStatusMsg(r.message)
        })
      } catch (err) {
        console.error('[compileCustomToc] Backend error:', err)
        setError(err.message || 'Failed to compile via backend.')
        setStatus('error')
        setLoading(false)
      }
    }
  }

  // TOC Reordering Helpers
  const moveChapter = (index, direction) => {
    const newIdx = index + direction
    if (newIdx < 0 || newIdx >= tocChapters.length) return
    const updated = [...tocChapters]
    const temp = updated[index]
    updated[index] = updated[newIdx]
    updated[newIdx] = temp
    setTocChapters(updated)
  }

  const toggleChapterSelection = (index) => {
    const updated = [...tocChapters]
    updated[index].selected = !updated[index].selected
    setTocChapters(updated)
  }

  const selectAllChapters = (select) => {
    setTocChapters(tocChapters.map((c) => ({ ...c, selected: select })))
  }

  const updateChapterTitle = (index, newTitle) => {
    const updated = [...tocChapters]
    updated[index].title = newTitle
    setTocChapters(updated)
  }

  // ── Handle PDF Submit ─────────────────────────────────────────────────────
  const handlePdfSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      reset()

      if (!pdfFile && !pdfUrl.trim()) {
        setError('Please choose a PDF file or enter a PDF URL.')
        return
      }

      setLoading(true)
      setError(null)
      setStatus('extracting')

      if (pdfFile && (engineMode === 'native' || isNative || !serverUrl)) {
        try {
          const arrayBuffer = await pdfFile.arrayBuffer()
          const fallbackTitle = pdfTitle.trim() || pdfFile.name.replace(/\.pdf$/i, '')

          const { title, author, totalPages, chapters } = await parsePdfClient(arrayBuffer, {
            fallbackTitle,
            customAuthor: pdfAuthor.trim(),
            onProgress: ({ processed, total }) => {
              setProgress({ found: totalPages || total, processed, total })
            },
          })

          setStatus('building')
          const safeTitle = (title || 'Document').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '-')
          const finalFilename = `${safeTitle}.epub`

          const blob = await generateEpubBlob({
            title: title || fallbackTitle,
            author: author || 'KindleWebpageMaker',
            chapters,
          })

          const blobUrl = URL.createObjectURL(blob)
          setDownloadBlob(blob)
          setDownloadUrl(blobUrl)
          setDownloadFilename(finalFilename)
          setStatus('done')
          setLoading(false)

          const deliverRes = await saveAndDeliverEpub(blob, finalFilename)
          if (deliverRes.message) setDownloadStatusMsg(deliverRes.message)
        } catch (err) {
          console.error('[App] Client PDF parse error:', err)
          setError(err.message || 'Failed to parse PDF document in browser/app.')
          setStatus('error')
          setLoading(false)
        }
        return
      }

      // Backend route for PDF
      const apiBase = serverUrl.trim()
      const convertEndpoint = apiBase ? `${apiBase.replace(/\/$/, '')}/api/convert-pdf` : '/api/convert-pdf'

      try {
        const formData = new FormData()
        if (pdfFile) formData.append('file', pdfFile)
        if (pdfUrl.trim()) formData.append('url', pdfUrl.trim())
        if (pdfTitle.trim()) formData.append('title', pdfTitle.trim())
        if (pdfAuthor.trim()) formData.append('author', pdfAuthor.trim())

        const res = await fetch(convertEndpoint, { method: 'POST', body: formData })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to start PDF conversion.')

        setJobId(data.jobId)
        startSSE(data.jobId, apiBase)
      } catch (err) {
        console.error('[App] PDF backend request failed:', err)
        setError(err.message || 'Failed to connect to backend server.')
        setStatus('error')
        setLoading(false)
      }
    },
    [pdfFile, pdfUrl, pdfTitle, pdfAuthor, reset, startSSE, engineMode, isNative, serverUrl]
  )

  const progressPct =
    progress && (progress.total || progress.found) > 0
      ? Math.min(100, Math.round((progress.processed / (progress.total || progress.found)) * 100))
      : 0

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-10 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">📖</span>
            <div>
              <h1 className="font-bold text-base sm:text-lg leading-tight tracking-tight flex items-center gap-2">
                <span>KindleWebpageMaker</span>
                <span className="text-xs bg-slate-800 text-green-400 font-mono px-2 py-0.5 rounded border border-green-500/30">
                  KOReader E-Ink Edition
                </span>
              </h1>
              <p className="text-xs text-slate-400 hidden sm:block">
                High-contrast monochrome EPUB3 generator for offline reading on jailbroken E-ink Kindles
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className="text-xs text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 px-3 py-1.5 rounded-lg border border-slate-700 transition-colors flex items-center gap-1.5"
            >
              <span>⚙️</span>
              <span className="hidden sm:inline">Settings</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 px-4 py-6 sm:py-8">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Settings Drawer */}
          {showSettings && (
            <div className="bg-slate-800/90 rounded-2xl border border-slate-700 p-5 space-y-4 animate-in fade-in duration-200">
              <div className="flex items-center justify-between border-b border-slate-700 pb-2">
                <h3 className="font-semibold text-sm flex items-center gap-2 text-slate-200">
                  <span>⚙️</span> Engine & Conversion Settings
                </h3>
                <button
                  onClick={() => setShowSettings(false)}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  ✕ Close
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Execution Engine:</label>
                  <select
                    value={engineMode}
                    onChange={(e) => setEngineMode(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-green-500"
                  >
                    <option value="auto">Auto (Native App / Direct)</option>
                    <option value="native">In-App Engine (100% Offline / No Server)</option>
                    <option value="server">Remote Backend Server</option>
                  </select>
                  <p className="text-slate-500 mt-1">
                    In-app mode executes entirely on your device with high-contrast grayscale image processing.
                  </p>
                </div>

                {engineMode === 'server' && (
                  <div>
                    <label className="block text-slate-400 mb-1 font-medium">Backend Server URL:</label>
                    <input
                      type="text"
                      value={serverUrl}
                      onChange={(e) => setServerUrl(e.target.value)}
                      placeholder="http://192.168.1.50:3001"
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-slate-200 focus:outline-none focus:ring-2 focus:ring-green-500 font-mono"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Mode Tabs */}
          <div className="flex bg-slate-800/80 p-1 rounded-xl border border-slate-700">
            <button
              onClick={() => { setMode('web'); reset() }}
              className={`flex-1 py-2 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 ${
                mode === 'web' ? 'bg-green-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>🌐</span>
              <span>Web / Documentation</span>
            </button>
            <button
              onClick={() => { setMode('pdf'); reset() }}
              className={`flex-1 py-2 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 ${
                mode === 'pdf' ? 'bg-green-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>📄</span>
              <span>PDF Document</span>
            </button>
          </div>

          {/* Input Card */}
          <div className="bg-slate-800 rounded-2xl shadow-xl p-5 sm:p-7 border border-slate-700">
            {mode === 'web' ? (
              <>
                <div className="mb-4">
                  <h2 className="text-base sm:text-lg font-semibold mb-1 flex items-center gap-2">
                    <span>📚</span> Convert Webpage or Full Guide to EPUB3
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">
                    Enter any documentation topic or individual article. Formatted with monochrome E-ink typography,
                    definition-card wide tables, popup footnote semantics, and high-contrast grayscale imagery.
                  </p>
                </div>

                {/* Scope selector */}
                <div className="flex gap-4 mb-4 text-xs sm:text-sm">
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                    <input
                      type="radio"
                      name="crawlScope"
                      value="crawl"
                      checked={crawlScope === 'crawl'}
                      onChange={() => setCrawlScope('crawl')}
                      className="accent-green-500"
                    />
                    <span className="font-medium">Multi-Page / Directory Mode</span>
                    <span className="text-xs text-slate-500 hidden sm:inline">(Crawls all sub-pages with TOC customizer)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300">
                    <input
                      type="radio"
                      name="crawlScope"
                      value="single"
                      checked={crawlScope === 'single'}
                      onChange={() => setCrawlScope('single')}
                      className="accent-green-500"
                    />
                    <span className="font-medium">Single Article Only</span>
                  </label>
                </div>

                <form onSubmit={handleWebSubmit} className="space-y-4">
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="url"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://www.geeksforgeeks.org/system-design/getting-started-with-system-design/"
                      required
                      disabled={loading}
                      className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-sm
                                 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500
                                 disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      disabled={loading || !url.trim()}
                      className="bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed
                                 text-white font-semibold px-5 py-2.5 rounded-lg text-sm transition-colors whitespace-nowrap"
                    >
                      {loading
                        ? (crawlScope === 'crawl' ? 'Scanning Pages…' : 'Extracting…')
                        : (crawlScope === 'crawl' ? 'Scan & Review TOC' : 'Generate EPUB')}
                    </button>
                  </div>

                  {/* Examples */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-slate-500 text-xs">Examples:</span>
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex.label}
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          setUrl(ex.url)
                          if (ex.url.includes('wikipedia')) setCrawlScope('single')
                          else setCrawlScope('crawl')
                        }}
                        className="text-xs text-green-400 hover:text-green-300 underline disabled:opacity-50"
                      >
                        {ex.label}
                      </button>
                    ))}
                  </div>
                </form>
              </>
            ) : (
              /* PDF mode */
              <>
                <div className="mb-4">
                  <h2 className="text-base sm:text-lg font-semibold mb-1 flex items-center gap-2">
                    <span>📄</span> Convert PDF Document to EPUB3
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">
                    Upload any PDF document. Converts into reflowable, clean monochrome EPUB3 ready for KOReader.
                  </p>
                </div>

                <form onSubmit={handlePdfSubmit} className="space-y-4">
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                      pdfFile ? 'border-green-600/60 bg-slate-700/50' : 'border-slate-600 hover:border-slate-500 bg-slate-700/30'
                    }`}
                  >
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept=".pdf,application/pdf"
                      onChange={(e) => {
                        if (e.target.files?.[0]) {
                          const file = e.target.files[0]
                          setPdfFile(file)
                          if (!pdfTitle) setPdfTitle(file.name.replace(/\.pdf$/i, ''))
                        }
                      }}
                      className="hidden"
                    />

                    {pdfFile ? (
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 text-left">
                          <span className="text-3xl">📕</span>
                          <div>
                            <div className="font-medium text-sm text-slate-200">{pdfFile.name}</div>
                            <div className="text-xs text-slate-400">
                              {(pdfFile.size / (1024 * 1024)).toFixed(2)} MB • Ready to convert
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            setPdfFile(null)
                          }}
                          className="text-xs text-red-400 hover:text-red-300 px-2 py-1"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div>
                        <span className="text-3xl block mb-2">📁</span>
                        <div className="text-sm font-medium text-slate-300">Tap to choose PDF document</div>
                        <div className="text-xs text-slate-500 mt-1">Processed locally on your device</div>
                      </div>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !pdfFile}
                    className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-lg text-sm transition-colors mt-2"
                  >
                    {loading ? 'Processing PDF…' : 'Convert PDF to KOReader EPUB'}
                  </button>
                </form>
              </>
            )}
          </div>

          {/* Table of Contents Preview & Customizer */}
          {status === 'toc_preview' && tocChapters.length > 0 && (
            <div className="bg-slate-800 rounded-2xl shadow-xl p-5 sm:p-7 border border-indigo-500/40 space-y-5 animate-in fade-in duration-300">
              <div className="border-b border-slate-700 pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h3 className="text-base sm:text-lg font-bold text-slate-100 flex items-center gap-2">
                    <span>📑</span> Table of Contents Preview & Customization
                  </h3>
                  <p className="text-xs text-slate-400">
                    Reorder chapters, edit titles, or uncheck pages you don't want to read.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => selectAllChapters(true)}
                    className="text-indigo-400 hover:text-indigo-300 underline"
                  >
                    Select All
                  </button>
                  <span className="text-slate-600">•</span>
                  <button
                    type="button"
                    onClick={() => selectAllChapters(false)}
                    className="text-slate-400 hover:text-slate-300 underline"
                  >
                    Deselect All
                  </button>
                </div>
              </div>

              {/* Book Metadata overrides */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-900/60 p-3.5 rounded-xl border border-slate-700/60 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Book Title:</label>
                  <input
                    type="text"
                    value={customBookTitle}
                    onChange={(e) => setCustomBookTitle(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-slate-200"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Author Name:</label>
                  <input
                    type="text"
                    value={customAuthor}
                    onChange={(e) => setCustomAuthor(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-1.5 text-slate-200"
                  />
                </div>
              </div>

              {/* Chapter List */}
              <div className="max-h-96 overflow-y-auto space-y-2 pr-1 divide-y divide-slate-700/40">
                {tocChapters.map((ch, idx) => (
                  <div
                    key={ch.id}
                    className={`pt-2 flex items-center gap-2 sm:gap-3 p-2 rounded-lg transition-colors ${
                      ch.selected ? 'bg-slate-700/30 hover:bg-slate-700/50' : 'opacity-40 bg-slate-900/40'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={ch.selected}
                      onChange={() => toggleChapterSelection(idx)}
                      className="accent-green-500 w-4 h-4 cursor-pointer"
                    />

                    <span className="text-xs font-mono text-slate-500 w-6 text-right">
                      {idx + 1}.
                    </span>

                    <input
                      type="text"
                      value={ch.title}
                      onChange={(e) => updateChapterTitle(idx, e.target.value)}
                      className="flex-1 bg-slate-800 border border-slate-600 rounded px-2.5 py-1 text-xs text-slate-200 focus:ring-1 focus:ring-green-500"
                    />

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveChapter(idx, -1)}
                        disabled={idx === 0}
                        title="Move Up"
                        className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 rounded border border-slate-600 disabled:opacity-30"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => moveChapter(idx, 1)}
                        disabled={idx === tocChapters.length - 1}
                        title="Move Down"
                        className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 rounded border border-slate-600 disabled:opacity-30"
                      >
                        ▼
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Action buttons */}
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
                <span className="text-xs text-slate-400">
                  {tocChapters.filter((c) => c.selected).length} of {tocChapters.length} chapters selected
                </span>

                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={reset}
                    className="flex-1 sm:flex-initial px-4 py-2 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 rounded-lg border border-slate-700"
                  >
                    Cancel
                  </button>

                  <button
                    type="button"
                    onClick={() => compileCustomToc()}
                    disabled={tocChapters.filter((c) => c.selected).length === 0}
                    className="flex-1 sm:flex-initial bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold px-6 py-2.5 rounded-lg text-sm transition-colors shadow-lg shadow-green-900/30"
                  >
                    Compile KOReader EPUB ({tocChapters.filter((c) => c.selected).length} Chapters)
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Live Progress Card */}
          {status && status !== 'toc_preview' && (
            <div className="bg-slate-800 rounded-2xl shadow-xl p-5 sm:p-7 border border-slate-700 space-y-4 animate-in fade-in duration-300">
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full ${
                    STATUS_COLORS[status] || 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {loading && status !== 'done' && status !== 'error' && (
                    <span className="inline-block w-2 h-2 rounded-full bg-current animate-pulse" />
                  )}
                  {STATUS_LABELS[status] || status}
                </span>
                {jobId && (
                  <span className="text-slate-500 text-xs font-mono">Job: {jobId.slice(0, 8)}…</span>
                )}
              </div>

              {progress && status !== 'error' && (
                <div className="space-y-2">
                  <ProgressBar value={progress.processed} max={progress.total || progress.found || 1} />
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>
                      {status === 'crawling'
                        ? `Discovered ${progress.found} pages, crawled ${progress.processed}`
                        : `Processing ${progress.processed} / ${progress.total || progress.found} pages`}
                    </span>
                    <span>{progressPct}%</span>
                  </div>
                </div>
              )}

              {error && (
                <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {/* Done / Download Card */}
              {status === 'done' && (
                <div className="flex flex-col items-center gap-3 pt-2">
                  <div className="text-green-400 text-4xl">✅</div>
                  <p className="text-slate-200 text-sm font-medium text-center">
                    Your KOReader E-Ink EPUB3 ebook is compiled and ready!
                  </p>

                  {downloadStatusMsg && (
                    <div className="text-xs text-green-300 bg-green-950/60 border border-green-700/60 rounded-lg px-4 py-2 text-center">
                      {downloadStatusMsg}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={async () => {
                      const res = await saveAndDeliverEpub(downloadBlob || downloadUrl, downloadFilename)
                      if (res.message) setDownloadStatusMsg(res.message)
                    }}
                    className="bg-green-600 hover:bg-green-500 text-white font-semibold px-8 py-3 rounded-lg text-sm transition-colors flex items-center gap-2 shadow-lg shadow-green-900/30 active:scale-95"
                  >
                    <span>{isNative ? '📱' : '⬇️'}</span>
                    <span>{isNative ? 'Save to Downloads / Open in KOReader' : 'Download EPUB'}</span>
                  </button>

                  <button
                    onClick={() => {
                      reset()
                      setUrl('')
                      setPdfFile(null)
                    }}
                    className="text-slate-400 hover:text-slate-200 text-xs underline pt-1"
                  >
                    Start a new conversion
                  </button>
                </div>
              )}
            </div>
          )}

          {/* E-ink KOReader Feature Info */}
          {!status && (
            <div className="bg-slate-800/40 rounded-2xl border border-slate-700/60 p-5">
              <h3 className="font-semibold text-slate-300 text-xs sm:text-sm mb-3 flex items-center gap-2">
                <span>⚡</span> KOReader on E-Ink Optimizations
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-slate-400">
                <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/50 space-y-1">
                  <div className="font-semibold text-slate-200">📊 Responsive Table Handling</div>
                  <div>Wide tables are automatically converted into readable stacked cards so they never clip on 6" E-ink displays.</div>
                </div>

                <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/50 space-y-1">
                  <div className="font-semibold text-slate-200">🔍 Native Popup Footnotes</div>
                  <div>Semantic EPUB3 <code>noteref</code> tagging triggers native KOReader popup dialogs without losing page position.</div>
                </div>

                <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/50 space-y-1">
                  <div className="font-semibold text-slate-200">🖼️ 16-Shade Grayscale Images</div>
                  <div>Diagrams are converted to high-contrast monochrome JPEG/PNG to render crisp lines on E-ink with fast page turns.</div>
                </div>

                <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/50 space-y-1">
                  <div className="font-semibold text-slate-200">🔗 Intra-Book Local Anchors</div>
                  <div>Cross-page links within documentation guides are rewritten into internal EPUB anchors for 100% offline reading.</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-3 px-4 text-center text-xs text-slate-500">
        KindleWebpageMaker • KOReader E-Ink Edition
      </footer>
    </div>
  )
}
