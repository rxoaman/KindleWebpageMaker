import { useState, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { generateEpubBlob } from './epubGenerator'
import { parsePdfClient } from './clientPdfExtractor'
import { crawlAndExtractGfgClient } from './clientGfgCrawler'

// ── Status badge colours ────────────────────────────────────────────────────
const STATUS_LABELS = {
  queued: 'Queued',
  crawling: 'Crawling pages…',
  extracting: 'Extracting content…',
  building: 'Building EPUB…',
  done: 'Done!',
  error: 'Error',
}

const STATUS_COLORS = {
  queued: 'bg-gray-100 text-gray-600',
  crawling: 'bg-blue-100 text-blue-700',
  extracting: 'bg-purple-100 text-purple-700',
  building: 'bg-yellow-100 text-yellow-700',
  done: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
}

function ProgressBar({ value, max }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
      <div
        className="h-3 rounded-full bg-green-500 transition-all duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function triggerDownload(blobOrUrl, filename) {
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

const EXAMPLES = [
  'https://www.geeksforgeeks.org/system-design/getting-started-with-system-design/',
  'https://www.geeksforgeeks.org/dsa/dsa-tutorial-learn-data-structures-and-algorithms/',
  'https://www.geeksforgeeks.org/data-structures/introduction-to-data-structures/',
]

export default function App() {
  const isNative = Capacitor.isNativePlatform()

  const [mode, setMode] = useState('gfg') // 'gfg' | 'pdf'
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

  const [jobId, setJobId] = useState(null)
  const [downloadUrl, setDownloadUrl] = useState(null)
  const [downloadFilename, setDownloadFilename] = useState(null)
  const [progress, setProgress] = useState(null)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const eventSourceRef = useRef(null)

  const reset = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    setJobId(null)
    setDownloadUrl(null)
    setDownloadFilename(null)
    setProgress(null)
    setStatus(null)
    setError(null)
    setLoading(false)
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

  // ── Handle GFG Submit ─────────────────────────────────────────────────────
  const handleGfgSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      reset()

      const trimmed = url.trim()
      if (!trimmed) return

      setLoading(true)
      setError(null)
      setStatus('crawling')

      // Use In-App Native Engine if in APK or forced native
      if (engineMode === 'native' || isNative) {
        try {
          const { sectionName, chapters } = await crawlAndExtractGfgClient(trimmed, ({ status, found, processed, total }) => {
            setStatus(status)
            setProgress({ found, processed, total })
          })

          setStatus('building')
          setProgress({ found: chapters.length, processed: chapters.length, total: chapters.length })

          const safeName = (sectionName || 'GeeksForGeeks').replace(/\s+/g, '-')
          const finalFilename = `${safeName}-GeeksForGeeks.epub`

          const blob = await generateEpubBlob({
            title: `${sectionName} - GeeksForGeeks`,
            author: 'GeeksForGeeks',
            chapters,
          })

          const blobUrl = URL.createObjectURL(blob)
          setDownloadUrl(blobUrl)
          setDownloadFilename(finalFilename)
          setStatus('done')
          setLoading(false)
          triggerDownload(blob, finalFilename)
        } catch (err) {
          setError(err.message || 'Failed to crawl GFG section.')
          setStatus('error')
          setLoading(false)
        }
        return
      }

      // Otherwise, use backend server
      const apiBase = serverUrl.trim()
      const crawlEndpoint = apiBase ? `${apiBase.replace(/\/$/, '')}/api/crawl` : '/api/crawl'

      try {
        const res = await fetch(crawlEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: trimmed }),
        })
        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.error || 'Failed to start job.')
        }

        setJobId(data.jobId)
        startSSE(data.jobId, apiBase)
      } catch (err) {
        // Fallback to client-side engine if server is unreachable
        if (err.message?.includes('fetch') || err.message?.includes('Failed')) {
          console.warn('Backend server unreachable, falling back to in-app engine...')
          try {
            const { sectionName, chapters } = await crawlAndExtractGfgClient(trimmed, ({ status, found, processed, total }) => {
              setStatus(status)
              setProgress({ found, processed, total })
            })
            setStatus('building')
            const finalFilename = `${sectionName.replace(/\s+/g, '-')}-GeeksForGeeks.epub`
            const blob = await generateEpubBlob({
              title: `${sectionName} - GeeksForGeeks`,
              author: 'GeeksForGeeks',
              chapters,
            })
            const blobUrl = URL.createObjectURL(blob)
            setDownloadUrl(blobUrl)
            setDownloadFilename(finalFilename)
            setStatus('done')
            setLoading(false)
            triggerDownload(blob, finalFilename)
            return
          } catch (innerErr) {
            setError(innerErr.message)
            setStatus('error')
            setLoading(false)
            return
          }
        }
        setError(err.message)
        setStatus('error')
        setLoading(false)
      }
    },
    [url, reset, startSSE, engineMode, isNative, serverUrl]
  )

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

      // If PDF file is uploaded, we can process it directly in-app!
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
            title,
            author,
            chapters,
          })

          const blobUrl = URL.createObjectURL(blob)
          setDownloadUrl(blobUrl)
          setDownloadFilename(finalFilename)
          setStatus('done')
          setLoading(false)
          triggerDownload(blob, finalFilename)
          return
        } catch (clientErr) {
          console.warn('In-app PDF parse failed, trying server...', clientErr)
          if (!serverUrl && !isNative) {
            // Let's try server
          } else {
            setError(clientErr.message || 'Failed to process PDF.')
            setStatus('error')
            setLoading(false)
            return
          }
        }
      }

      // Backend route
      const apiBase = serverUrl.trim()
      const convertEndpoint = apiBase ? `${apiBase.replace(/\/$/, '')}/api/convert-pdf` : '/api/convert-pdf'

      try {
        const formData = new FormData()
        if (pdfFile) {
          formData.append('file', pdfFile)
        } else {
          formData.append('url', pdfUrl.trim())
        }

        if (pdfTitle.trim()) formData.append('title', pdfTitle.trim())
        if (pdfAuthor.trim()) formData.append('author', pdfAuthor.trim())

        const res = await fetch(convertEndpoint, {
          method: 'POST',
          body: formData,
        })
        const data = await res.json()

        if (!res.ok) {
          throw new Error(data.error || 'Failed to start PDF conversion.')
        }

        setJobId(data.jobId)
        startSSE(data.jobId, apiBase)
      } catch (err) {
        setError(err.message)
        setStatus('error')
        setLoading(false)
      }
    },
    [pdfFile, pdfUrl, pdfTitle, pdfAuthor, reset, startSSE, engineMode, isNative, serverUrl]
  )

  const handleDragOver = (e) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0]
      if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
        setPdfFile(file)
        if (!pdfTitle) setPdfTitle(file.name.replace(/\.pdf$/i, ''))
      } else {
        setError('Please drop a valid PDF file (.pdf)')
      }
    }
  }

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-700 px-4 sm:px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl">📚</span>
          <div>
            <h1 className="text-lg sm:text-xl font-bold tracking-tight flex items-center gap-2">
              KindleWebpageMaker
              {isNative ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <span>🤖</span> Android App
                </span>
              ) : (
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-green-500/20 text-green-400 border border-green-500/30">
                  Web & APK Ready
                </span>
              )}
            </h1>
            <p className="text-slate-400 text-xs sm:text-sm">
              Convert GeeksForGeeks or PDF documents into Kindle-ready EPUB ebooks
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          className="p-2 text-slate-400 hover:text-slate-200 rounded-lg hover:bg-slate-800 transition-colors"
          title="App Settings"
        >
          ⚙️
        </button>
      </header>

      {/* Settings Panel */}
      {showSettings && (
        <div className="bg-slate-800/95 border-b border-slate-700 px-4 sm:px-6 py-3">
          <div className="max-w-2xl mx-auto flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center text-xs">
            <div>
              <span className="font-semibold text-slate-300 block mb-1">Execution Engine:</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEngineMode('native')}
                  className={`px-3 py-1 rounded font-medium ${
                    engineMode === 'native' ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-300'
                  }`}
                >
                  In-App Native (Offline)
                </button>
                <button
                  type="button"
                  onClick={() => setEngineMode('server')}
                  className={`px-3 py-1 rounded font-medium ${
                    engineMode === 'server' ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-300'
                  }`}
                >
                  Remote / PC Backend
                </button>
              </div>
            </div>

            {engineMode === 'server' && (
              <div className="w-full sm:w-auto flex-1 sm:max-w-xs">
                <span className="font-semibold text-slate-300 block mb-1">Server URL:</span>
                <input
                  type="text"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="http://192.168.1.50:3001"
                  className="w-full bg-slate-700 border border-slate-600 rounded px-2.5 py-1 text-xs text-white"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main */}
      <main className="flex-1 flex items-start justify-center px-4 py-6 sm:py-10">
        <div className="w-full max-w-2xl space-y-6">

          {/* Mode Switcher Tabs */}
          <div className="flex bg-slate-800/80 p-1.5 rounded-xl border border-slate-700 shadow-lg">
            <button
              type="button"
              onClick={() => { reset(); setMode('gfg'); }}
              disabled={loading}
              className={`flex-1 py-2.5 px-3 sm:px-4 rounded-lg font-medium text-xs sm:text-sm transition-all flex items-center justify-center gap-1.5 ${
                mode === 'gfg'
                  ? 'bg-green-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>🌐</span> GeeksForGeeks
            </button>
            <button
              type="button"
              onClick={() => { reset(); setMode('pdf'); }}
              disabled={loading}
              className={`flex-1 py-2.5 px-3 sm:px-4 rounded-lg font-medium text-xs sm:text-sm transition-all flex items-center justify-center gap-1.5 ${
                mode === 'pdf'
                  ? 'bg-green-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <span>📄</span> PDF to EPUB
            </button>
          </div>

          {/* Main Card */}
          <div className="bg-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8 border border-slate-700">
            {mode === 'gfg' ? (
              <>
                <div className="mb-5">
                  <h2 className="text-base sm:text-lg font-semibold mb-1 flex items-center gap-2">
                    <span>🌐</span> Convert GFG Section to EPUB
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">
                    Enter any GeeksForGeeks article URL in a topic section. The app will crawl all sub-pages,
                    clean the content, and bundle it into an EPUB for your Kindle.
                  </p>
                </div>

                <form onSubmit={handleGfgSubmit} className="space-y-4">
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
                      {loading ? 'Crawling…' : 'Convert to EPUB'}
                    </button>
                  </div>

                  {/* Example links */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="text-slate-500 text-xs">Examples:</span>
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        disabled={loading}
                        onClick={() => setUrl(ex)}
                        className="text-xs text-green-400 hover:text-green-300 underline disabled:opacity-50"
                      >
                        {new URL(ex).pathname.split('/')[1] || 'tutorial'}
                      </button>
                    ))}
                  </div>
                </form>
              </>
            ) : (
              <>
                <div className="mb-5">
                  <h2 className="text-base sm:text-lg font-semibold mb-1 flex items-center gap-2">
                    <span>📄</span> Convert PDF Document to EPUB
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm">
                    Upload any PDF (book, paper, tutorial). We will extract text, format code and lists,
                    organize it into readable chapters, and generate a Kindle-ready EPUB.
                  </p>
                </div>

                <form onSubmit={handlePdfSubmit} className="space-y-4">
                  {/* File Dropzone */}
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                      isDragging
                        ? 'border-green-500 bg-green-500/10'
                        : pdfFile
                        ? 'border-green-600/60 bg-slate-700/50'
                        : 'border-slate-600 hover:border-slate-500 bg-slate-700/30'
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
                          className="text-xs text-red-400 hover:text-red-300 px-3 py-1 bg-red-900/30 rounded border border-red-800"
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="text-3xl mb-2">📥</div>
                        <p className="text-sm font-medium text-slate-300">
                          Tap to select or drop your PDF here
                        </p>
                        <p className="text-xs text-slate-500">Supports documents, papers, and books up to 100MB</p>
                      </div>
                    )}
                  </div>

                  {/* Or PDF URL */}
                  <div className="flex items-center gap-3 my-2">
                    <div className="flex-1 h-px bg-slate-700"></div>
                    <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">
                      or use direct PDF link
                    </span>
                    <div className="flex-1 h-px bg-slate-700"></div>
                  </div>

                  <input
                    type="url"
                    value={pdfUrl}
                    onChange={(e) => setPdfUrl(e.target.value)}
                    placeholder="https://example.com/document.pdf"
                    disabled={loading || !!pdfFile}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-sm
                               placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500
                               disabled:opacity-40"
                  />

                  {/* Optional Metadata */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">
                        Book Title (optional)
                      </label>
                      <input
                        type="text"
                        value={pdfTitle}
                        onChange={(e) => setPdfTitle(e.target.value)}
                        placeholder="Auto-detected from PDF"
                        disabled={loading}
                        className="w-full bg-slate-700/70 border border-slate-600 rounded-lg px-3 py-2 text-xs
                                   placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">
                        Author Name (optional)
                      </label>
                      <input
                        type="text"
                        value={pdfAuthor}
                        onChange={(e) => setPdfAuthor(e.target.value)}
                        placeholder="Auto-detected from PDF"
                        disabled={loading}
                        className="w-full bg-slate-700/70 border border-slate-600 rounded-lg px-3 py-2 text-xs
                                   placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={loading || (!pdfFile && !pdfUrl.trim())}
                    className="w-full bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed
                               text-white font-semibold py-2.5 rounded-lg text-sm transition-colors mt-2"
                  >
                    {loading ? 'Processing PDF…' : 'Convert PDF to EPUB'}
                  </button>
                </form>
              </>
            )}
          </div>

          {/* Progress Card */}
          {status && (
            <div className="bg-slate-800 rounded-2xl shadow-2xl p-6 sm:p-8 border border-slate-700 space-y-5 animate-in fade-in duration-300">
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
                  <span className="text-slate-500 text-xs font-mono">
                    Job: {jobId.slice(0, 8)}…
                  </span>
                )}
              </div>

              {/* Progress bar + stats */}
              {progress && status !== 'error' && (
                <div className="space-y-2">
                  <ProgressBar value={progress.processed} max={progress.total || progress.found || 1} />
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>
                      {mode === 'pdf'
                        ? status === 'extracting'
                          ? `Extracting and structuring pages (${progress.processed}/${progress.total})...`
                          : status === 'building'
                          ? 'Generating Kindle EPUB...'
                          : `Total Pages: ${progress.found}`
                        : status === 'crawling'
                        ? `Found ${progress.found} pages, crawled ${progress.processed}`
                        : `Processed ${progress.processed} / ${progress.total} pages`}
                    </span>
                    <span>{progressPct}%</span>
                  </div>
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="bg-red-900/40 border border-red-700 rounded-lg px-4 py-3 text-sm text-red-300">
                  <strong>Error:</strong> {error}
                </div>
              )}

              {/* Done — download button */}
              {status === 'done' && (
                <div className="flex flex-col items-center gap-4 pt-2">
                  <div className="text-green-400 text-4xl">✅</div>
                  <p className="text-slate-300 text-sm text-center">
                    Your Kindle-ready EPUB is generated and ready to download!
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (downloadUrl) {
                        triggerDownload(downloadUrl, downloadFilename)
                      }
                    }}
                    className="bg-green-600 hover:bg-green-500 text-white font-semibold px-8 py-3
                               rounded-lg text-sm transition-colors flex items-center gap-2 shadow-lg hover:shadow-green-500/20"
                  >
                    <span>⬇️</span> Download EPUB
                  </button>
                  <button
                    onClick={() => {
                      reset()
                      setUrl('')
                      setPdfFile(null)
                      setPdfUrl('')
                    }}
                    className="text-slate-400 hover:text-slate-200 text-sm underline"
                  >
                    Start a new conversion
                  </button>
                </div>
              )}
            </div>
          )}

          {/* How it works */}
          {!status && (
            <div className="bg-slate-800/50 rounded-2xl border border-slate-700 p-6">
              <h3 className="font-semibold text-slate-300 mb-4 flex items-center gap-2">
                <span>⚡</span> Features & In-App Engine
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-slate-400">
                <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60 space-y-1">
                  <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                    <span>📱</span> Native Android APK
                  </div>
                  <p>
                    Runs natively inside an installable APK. Crawling uses native Android OkHttp to fetch
                    GFG without CORS restrictions.
                  </p>
                </div>

                <div className="p-3 bg-slate-800/60 rounded-lg border border-slate-700/60 space-y-1">
                  <div className="font-semibold text-slate-200 flex items-center gap-1.5">
                    <span>📄</span> Offline PDF to EPUB
                  </div>
                  <p>
                    Converts PDFs to Kindle-ready reflowable EPUBs directly on your device with no
                    backend or PC required.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-700 px-6 py-4 text-center text-slate-500 text-xs">
        KindleWebpageMaker — Native Android APK & Web Edition
      </footer>
    </div>
  )
}
