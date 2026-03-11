import { generateArtGrid, renderArtGridSvg, renderArtGridCanvas, isPointInShape, shapesHitTestOrder, PATTERNS } from './art-grid-engine.js'
import Tesseract from 'tesseract.js'

const HEX_IN_IMAGE_REGEX = /#?([0-9a-fA-F]{6})\b/g

/**
 * Extract hex color codes from text in an image using OCR (full-resolution image for accuracy).
 * @param {Blob} blob
 * @returns {Promise<string[]>} Normalized #rrggbb strings, order preserved, deduped by first occurrence
 */
async function extractHexCodesFromImage(blob) {
  const {
    data: { text },
  } = await Tesseract.recognize(blob, 'eng', { logger: () => {} })
  const seen = new Set()
  const out = []
  let m
  HEX_IN_IMAGE_REGEX.lastIndex = 0
  while ((m = HEX_IN_IMAGE_REGEX.exec(text)) !== null) {
    const hex = '#' + m[1].toLowerCase()
    if (!seen.has(hex)) {
      seen.add(hex)
      out.push(hex)
    }
  }
  return out
}

function encodeSvgMetadata(metadata) {
  return btoa(encodeURIComponent(JSON.stringify(metadata)))
}

function decodeSvgMetadata(svgElement) {
  const metadataNode = svgElement?.querySelector('#occult-floorplan-meta')
  if (metadataNode == null) return null
  const encoded = metadataNode.textContent?.trim()
  if (encoded == null || encoded.length === 0) return null
  try {
    const json = decodeURIComponent(atob(encoded))
    return JSON.parse(json)
  } catch {
    return null
  }
}

const MAX_SEED = 4294967295
const SETTINGS_KEY = 'artGrid.settings'
const DEFAULT_COLORS = ['#00ff00', '#ff0000', '#00ffff', '#ff00ff', '#ffff00', '#ffffff', '#0000ff']
const MAX_PALETTE_COLORS_FROM_IMAGE = 32

/** Editor canvas is rendered at most this many units on the smaller axis to reduce memory; export uses full resolution. */
const EDITOR_MAX_DIM = 64

/**
 * @param {number} exportW
 * @param {number} exportH
 * @returns {{ w: number, h: number }}
 */
function getEditorSize(exportW, exportH) {
  const ew = Math.max(1, Math.min(4000, exportW))
  const eh = Math.max(1, Math.min(4000, exportH))
  const scale = Math.min(EDITOR_MAX_DIM / ew, EDITOR_MAX_DIM / eh)
  return { w: Math.max(1, Math.round(ew * scale)), h: Math.max(1, Math.round(eh * scale)) }
}

/**
 * Extract a color palette from an image by sampling pixels, quantizing to merge
 * similar colors, and returning the most frequent colors as hex strings.
 * @param {HTMLImageElement} image
 * @param {number} maxColors
 * @returns {Promise<string[]>}
 */
function extractPaletteFromImage(image, maxColors = MAX_PALETTE_COLORS_FROM_IMAGE) {
  return new Promise((resolve, reject) => {
    const maxDim = 256
    const w = image.naturalWidth
    const h = image.naturalHeight
    if (!w || !h) {
      reject(new Error('Image has no dimensions'))
      return
    }
    const scale = Math.min(1, maxDim / Math.max(w, h))
    const cw = Math.max(1, Math.round(w * scale))
    const ch = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) {
      reject(new Error('Could not get canvas context'))
      return
    }
    ctx.drawImage(image, 0, 0, cw, ch)
    let data
    try {
      data = ctx.getImageData(0, 0, cw, ch)
    } catch (e) {
      reject(e)
      return
    }
    const bins = new Map()
    const shift = 4
    const step = Math.max(1, Math.floor((cw * ch) / 20000))
    const totalPixels = cw * ch
    const minSaturation = 28
    for (let p = 0; p < totalPixels; p += step) {
      const i = p * 4
      const r = data.data[i]
      const g = data.data[i + 1]
      const b = data.data[i + 2]
      const a = data.data[i + 3]
      if (a < 128) continue
      const lo = Math.min(r, g, b)
      const hi = Math.max(r, g, b)
      if (hi - lo < minSaturation) continue
      const key = (r >> shift) << (2 * (8 - shift)) | (g >> shift) << (8 - shift) | (b >> shift)
      const existing = bins.get(key)
      if (existing) {
        existing.count++
        existing.rSum += r
        existing.gSum += g
        existing.bSum += b
      } else {
        bins.set(key, { count: 1, rSum: r, gSum: g, bSum: b })
      }
    }
    let list = Array.from(bins.entries())
      .map(([, v]) => ({
        count: v.count,
        r: Math.round(v.rSum / v.count),
        g: Math.round(v.gSum / v.count),
        b: Math.round(v.bSum / v.count),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, Math.max(maxColors, 64))

    const rgbDist = (a, b) =>
      Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)
    const mergeThreshold = 52

    while (list.length > 1) {
      let minD = Infinity
      let bestI = -1
      let bestJ = -1
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const d = rgbDist(list[i], list[j])
          if (d < minD) {
            minD = d
            bestI = i
            bestJ = j
          }
        }
      }
      if (minD >= mergeThreshold) break
      const a = list[bestI]
      const b = list[bestJ]
      const total = a.count + b.count
      const merged = {
        count: total,
        r: Math.round((a.r * a.count + b.r * b.count) / total),
        g: Math.round((a.g * a.count + b.g * b.count) / total),
        b: Math.round((a.b * a.count + b.b * b.count) / total),
      }
      list[bestI] = merged
      list.splice(bestJ, 1)
    }

    const quantizeChannel = (v) => Math.round(v / 17) * 17
    const saturation = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
    const hex = (n) => {
      const s = Math.max(0, Math.min(255, n)).toString(16)
      return s.length === 1 ? '0' + s : s
    }
    const out = []
    const seen = new Set()
    for (const c of list.slice(0, maxColors)) {
      if (saturation(c) < minSaturation) continue
      const q = {
        r: quantizeChannel(c.r),
        g: quantizeChannel(c.g),
        b: quantizeChannel(c.b),
      }
      const h = '#' + hex(q.r) + hex(q.g) + hex(q.b)
      if (seen.has(h)) continue
      seen.add(h)
      out.push(h)
    }
    resolve(out)
  })
}

function createNumberField(labelText, id, value, min, max) {
  const row = document.createElement('label')
  row.className = 'floor-plan-control'
  row.setAttribute('for', id)
  row.textContent = labelText
  const input = document.createElement('input')
  input.type = 'number'
  input.id = id
  input.min = String(min)
  input.max = String(max)
  input.step = '1'
  input.value = String(value)
  row.appendChild(input)
  return { row, input }
}

function createRangeField(labelText, id, value, min, max, step = 1) {
  const row = document.createElement('label')
  row.className = 'floor-plan-control'
  row.setAttribute('for', id)
  const label = document.createElement('span')
  label.textContent = labelText
  const readout = document.createElement('strong')
  readout.textContent = String(value)
  label.append(' ', readout)
  const input = document.createElement('input')
  input.type = 'range'
  input.id = id
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  input.addEventListener('input', () => {
    readout.textContent = input.value
  })
  row.append(label, input)
  return { row, input }
}

function readPositiveInt(input, fallback) {
  const n = Number(input.value)
  if (!Number.isFinite(n)) return fallback
  const v = Math.round(n)
  return v > 0 ? v : fallback
}

function readBoundedInt(input, fallback, min, max) {
  const n = Number(input.value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function randomSeed() {
  const words = new Uint32Array(2)
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(words)
  } else {
    words[0] = Math.floor(Math.random() * 0xffffffff)
    words[1] = Math.floor(Math.random() * 0xffffffff)
  }
  const mixed = (words[0] ^ words[1] ^ (Date.now() >>> 0)) >>> 0
  const hashed = ((mixed * 2654435761) ^ (mixed >>> 16)) >>> 0
  return Math.max(1, Math.min(MAX_SEED, hashed))
}

// Grid divisions so export matches workspace: ~12 major cells across, 5 fine per major (like 24/120 in screen space)
const EXPORT_GRID_MAJOR_DIVISIONS = 12
const EXPORT_GRID_FINE_PER_MAJOR = 5

/** Infer pattern name from a <pattern> element in the editor SVG so export matches what's displayed. */
function inferPatternFromDef(svgEl, patternId) {
  const pattern = svgEl.querySelector(`#${CSS.escape(patternId)}`)
  if (!pattern) return null
  const hasRotate = (pattern.getAttribute('patternTransform') || '').includes('rotate(45)')
  const lines = pattern.querySelectorAll('line')
  const rects = pattern.querySelectorAll('rect')
  const circles = pattern.querySelectorAll('circle')
  if (circles.length >= 1) return 'dots'
  if (lines.length === 1 && hasRotate) return 'hatch'
  if (lines.length >= 2) return 'cross-hatch'
  if (rects.length >= 2) return 'checkerboard'
  if (rects.length === 1) return 'stripes'
  return null
}

function getExportReadySvg(svgText, options = {}) {
  const { includeGrid = false, exportWidth, exportHeight } = options
  const parser = new DOMParser()
  let doc = parser.parseFromString(svgText, 'image/svg+xml')
  let svg = doc.querySelector('svg')
  if (!svg) return svgText
  const baseViewBoxRaw = svg.getAttribute('data-base-viewbox') || svg.getAttribute('viewBox')
  const vb = baseViewBoxRaw ? baseViewBoxRaw.trim().split(/\s+/).map(Number) : [0, 0, 64, 64]
  const [vx, vy, vw, vh] = vb.length >= 4 ? vb : [0, 0, 64, 64]
  // When exporting at full resolution, re-render with full-res stamp paths (strip editor paths so engine uses stampPath).
  // Preserve each stamp's visible fill: read the path's fill from the current SVG so export matches what's shown in the editor.
  if (exportWidth != null && exportHeight != null && Number(exportWidth) > 0 && Number(exportHeight) > 0) {
    const metadata = decodeSvgMetadata(svg)
    if (metadata && Array.isArray(metadata.shapes) && metadata.shapes.length > 0) {
      const shapesForExport = metadata.shapes.map((s) => {
        if (s.type !== 'stamp') return { ...s }
        const { stampPathEditor, stampWidthEditor, stampHeightEditor, ...rest } = s
        const group = svg.querySelector(`.art-shape[data-id="${s.id}"]`)
        const path = group?.querySelector('path')
        const fillAttr = path?.getAttribute('fill')?.trim()
        const isSolidColor = fillAttr && !fillAttr.startsWith('url(') && (fillAttr.startsWith('#') || fillAttr.startsWith('rgb'))
        if (isSolidColor) {
          return { ...rest, pattern: 'solid', color: fillAttr }
        }
        const urlMatch = fillAttr && fillAttr.match(/url\s*\(\s*#([^)]+)\s*\)/)
        const patternId = urlMatch?.[1]
        const inferred = patternId ? inferPatternFromDef(svg, patternId) : null
        const pattern = inferred || rest.pattern || 'solid'
        return { ...rest, pattern }
      })
      const grid = {
        meta: { width: vw, height: vh, seed: metadata.seed ?? 0, shapeCount: shapesForExport.length },
        shapes: shapesForExport,
        background: metadata.background ?? { color: '#000000', textureType: 'solid' },
      }
      const fullResSvgString = renderArtGridSvg(grid)
      doc = parser.parseFromString(fullResSvgString, 'image/svg+xml')
      svg = doc.querySelector('svg')
      if (!svg) return svgText
    }
  }
  svg.querySelectorAll('.canvas-boundary, #selection-outlines, .art-shape-hit-area, .hover-outline, #hover-outlines, #stamp-preview').forEach((el) => el.remove())
  // Ensure bg rect has solid black fill when missing (default; user config from Background tool is preserved)
  const bgRect = svg.querySelector('.bg')
  if (bgRect && (!bgRect.getAttribute('fill') || bgRect.getAttribute('fill').trim() === '')) {
    bgRect.setAttribute('fill', '#000000')
  }
  if (exportWidth != null && exportHeight != null && (Number(exportWidth) > 0 && Number(exportHeight) > 0)) {
    const ew = Math.round(Number(exportWidth))
    const eh = Math.round(Number(exportHeight))
    svg.setAttribute('width', String(ew))
    svg.setAttribute('height', String(eh))
    svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`)
    svg.setAttribute('data-base-viewbox', `0 0 ${vw} ${vh}`)
  }
  if (includeGrid) {
    // Per-axis spacing so we get exactly 12 even divisions and last line on the edge (no gaps/float errors)
    const majorSpacingX = vw / EXPORT_GRID_MAJOR_DIVISIONS
    const majorSpacingY = vh / EXPORT_GRID_MAJOR_DIVISIONS
    const fineSpacingX = majorSpacingX / EXPORT_GRID_FINE_PER_MAJOR
    const fineSpacingY = majorSpacingY / EXPORT_GRID_FINE_PER_MAJOR
    const ns = 'http://www.w3.org/2000/svg'
    const defs = svg.querySelector('defs') || (() => {
      const d = doc.createElementNS(ns, 'defs')
      svg.insertBefore(d, svg.firstChild)
      return d
    })()
    const pattern = doc.createElementNS(ns, 'pattern')
    pattern.setAttribute('id', 'export-grid-pattern')
    pattern.setAttribute('x', String(vx))
    pattern.setAttribute('y', String(vy))
    pattern.setAttribute('width', String(majorSpacingX))
    pattern.setAttribute('height', String(majorSpacingY))
    pattern.setAttribute('patternUnits', 'userSpaceOnUse')
    const strokeScale = Math.max(0.5, (vw + vh) / 3000)
    const fineStroke = Math.max(1, 0.25 * strokeScale)
    const majorStroke = Math.max(2.5, 1.2 * strokeScale)
    // Fine grid: interior lines only (thin, gray)
    for (let k = 1; k < EXPORT_GRID_FINE_PER_MAJOR; k++) {
      const ix = k * fineSpacingX
      const iy = k * fineSpacingY
      const lineV = doc.createElementNS(ns, 'line')
      lineV.setAttribute('x1', String(ix))
      lineV.setAttribute('y1', '0')
      lineV.setAttribute('x2', String(ix))
      lineV.setAttribute('y2', String(majorSpacingY))
      lineV.setAttribute('stroke', 'rgba(130,130,130,0.28)')
      lineV.setAttribute('stroke-width', String(fineStroke))
      pattern.appendChild(lineV)
      const lineH = doc.createElementNS(ns, 'line')
      lineH.setAttribute('x1', '0')
      lineH.setAttribute('y1', String(iy))
      lineH.setAttribute('x2', String(majorSpacingX))
      lineH.setAttribute('y2', String(iy))
      lineH.setAttribute('stroke', 'rgba(130,130,130,0.28)')
      lineH.setAttribute('stroke-width', String(fineStroke))
      pattern.appendChild(lineH)
    }
    defs.appendChild(pattern)
    const gridRect = doc.createElementNS(ns, 'rect')
    gridRect.setAttribute('x', String(vx))
    gridRect.setAttribute('y', String(vy))
    gridRect.setAttribute('width', String(vw))
    gridRect.setAttribute('height', String(vh))
    gridRect.setAttribute('fill', 'url(#export-grid-pattern)')
    gridRect.setAttribute('id', 'export-grid-layer')
    const gridGroup = doc.createElementNS(ns, 'g')
    gridGroup.setAttribute('id', 'export-grid-group')
    gridGroup.appendChild(gridRect)
    // Major grid: thicker, more opaque so large cells clearly encapsulate the small cells (match editor)
    const majorG = doc.createElementNS(ns, 'g')
    majorG.setAttribute('stroke', 'rgba(51,51,51,0.65)')
    majorG.setAttribute('stroke-width', String(majorStroke))
    for (let i = 0; i <= EXPORT_GRID_MAJOR_DIVISIONS; i++) {
      const x = vx + i * majorSpacingX
      const lineV = doc.createElementNS(ns, 'line')
      lineV.setAttribute('x1', String(x))
      lineV.setAttribute('y1', String(vy))
      lineV.setAttribute('x2', String(x))
      lineV.setAttribute('y2', String(vy + vh))
      majorG.appendChild(lineV)
    }
    for (let i = 0; i <= EXPORT_GRID_MAJOR_DIVISIONS; i++) {
      const y = vy + i * majorSpacingY
      const lineH = doc.createElementNS(ns, 'line')
      lineH.setAttribute('x1', String(vx))
      lineH.setAttribute('y1', String(y))
      lineH.setAttribute('x2', String(vx + vw))
      lineH.setAttribute('y2', String(y))
      majorG.appendChild(lineH)
    }
    gridGroup.appendChild(majorG)
    if (bgRect && bgRect.nextSibling) {
      svg.insertBefore(gridGroup, bgRect.nextSibling)
    } else {
      svg.appendChild(gridGroup)
    }
  }
  // Reset viewBox to full canvas so exported SVG fills the frame (not zoom/pan state)
  const baseViewBox = svg.getAttribute('data-base-viewbox')
  if (baseViewBox) svg.setAttribute('viewBox', baseViewBox)
  return new XMLSerializer().serializeToString(svg)
}

function downloadSvg(svgText, fileName = `art-grid-${Date.now()}.svg`) {
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

/** True when viewport is mobile-sized; use share sheet there, file-save dialog on desktop. */
function isMobileViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
}

/**
 * On mobile viewport, use Web Share API so the user can choose "Save Image" / "Add to Photos".
 * On desktop, use <a download> so the user gets the normal file-save dialog.
 * @param {Blob} blob
 * @param {string} mimeType
 * @param {string} fileName
 * @returns {Promise<void>}
 */
async function shareOrDownloadRaster(blob, mimeType, fileName) {
  const useShare = isMobileViewport() && typeof navigator.share === 'function'
  if (useShare) {
    const file = new File([blob], fileName, { type: mimeType })
    try {
      let canShare = false
      if (typeof navigator.canShare === 'function') {
        canShare = navigator.canShare({ files: [file] })
      } else {
        canShare = true
      }
      if (canShare) {
        await navigator.share({ files: [file] })
        return
      }
    } catch (err) {
      if (err?.name === 'AbortError') return
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function parseSvgDimensions(svgText) {
  const w = svgText.match(/width=["']?\s*([\d.]+)/)?.[1]
  const h = svgText.match(/height=["']?\s*([\d.]+)/)?.[1]
  if (w && h) return { w: Number(w), h: Number(h) }
  const vb = svgText.match(/viewBox=["']?\s*([\d.\s-]+)["']?/)?.[1]?.trim()?.split(/\s+/)
  if (vb && vb.length >= 4) return { w: Number(vb[2]), h: Number(vb[3]) }
  return { w: 1200, h: 1200 }
}

/**
 * @param {string} svgText SVG string (may have width/height at export resolution)
 * @param {string} mimeType
 * @param {string} extension
 * @param {string} [fileNameBase]
 * @returns {Promise<void>}
 */
function downloadSvgAsRaster(svgText, mimeType, extension, fileNameBase) {
  return new Promise((resolve, reject) => {
    const base = fileNameBase || `art-grid-${Date.now()}`
    const dims = parseSvgDimensions(svgText)
    // Rewrite pattern IDs so canvas drawImage resolves url(#...) inside the SVG, not the host page
    const rasterSvgText = svgText.replace(/\bid="pattern-(\d+)"/g, 'id="ag-raster-pattern-$1"').replace(/url\(#pattern-(\d+)\)/g, 'url(#ag-raster-pattern-$1)')
    const blob = new Blob([rasterSvgText], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = dims.w
      canvas.height = dims.h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve()
        return
      }
      ctx.drawImage(img, 0, 0, dims.w, dims.h)
      canvas.toBlob(
        async (outBlob) => {
          if (!outBlob) {
            resolve()
            return
          }
          await shareOrDownloadRaster(outBlob, mimeType, `${base}.${extension}`)
          resolve()
        },
        mimeType,
        mimeType === 'image/jpeg' ? 0.92 : undefined
      )
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load SVG for raster export'))
    }
    img.src = url
  })
}

function loadSettings() {
  const raw = window.localStorage.getItem(SETTINGS_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function parseViewBox(svgElement) {
  const raw = svgElement.getAttribute('viewBox')
  if (raw == null) return null
  const values = raw.trim().split(/\s+/).map(Number)
  if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) return null
  return { minX: values[0], minY: values[1], width: values[2], height: values[3] }
}

function parseViewBoxFromRaw(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const values = raw.trim().split(/\s+/).map(Number)
  if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) return null
  return { minX: values[0], minY: values[1], width: values[2], height: values[3] }
}

function readBaseViewBox(svgElement) {
  const raw = svgElement.getAttribute('data-base-viewbox')
  return parseViewBoxFromRaw(raw) ?? parseViewBox(svgElement)
}

export function mountArtGridTool(containerElement) {
  const previewContainer = containerElement?.previewContainer
  const controlsContainer = containerElement?.controlsContainer
  const entitiesContainer = containerElement?.entitiesContainer
  if (!previewContainer || !controlsContainer || !entitiesContainer) return
  if (previewContainer.dataset.mounted === 'true') return
  previewContainer.dataset.mounted = 'true'

  const saved = loadSettings()
  let latestSvg = ''
  /** @type {{ meta: { width: number, height: number, seed: number, shapeCount: number }, shapes: object[], background?: object } | null} */
  let currentGrid = null
  /** @type {{ minX: number, minY: number, width: number, height: number } | null} */
  let viewState = null
  let selectedShapeIds = new Set()
  let selectedLayer = null
  let dragState = null
  let hoveredShapeId = null
  /* Use a smaller undo limit on narrow viewports to avoid memory pressure and tab crashes on mobile */
  const MAX_UNDO =
    typeof window !== 'undefined' && window.innerWidth <= 768 ? 12 : 50
  const undoStack = []
  const redoStack = []
  let stateBeforeDrag = null
  let isGenerating = false
  let stampMode = false
  let stampShape = null
  let stampInvert = false // false = black is shape, true = white is shape
  let colorPalette = Array.isArray(saved?.colorPalette) && saved.colorPalette.length > 0
    ? [...saved.colorPalette]
    : []
  let background = {
    color: saved?.background?.color ?? '#000000',
    textureType: saved?.background?.textureType ?? 'solid',
    pattern: saved?.background?.pattern ?? 'dots',
    textureScale: saved?.background?.textureScale ?? 1,
    ...(saved?.background?.stampPath && {
      stampPath: saved.background.stampPath,
      stampWidth: saved.background.stampWidth,
      stampHeight: saved.background.stampHeight,
    }),
  }

  const preview = document.createElement('section')
  preview.className = 'floor-plan-preview'
  const previewContent = document.createElement('div')
  previewContent.className = 'floor-plan-preview-content'
  const loadingOverlay = document.createElement('div')
  loadingOverlay.className = 'ag-loading-overlay'
  loadingOverlay.setAttribute('aria-hidden', 'true')
  loadingOverlay.innerHTML = '<span class="ag-loading-overlay-spinner" aria-hidden="true"></span><span class="ag-loading-overlay-text">Generating dope throne grid…</span>'
  const loadingOverlayTextEl = loadingOverlay.querySelector('.ag-loading-overlay-text')
  const defaultLoadingOverlayText = 'Generating dope throne grid…'
  const canvasWrapper = document.createElement('div')
  canvasWrapper.className = 'color-palette-svg-wrapper'
  canvasWrapper.style.position = 'relative'
  canvasWrapper.style.width = '100%'
  canvasWrapper.style.height = '100%'
  canvasWrapper.style.minHeight = '200px'
  const canvasInner = document.createElement('div')
  canvasInner.className = 'ag-canvas-inner'
  canvasInner.style.position = 'relative'
  canvasInner.style.display = 'inline-block'
  const mainCanvas = document.createElement('canvas')
  mainCanvas.className = 'ag-main-canvas'
  mainCanvas.style.display = 'block'
  mainCanvas.setAttribute('aria-label', 'Generated dope throne grid')
  const overlayCanvas = document.createElement('canvas')
  overlayCanvas.className = 'ag-overlay-canvas'
  overlayCanvas.style.position = 'absolute'
  overlayCanvas.style.left = '0'
  overlayCanvas.style.top = '0'
  overlayCanvas.style.pointerEvents = 'none'
  canvasInner.appendChild(mainCanvas)
  canvasInner.appendChild(overlayCanvas)
  canvasWrapper.appendChild(canvasInner)
  previewContent.appendChild(loadingOverlay)
  previewContent.appendChild(canvasWrapper)
  preview.appendChild(previewContent)
  previewContainer.appendChild(preview)

  function getBaseViewBox() {
    if (!currentGrid) return null
    return { minX: 0, minY: 0, width: currentGrid.meta.width, height: currentGrid.meta.height }
  }

  function getCurrentViewTransform() {
    const base = getBaseViewBox()
    if (viewState) return viewState
    if (base) return base
    return { minX: 0, minY: 0, width: 400, height: 400 }
  }

  /** Convert client coordinates to scene coordinates using the overlay canvas (same size as main). */
  function toSceneCoords(clientX, clientY) {
    const el = overlayCanvas
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const vt = getCurrentViewTransform()
    const scaleX = vt.width / rect.width
    const scaleY = vt.height / rect.height
    return {
      x: vt.minX + (clientX - rect.left) * scaleX,
      y: vt.minY + (clientY - rect.top) * scaleY,
    }
  }

  function hitTestShapes(sceneX, sceneY) {
    if (!currentGrid || !currentGrid.shapes.length) return null
    const order = shapesHitTestOrder(currentGrid.shapes)
    for (const shape of order) {
      if (isPointInShape(shape, sceneX, sceneY)) return shape
    }
    return null
  }

  const refSize = 1200
  function getScaleFromGrid() {
    const base = getBaseViewBox()
    if (!base) return 1
    return Math.min(base.width, base.height) / refSize
  }

  function hitTestGizmos(sceneX, sceneY) {
    if (!currentGrid || selectedShapeIds.size === 0) return null
    const scale = getScaleFromGrid()
    const padding = Math.max(0.5, 1.5 * scale)
    const gizmoRadius = Math.max(1, 2 * scale)
    for (const id of selectedShapeIds) {
      const shape = currentGrid.shapes.find((s) => s.id === id)
      if (!shape) continue
      const outlineX = shape.x - shape.size / 2 - padding
      const outlineY = shape.y - shape.size / 2 - padding
      const outlineWidth = shape.size + padding * 2
      const outlineHeight = shape.size + padding * 2
      const rotateX = outlineX + outlineWidth
      const rotateY = outlineY
      if (Math.hypot(sceneX - rotateX, sceneY - rotateY) <= gizmoRadius * 2) return { kind: 'rotate', id }
      const scaleGizmoX = outlineX + outlineWidth
      const scaleGizmoY = outlineY + outlineHeight
      if (Math.abs(sceneX - scaleGizmoX) <= gizmoRadius * 2 && Math.abs(sceneY - scaleGizmoY) <= gizmoRadius * 2) return { kind: 'scale', id }
    }
    return null
  }

  function drawMainCanvas() {
    const cw = mainCanvas.width
    const ch = mainCanvas.height
    if (cw <= 0 || ch <= 0) return
    const ctx = mainCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cw, ch)
    if (!currentGrid) return
    const vt = getCurrentViewTransform()
    renderArtGridCanvas(currentGrid, ctx, vt, cw, ch)
  }

  function drawOverlayCanvas() {
    const cw = overlayCanvas.width
    const ch = overlayCanvas.height
    if (cw <= 0 || ch <= 0) return
    const ctx = overlayCanvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cw, ch)
    if (!currentGrid) return
    const vt = getCurrentViewTransform()
    const scaleX = cw / vt.width
    const scaleY = ch / vt.height
    ctx.save()
    ctx.setTransform(scaleX, 0, 0, scaleY, -vt.minX * scaleX, -vt.minY * scaleY)
    const scale = getScaleFromGrid()
    const padding = Math.max(0.5, 1.5 * scale)
    const outlineStrokeWidth = Math.max(0.25, 0.7 * scale)
    const outlineDashLen = Math.max(0.5, 2 * scale)
    const gizmoRadius = Math.max(1, 2 * scale)
    const base = getBaseViewBox()
    if (base) {
      const strokeWidth = Math.max(0.25, 1 * scale)
      const dashLen = Math.max(1, 6 * scale)
      const gapLen = Math.max(1, 4 * scale)
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.8)'
      ctx.lineWidth = strokeWidth
      ctx.setLineDash([dashLen, gapLen])
      ctx.strokeRect(strokeWidth / 2, strokeWidth / 2, base.width - strokeWidth, base.height - strokeWidth)
      ctx.setLineDash([])
    }
    selectedShapeIds.forEach((id) => {
      const shape = currentGrid.shapes.find((s) => s.id === id)
      if (!shape) return
      const x = shape.x - shape.size / 2 - padding
      const y = shape.y - shape.size / 2 - padding
      const w = shape.size + padding * 2
      const h = shape.size + padding * 2
      ctx.strokeStyle = '#00ffff'
      ctx.lineWidth = outlineStrokeWidth
      ctx.setLineDash([outlineDashLen, outlineDashLen])
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([])
      ctx.fillStyle = '#00ffff'
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = outlineStrokeWidth
      ctx.beginPath()
      ctx.arc(x + w, y, gizmoRadius, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = '#ffff00'
      ctx.fillRect(x + w - gizmoRadius, y + h - gizmoRadius, gizmoRadius * 2, gizmoRadius * 2)
      ctx.strokeStyle = '#ffffff'
      ctx.strokeRect(x + w - gizmoRadius, y + h - gizmoRadius, gizmoRadius * 2, gizmoRadius * 2)
    })
    if (hoveredShapeId && !selectedShapeIds.has(hoveredShapeId)) {
      const shape = currentGrid.shapes.find((s) => s.id === hoveredShapeId)
      if (shape) {
        const padding = Math.max(1, 2 * scale)
        const strokeWidth = Math.max(0.25, 0.8 * scale)
        const half = shape.size / 2
        ctx.strokeStyle = 'rgba(255, 105, 180, 0.9)'
        ctx.lineWidth = strokeWidth
        ctx.strokeRect(shape.x - half - padding, shape.y - half - padding, shape.size + padding * 2, shape.size + padding * 2)
      }
    }
    ctx.restore()
  }

  function redraw() {
    drawMainCanvas()
    drawOverlayCanvas()
  }

  function sizeCanvases() {
    const rect = canvasWrapper.getBoundingClientRect()
    const settingsW = readPositiveInt(width.input, 1200)
    const settingsH = readPositiveInt(height.input, 2400)
    const aspect = settingsW / Math.max(1, settingsH)
    const containerW = rect.width
    const containerH = rect.height
    let w, h
    if (containerW / Math.max(1, containerH) > aspect) {
      h = containerH
      w = containerH * aspect
    } else {
      w = containerW
      h = containerW / aspect
    }
    w = Math.max(1, Math.floor(w))
    h = Math.max(1, Math.floor(h))
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 3) || 1
    const wBacking = Math.max(1, Math.floor(w * dpr))
    const hBacking = Math.max(1, Math.floor(h * dpr))
    if (mainCanvas.width !== wBacking || mainCanvas.height !== hBacking) {
      mainCanvas.width = wBacking
      mainCanvas.height = hBacking
    }
    if (overlayCanvas.width !== wBacking || overlayCanvas.height !== hBacking) {
      overlayCanvas.width = wBacking
      overlayCanvas.height = hBacking
    }
    canvasInner.style.width = w + 'px'
    canvasInner.style.height = h + 'px'
    mainCanvas.style.width = w + 'px'
    mainCanvas.style.height = h + 'px'
    overlayCanvas.style.width = w + 'px'
    overlayCanvas.style.height = h + 'px'
    redraw()
  }

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => sizeCanvases()) : null
  if (resizeObserver) resizeObserver.observe(canvasWrapper)

  /** Set the current grid (source of truth) and redraw. Syncs latestSvg for export. */
  function setGrid(grid) {
    currentGrid = grid
    if (currentGrid) {
      if (!viewState) {
        const base = getBaseViewBox()
        viewState = base ? { ...base } : null
      }
      latestSvg = renderArtGridSvg(currentGrid)
    } else {
      latestSvg = ''
      viewState = null
    }
    sizeCanvases()
  }

  function syncLatestSvg() {
    if (currentGrid) latestSvg = renderArtGridSvg(currentGrid)
    else latestSvg = ''
  }

  const getColorsForGeneration = () =>
    colorPalette.length > 0 ? colorPalette : DEFAULT_COLORS
  
  // Click outside canvas: disable stamp mode and clear shape selection
  let setStampMode = null
  previewContent.addEventListener('click', (e) => {
    const clickedOnCanvas = e.target === mainCanvas || e.target === overlayCanvas

    if (!clickedOnCanvas) {
      if (!stampMode) {
        selectedShapeIds.clear()
        selectedLayer = null
        updateSelection()
      }
    }

    if (stampMode && selectedStampIndices.size > 1 && currentGrid && clickedOnCanvas) {
      const pt = toSceneCoords(e.clientX, e.clientY)
      if (pt) {
        const base = getBaseViewBox()
        if (base && pt.x >= 0 && pt.x <= base.width && pt.y >= 0 && pt.y <= base.height) {
          e.stopPropagation()
          e.preventDefault()
          selectedStampIndices.clear()
          stampShape = null
          updateStampThumbOutlines()
          updateSelectedStampsStrip()
          status.textContent = 'Stamps deselected.'
          return
        }
      }
    }

    if (stampMode && stampShape && currentGrid && clickedOnCanvas) {
      const pt = toSceneCoords(e.clientX, e.clientY)
      if (pt) {
        const base = getBaseViewBox()
        if (base && pt.x >= 0 && pt.x <= base.width && pt.y >= 0 && pt.y <= base.height) {
          e.stopPropagation()
          e.preventDefault()
          setLoadingOverlay(true, 'Placing stamp…')
          const prevBodyCursor = document.body.style.getPropertyValue('cursor') || document.body.style.cursor
          document.body.style.setProperty('cursor', 'wait', 'important')
          preview.classList.add('stamp-placing')
          document.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY, bubbles: true }))
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              try {
                pushUndoState()
                const colors = getColorsForGeneration()
                const randomColor = colors[Math.floor(Math.random() * colors.length)]
                const exportW = readPositiveInt(width.input, 1200)
                const exportH = readPositiveInt(height.input, 2400)
                const { w: stampW, h: stampH } = base ? { w: base.width, h: base.height } : getEditorSize(exportW, exportH)
                const editorScale = Math.min(stampW / exportW, stampH / exportH)
                const newShape = createStampShape(pt.x, pt.y, stampShape, randomColor, editorScale)
                currentGrid.shapes.push(newShape)
                currentGrid.meta.shapeCount = currentGrid.shapes.length
                syncLatestSvg()
                selectedShapeIds.clear()
                selectedShapeIds.add(newShape.id)
                redraw()
                updateSelection()
                bindCanvasInteractions()
                status.textContent = 'Stamp placed.'
              } finally {
                setLoadingOverlay(false)
                document.body.style.removeProperty('cursor')
                if (prevBodyCursor) document.body.style.cursor = prevBodyCursor
                preview.classList.remove('stamp-placing')
              }
            })
          })
          return
        }
      }
    }

    if (stampMode && !clickedOnCanvas && setStampMode) {
      setStampMode(false)
      status.textContent = 'Stamp mode disabled (clicked outside canvas).'
    }
  })

  const controls = document.createElement('div')
  controls.className = 'floor-plan-controls'

  const generateNewBtn = document.createElement('button')
  generateNewBtn.type = 'button'
  generateNewBtn.className = 'button ag-generate-new-btn'
  generateNewBtn.textContent = 'Generate'
  generateNewBtn.title = 'Generate a new dope throne grid'
  generateNewBtn.setAttribute('aria-label', 'Generate')
  controls.appendChild(generateNewBtn)
  
  const settingsContent = document.createElement('div')
  settingsContent.className = 'panel-content'
  
  const seed = createNumberField('Seed', 'ag-seed', saved?.seed ?? randomSeed(), 1, MAX_SEED)
  seed.row.style.display = 'none'
  const width = createNumberField('Canvas Width (px)', 'ag-width', saved?.width ?? 1200, 100, 4000)
  const height = createNumberField('Canvas Height (px)', 'ag-height', saved?.height ?? 2400, 100, 4000)
  const canvasSizeRow = document.createElement('div')
  canvasSizeRow.className = 'canvas-size-row'
  canvasSizeRow.append(width.row, height.row)
  width.input.addEventListener('change', () => sizeCanvases())
  height.input.addEventListener('change', () => sizeCanvases())
  const shapeCount = createRangeField('Shape density', 'ag-shapes', saved?.shapeCount ?? 80, 20, 300)
  const minSize = createRangeField('Min shape size', 'ag-min-size', saved?.minSize ?? 8, 2, 100)
  const maxSize = createRangeField('Max shape size', 'ag-max-size', saved?.maxSize ?? 120, 10, 300)
  const minTextureScale = createRangeField('Min texture scale', 'ag-min-texture', saved?.minTextureScale ?? 0.5, 0.1, 5, 0.1)
  const maxTextureScale = createRangeField('Max texture scale', 'ag-max-texture', saved?.maxTextureScale ?? 2, 0.1, 5, 0.1)
  const randomRotationLabel = document.createElement('label')
  randomRotationLabel.className = 'floor-plan-control'
  randomRotationLabel.style.display = 'flex'
  randomRotationLabel.style.alignItems = 'center'
  randomRotationLabel.style.gap = '8px'
  randomRotationLabel.style.cursor = 'pointer'
  const randomRotationCheckbox = document.createElement('input')
  randomRotationCheckbox.type = 'checkbox'
  randomRotationCheckbox.id = 'ag-random-rotation'
  randomRotationCheckbox.checked = saved?.randomRotation !== false
  randomRotationLabel.append(randomRotationCheckbox, document.createTextNode('Random rotation'))
  randomRotationLabel.setAttribute('for', 'ag-random-rotation')

  const spreadDefault = 1
  const spreadMin = 0.5
  const spreadMax = 2.5
  const spreadStep = 0.1
  const savedSpread = saved?.spread
  const spreadValue = savedSpread != null && savedSpread >= spreadMin && savedSpread <= spreadMax ? savedSpread : spreadDefault
  const spreadRow = createRangeField('Spread', 'ag-spread', spreadValue, spreadMin, spreadMax, spreadStep)
  spreadRow.input.title = 'How far from center shapes are placed; above 1 allows shapes to extend past the canvas and be cut off by the border'
  spreadRow.input.setAttribute('aria-label', 'Shape spread from center')

  const nudgeMin = 1
  const nudgeMax = 100
  const nudgeDefault = 10
  const savedNudge = saved?.nudgeAmount
  const nudgeValue = savedNudge != null && savedNudge >= nudgeMin && savedNudge <= nudgeMax ? savedNudge : nudgeDefault
  const nudgeRow = createRangeField('Arrow nudge (px)', 'ag-nudge', nudgeValue, nudgeMin, nudgeMax, 1)
  nudgeRow.input.title = 'Distance to move the selected shape when using arrow keys'
  nudgeRow.input.setAttribute('aria-label', 'Arrow key nudge distance in pixels')

  const scaleStepMin = 1
  const scaleStepMax = 50
  const scaleStepDefault = 10
  const savedScaleStep = saved?.scaleStep
  const scaleStepValue = savedScaleStep != null && savedScaleStep >= scaleStepMin && savedScaleStep <= scaleStepMax ? savedScaleStep : scaleStepDefault
  const scaleStepRow = createRangeField('Scale step (px)', 'ag-scale-step', scaleStepValue, scaleStepMin, scaleStepMax, 1)
  scaleStepRow.input.title = 'Size change when using Cmd/Ctrl + Plus or Minus on selected shape(s)'
  scaleStepRow.input.setAttribute('aria-label', 'Scale step in pixels')

  // Background layer controls (own tab)
  const bgSection = document.createElement('div')
  bgSection.className = 'floor-plan-control'
  const bgLabel = document.createElement('div')
  bgLabel.textContent = 'Background'
  bgLabel.style.marginBottom = '8px'
  bgLabel.style.fontWeight = 'bold'
  const bgColorRow = document.createElement('label')
  bgColorRow.className = 'floor-plan-control'
  bgColorRow.style.display = 'flex'
  bgColorRow.style.alignItems = 'center'
  bgColorRow.style.gap = '8px'
  bgColorRow.innerHTML = '<span>Color:</span>'
  const bgColorInput = document.createElement('input')
  bgColorInput.type = 'color'
  bgColorInput.value = background.color
  bgColorInput.style.width = '48px'
  bgColorInput.style.height = '28px'
  bgColorInput.style.padding = '2px'
  bgColorInput.style.cursor = 'pointer'
  bgColorRow.appendChild(bgColorInput)
  const bgHexInput = document.createElement('input')
  bgHexInput.type = 'text'
  bgHexInput.value = background.color
  bgHexInput.setAttribute('aria-label', 'Background hex code')
  bgHexInput.style.width = '7em'
  bgHexInput.style.fontFamily = 'monospace'
  bgColorRow.appendChild(bgHexInput)
  const parseBgHex = (raw) => {
    const s = raw.trim().replace(/^#/, '')
    if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase()
    if (/^[0-9a-fA-F]{3}$/.test(s)) return '#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
    return null
  }
  const applyBgHexFromInput = () => {
    const parsed = parseBgHex(bgHexInput.value)
    if (parsed) {
      background.color = parsed
      bgColorInput.value = parsed
      bgHexInput.value = parsed
      scheduleDeferredApplyBackground(true)
    } else {
      bgHexInput.value = bgColorInput.value
    }
  }
  bgHexInput.addEventListener('change', applyBgHexFromInput)
  bgHexInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      applyBgHexFromInput()
      bgHexInput.blur()
    }
  })
  const bgTypeRow = document.createElement('div')
  bgTypeRow.className = 'bg-type-row'
  bgTypeRow.style.display = 'flex'
  bgTypeRow.style.flexDirection = 'column'
  bgTypeRow.style.gap = '6px'
  bgTypeRow.style.marginTop = '6px'
  const bgTypeSolid = document.createElement('button')
  bgTypeSolid.type = 'button'
  bgTypeSolid.className = 'mode-gizmo-btn bg-type-btn'
  bgTypeSolid.textContent = 'Solid'
  bgTypeSolid.title = 'Solid color background'
  const bgTypePattern = document.createElement('button')
  bgTypePattern.type = 'button'
  bgTypePattern.className = 'mode-gizmo-btn bg-type-btn'
  bgTypePattern.textContent = 'Pattern'
  bgTypePattern.title = 'Texture pattern background'
  const bgTypeStamp = document.createElement('button')
  bgTypeStamp.type = 'button'
  bgTypeStamp.className = 'mode-gizmo-btn bg-type-btn'
  bgTypeStamp.textContent = 'Stamp'
  bgTypeStamp.title = 'Use selected stamp as tiled background'
  bgTypeRow.append(bgTypeSolid, bgTypePattern, bgTypeStamp)
  const bgPatternRow = document.createElement('div')
  bgPatternRow.style.display = 'none'
  bgPatternRow.style.marginTop = '6px'
  bgPatternRow.style.gap = '6px'
  bgPatternRow.style.flexWrap = 'wrap'
  bgPatternRow.style.alignItems = 'center'
  const bgRandomBtn = document.createElement('button')
  bgRandomBtn.type = 'button'
  bgRandomBtn.className = 'button'
  bgRandomBtn.textContent = 'Randomize pattern'
  bgRandomBtn.style.marginRight = '8px'
  const bgPatternSelect = document.createElement('select')
  PATTERNS.forEach((p) => {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p.charAt(0).toUpperCase() + p.slice(1)
    bgPatternSelect.appendChild(opt)
  })
  bgPatternSelect.value = background.pattern
  bgPatternRow.append(bgRandomBtn, bgPatternSelect)
  const bgTextureScaleRow = createRangeField('Texture scale', 'ag-bg-texture-scale', background.textureScale ?? 1, 0.2, 5, 0.1)
  bgTextureScaleRow.row.style.marginTop = '8px'
  bgTextureScaleRow.row.style.display = 'none'
  bgTextureScaleRow.input.addEventListener('input', () => {
    background.textureScale = parseFloat(bgTextureScaleRow.input.value) || 1
    bgTextureScaleRow.row.querySelector('strong').textContent = bgTextureScaleRow.input.value
  })
  bgTextureScaleRow.input.addEventListener('change', () => {
    background.textureScale = parseFloat(bgTextureScaleRow.input.value) || 1
    scheduleDeferredApplyBackground(true)
  })
  const bgStampRow = document.createElement('div')
  bgStampRow.style.display = 'none'
  bgStampRow.style.marginTop = '6px'
  const bgUseStampBtn = document.createElement('button')
  bgUseStampBtn.type = 'button'
  bgUseStampBtn.className = 'button'
  bgUseStampBtn.textContent = 'Use selected stamp'
  bgStampRow.appendChild(bgUseStampBtn)
  const updateBgTypeUI = () => {
    bgTypeSolid.classList.toggle('is-active', background.textureType === 'solid')
    bgTypePattern.classList.toggle('is-active', background.textureType === 'pattern')
    bgTypeStamp.classList.toggle('is-active', background.textureType === 'stamp')
    const showPattern = background.textureType === 'pattern'
    const showStamp = background.textureType === 'stamp'
    bgPatternRow.style.display = showPattern ? 'flex' : 'none'
    bgPatternRow.style.flexDirection = 'column'
    bgTextureScaleRow.row.style.display = showPattern || showStamp ? 'block' : 'none'
    bgStampRow.style.display = showStamp ? 'block' : 'none'
  }
  updateBgTypeUI()
  bgColorInput.addEventListener('input', () => {
    background.color = bgColorInput.value
    bgHexInput.value = bgColorInput.value
  })
  bgColorInput.addEventListener('change', () => {
    background.color = bgColorInput.value
    bgHexInput.value = bgColorInput.value
    scheduleDeferredApplyBackground(true)
  })
  bgTypeSolid.addEventListener('click', () => {
    background.textureType = 'solid'
    updateBgTypeUI()
    scheduleDeferredApplyBackground(true)
  })
  bgTypePattern.addEventListener('click', () => {
    background.textureType = 'pattern'
    background.pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)]
    const colors = getColorsForGeneration()
    if (!background.color && colors.length > 0) {
      background.color = colors[Math.floor(Math.random() * colors.length)]
      bgColorInput.value = background.color
      bgHexInput.value = background.color
    }
    bgPatternSelect.value = background.pattern
    updateBgTypeUI()
    scheduleDeferredApplyBackground(true)
  })
  bgTypeStamp.addEventListener('click', () => {
    background.textureType = 'stamp'
    updateBgTypeUI()
    scheduleDeferredApplyBackground(true)
  })
  bgPatternSelect.addEventListener('change', () => {
    background.pattern = bgPatternSelect.value
    scheduleDeferredApplyBackground(true)
  })
  bgRandomBtn.addEventListener('click', () => {
    background.pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)]
    bgPatternSelect.value = background.pattern
    const colors = getColorsForGeneration()
    background.color = colors[Math.floor(Math.random() * colors.length)]
    bgColorInput.value = background.color
    bgHexInput.value = background.color
    scheduleDeferredApplyBackground(true)
  })
  bgUseStampBtn.addEventListener('click', () => {
    if (!stampShape) {
      showToast('Select a stamp first')
      return
    }
    const svgPath = bitmapToSvgPath(stampShape.canvas, stampInvert)
    background.stampPath = svgPath
    background.stampWidth = stampShape.width
    background.stampHeight = stampShape.height
    background.color = getColorsForGeneration()[0]
    bgColorInput.value = background.color
    bgHexInput.value = background.color
    scheduleDeferredApplyBackground(true)
    showToast('Stamp set as background')
  })
  bgSection.append(bgLabel, bgColorRow, bgTypeRow, bgPatternRow, bgTextureScaleRow.row, bgStampRow)

  const getBackground = () => ({ ...background })
  function applyBackground(pushUndo = true) {
    if (!currentGrid) return
    if (pushUndo) pushUndoState()
    currentGrid.background = getBackground()
    syncLatestSvg()
    redraw()
    bindCanvasInteractions()
  }
  const backgroundUpdateOverlayMessage = 'Updating background…'
  let deferredApplyBackgroundScheduled = false
  function scheduleDeferredApplyBackground(pushUndo) {
    if (deferredApplyBackgroundScheduled) return
    deferredApplyBackgroundScheduled = true
    setLoadingOverlay(true, backgroundUpdateOverlayMessage)
    setTimeout(() => {
      try {
        applyBackground(pushUndo)
      } finally {
        deferredApplyBackgroundScheduled = false
        setLoadingOverlay(false)
      }
    }, 0)
  }

  settingsContent.append(
    seed.row,
    canvasSizeRow,
    shapeCount.row,
    spreadRow.row,
    nudgeRow.row,
    scaleStepRow.row,
    minSize.row,
    maxSize.row,
    minTextureScale.row,
    maxTextureScale.row,
    randomRotationLabel
  )
  
  // Stamp tool content
  const stampContent = document.createElement('div')
  stampContent.className = 'panel-content'
  
  // Scrollable grid of stamp thumbnails (filled by loadStampsFromFolder)
  const stampGridContainer = document.createElement('div')
  stampGridContainer.className = 'stamp-grid'
  stampGridContainer.style.display = 'grid'
  stampGridContainer.style.gridTemplateColumns = 'repeat(4, 1fr)'
  stampGridContainer.style.columnGap = '32px'
  stampGridContainer.style.rowGap = '32px'
  stampGridContainer.style.maxHeight = '200px'
  stampGridContainer.style.overflowY = 'auto'
  stampGridContainer.style.padding = '2px'
  stampGridContainer.style.border = '1px solid var(--tui-line-strong)'
  stampGridContainer.style.marginBottom = '8px'
  
  // Stamp controls
  const stampControls = document.createElement('div')
  stampControls.style.marginTop = '8px'
  
  const invertToggle = document.createElement('label')
  invertToggle.style.display = 'flex'
  invertToggle.style.alignItems = 'center'
  invertToggle.style.gap = '8px'
  const invertCheckbox = document.createElement('input')
  invertCheckbox.type = 'checkbox'
  invertToggle.append(invertCheckbox, 'Invert (white = shape)')
  
  const stampScaleRow = createRangeField(
    'Stamp scale:',
    'ag-stamp-scale',
    saved?.stampScale ?? 0.25,
    0.05,
    2,
    0.05
  )
  stampScaleRow.row.style.marginTop = '8px'

  const stampTextureRow = document.createElement('div')
  stampTextureRow.style.marginTop = '8px'
  const stampTextureLabel = document.createElement('label')
  stampTextureLabel.textContent = 'Texture:'
  stampTextureLabel.style.display = 'block'
  stampTextureLabel.style.marginBottom = '4px'
  const stampTextureSelect = document.createElement('select')
  stampTextureSelect.title = 'Texture pattern for placed stamps'
  stampTextureSelect.setAttribute('aria-label', 'Stamp texture pattern')
  const stampTextureOptions = ['solid', ...PATTERNS]
  stampTextureOptions.forEach((p) => {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p === 'solid' ? 'Solid' : p.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('-')
    stampTextureSelect.appendChild(opt)
  })
  stampTextureSelect.value = saved?.stampPattern ?? 'solid'
  stampTextureRow.append(stampTextureLabel, stampTextureSelect)

  const selectedStampsStrip = document.createElement('div')
  selectedStampsStrip.className = 'selected-stamps-strip'
  selectedStampsStrip.style.display = 'flex'
  selectedStampsStrip.style.flexDirection = 'row'
  selectedStampsStrip.style.gap = '6px'
  selectedStampsStrip.style.overflowX = 'auto'
  selectedStampsStrip.style.padding = '8px 0'
  selectedStampsStrip.style.marginTop = '8px'
  selectedStampsStrip.style.minHeight = '52px'
  selectedStampsStrip.style.border = '2px solid var(--tui-line-strong)'
  selectedStampsStrip.style.borderRadius = '4px'
  selectedStampsStrip.setAttribute('aria-label', 'Selected stamps')

  function updateSelectedStampsStrip() {
    selectedStampsStrip.innerHTML = ''
    const indices = [...selectedStampIndices].sort((a, b) => a - b)
    indices.forEach((idx) => {
      const entry = loadedStamps[idx]
      if (!entry) return
      const cell = document.createElement('div')
      cell.style.flexShrink = '0'
      cell.style.width = '48px'
      cell.style.height = '48px'
      cell.style.display = 'flex'
      cell.style.alignItems = 'center'
      cell.style.justifyContent = 'center'
      cell.style.background = '#333'
      cell.style.borderRadius = '4px'
      const c = document.createElement('canvas')
      c.width = 48
      c.height = 48
      c.style.imageRendering = 'pixelated'
      c.style.borderRadius = '4px'
      const ctx = c.getContext('2d')
      if (ctx) {
        ctx.imageSmoothingEnabled = false
        ctx.fillStyle = '#333'
        ctx.fillRect(0, 0, 48, 48)
        const s = Math.min(48 / entry.width, 48 / entry.height)
        const tw = entry.width * s
        const th = entry.height * s
        ctx.drawImage(entry.canvas, (48 - tw) / 2, (48 - th) / 2, tw, th)
      }
      cell.appendChild(c)
      selectedStampsStrip.appendChild(cell)
    })
  }

  stampControls.append(invertToggle, stampScaleRow.row, stampTextureRow, selectedStampsStrip)
  stampContent.append(stampGridContainer, stampControls)
  
  const paletteContent = document.createElement('div')
  paletteContent.className = 'panel-content'
  const paletteListEl = document.createElement('ul')
  paletteListEl.className = 'color-palette-list'
  const paletteAddBtn = document.createElement('button')
  paletteAddBtn.type = 'button'
  paletteAddBtn.textContent = 'Add color'
  paletteAddBtn.style.marginTop = '8px'
  paletteAddBtn.style.width = '100%'
  const paletteImportInput = document.createElement('input')
  paletteImportInput.type = 'file'
  paletteImportInput.accept = 'image/*'
  paletteImportInput.style.display = 'none'
  const paletteImportBtn = document.createElement('button')
  paletteImportBtn.type = 'button'
  paletteImportBtn.className = 'button'
  paletteImportBtn.textContent = 'Import from image'
  paletteImportBtn.style.marginTop = '8px'
  paletteImportBtn.style.width = '100%'
  paletteImportBtn.setAttribute('aria-label', 'Import color palette from an image file')
  paletteImportBtn.addEventListener('click', () => paletteImportInput.click())
  paletteImportInput.addEventListener('change', async () => {
    const file = paletteImportInput.files?.[0]
    paletteImportInput.value = ''
    if (!file) return
    const url = URL.createObjectURL(file)
    paletteImportBtn.disabled = true
    showToast('Reading hex codes…')
    try {
      let colors = await extractHexCodesFromImage(file)
      if (colors.length === 0) {
        const img = await new Promise((resolve, reject) => {
          const i = new Image()
          i.onload = () => resolve(i)
          i.onerror = () => reject(new Error('Could not load image'))
          i.src = url
        })
        colors = await extractPaletteFromImage(img, MAX_PALETTE_COLORS_FROM_IMAGE)
        if (colors.length === 0) {
          showToast('No hex codes or colors could be extracted from the image')
          return
        }
        showToast(`No hex codes found; extracted ${colors.length} colors from image`)
      } else {
        showToast(`Imported ${colors.length} hex codes from image`)
      }
      colorPalette.length = 0
      colorPalette.push(...colors)
      renderPaletteList()
      persistSettings(stats?.textContent ?? '')
    } catch (err) {
      showToast(err?.message ?? 'Failed to import palette from image')
    } finally {
      paletteImportBtn.disabled = false
      URL.revokeObjectURL(url)
    }
  })
  const paletteClearAllBtn = document.createElement('button')
  paletteClearAllBtn.type = 'button'
  paletteClearAllBtn.className = 'button'
  paletteClearAllBtn.textContent = 'Clear all colors'
  paletteClearAllBtn.style.marginTop = '8px'
  paletteClearAllBtn.style.width = '100%'
  paletteClearAllBtn.setAttribute('aria-label', 'Remove all colors from the palette')
  paletteClearAllBtn.addEventListener('click', () => {
    if (colorPalette.length === 0) return
    if (!window.confirm('Remove all colors from the palette? Generation will use default colors until you add or import new ones.')) return
    colorPalette.length = 0
    renderPaletteList()
    persistSettings(stats?.textContent ?? '')
    showToast('Palette cleared')
  })
  const paletteHint = document.createElement('p')
  paletteHint.className = 'floor-plan-status'
  paletteHint.style.margin = '8px 0 0'
  paletteHint.textContent = 'Define colors used when generating shapes. Leave empty to use default colors.'
  paletteContent.append(paletteListEl, paletteAddBtn, paletteImportBtn, paletteClearAllBtn, paletteImportInput, paletteHint)

  function renderPaletteList() {
    paletteListEl.innerHTML = ''
    colorPalette.forEach((color, i) => {
      const li = document.createElement('li')
      li.className = 'color-palette-list-item'
      const colorInput = document.createElement('input')
      colorInput.type = 'color'
      colorInput.value = color
      colorInput.className = 'color-palette-picker'
      const hexInput = document.createElement('input')
      hexInput.type = 'text'
      hexInput.value = color
      hexInput.className = 'color-palette-hex'
      hexInput.setAttribute('aria-label', 'Hex code')
      hexInput.style.width = '7em'
      hexInput.style.fontFamily = 'monospace'
      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.textContent = '📋'
      copyBtn.setAttribute('aria-label', 'Copy hex code to clipboard')
      copyBtn.title = 'Copy hex code'
      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.textContent = '🗑️'
      deleteBtn.setAttribute('aria-label', 'Delete color')
      deleteBtn.title = 'Delete color'
      deleteBtn.style.marginLeft = 'auto'
      li.append(colorInput, hexInput, copyBtn, deleteBtn)
      li.style.cursor = 'pointer'
      const parseHex = (raw) => {
        const s = raw.trim().replace(/^#/, '')
        if (/^[0-9a-fA-F]{6}$/.test(s)) return '#' + s.toLowerCase()
        if (/^[0-9a-fA-F]{3}$/.test(s)) {
          return '#' + s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
        }
        return null
      }
      const applyHexFromInput = () => {
        const parsed = parseHex(hexInput.value)
        if (parsed) {
          colorPalette[i] = parsed
          colorInput.value = parsed
          hexInput.value = parsed
          persistSettings(stats?.textContent ?? '')
        } else {
          hexInput.value = colorInput.value
        }
      }
      li.addEventListener('click', (e) => {
        if (e.target === deleteBtn || e.target === copyBtn || e.target === hexInput) return
        colorInput.click()
      })
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const hex = colorInput.value
        navigator.clipboard.writeText(hex).then(
          () => showToast('Copied ' + hex + ' to clipboard'),
          () => showToast('Could not copy to clipboard')
        )
      })
      colorInput.addEventListener('input', () => {
        colorPalette[i] = colorInput.value
        hexInput.value = colorInput.value
      })
      colorInput.addEventListener('change', () => {
        colorPalette[i] = colorInput.value
        hexInput.value = colorInput.value
        persistSettings(stats?.textContent ?? '')
      })
      hexInput.addEventListener('change', applyHexFromInput)
      hexInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          applyHexFromInput()
          hexInput.blur()
        }
      })
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        colorPalette.splice(i, 1)
        renderPaletteList()
        persistSettings(stats?.textContent ?? '')
      })
      paletteListEl.appendChild(li)
    })
    if (colorPalette.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'floor-plan-entity-empty'
      empty.textContent = 'No colors. Add colors or leave empty for defaults.'
      paletteListEl.appendChild(empty)
    }
    paletteClearAllBtn.disabled = colorPalette.length === 0
  }
  paletteAddBtn.addEventListener('click', () => {
    colorPalette.push('#808080')
    renderPaletteList()
    persistSettings(stats?.textContent ?? '')
  })
  renderPaletteList()
  
  const stampsPanel = document.createElement('div')
  stampsPanel.className = 'panel collapsed'
  const stampsHeader = document.createElement('button')
  stampsHeader.className = 'panel-header'
  stampsHeader.type = 'button'
  stampsHeader.innerHTML = '<span class="panel-chevron">▼</span>Stamps'
  stampsHeader.addEventListener('click', () => stampsPanel.classList.toggle('collapsed'))
  stampsPanel.append(stampsHeader, stampContent)

  const settingsPanel = document.createElement('div')
  settingsPanel.className = 'panel collapsed'
  const settingsHeader = document.createElement('button')
  settingsHeader.className = 'panel-header'
  settingsHeader.type = 'button'
  settingsHeader.innerHTML = '<span class="panel-chevron">▼</span>Settings'
  settingsHeader.addEventListener('click', () => settingsPanel.classList.toggle('collapsed'))
  settingsPanel.append(settingsHeader, settingsContent)

  const colorsPanel = document.createElement('div')
  colorsPanel.className = 'panel collapsed'
  const colorsHeader = document.createElement('button')
  colorsHeader.className = 'panel-header'
  colorsHeader.type = 'button'
  colorsHeader.innerHTML = '<span class="panel-chevron">▼</span>Colors'
  colorsHeader.addEventListener('click', () => colorsPanel.classList.toggle('collapsed'))
  colorsPanel.append(colorsHeader, paletteContent)

  const backgroundPanelContent = document.createElement('div')
  backgroundPanelContent.className = 'panel-content'
  backgroundPanelContent.append(bgSection)
  const backgroundPanel = document.createElement('div')
  backgroundPanel.className = 'panel collapsed'
  const backgroundHeader = document.createElement('button')
  backgroundHeader.className = 'panel-header'
  backgroundHeader.type = 'button'
  backgroundHeader.innerHTML = '<span class="panel-chevron">▼</span>Background'
  backgroundHeader.addEventListener('click', () => backgroundPanel.classList.toggle('collapsed'))
  backgroundPanel.append(backgroundHeader, backgroundPanelContent)

  controls.append(stampsPanel, settingsPanel, colorsPanel, backgroundPanel)

  const randomizeBtn = document.createElement('button')
  randomizeBtn.type = 'button'
  randomizeBtn.id = 'ag-randomize-seed'
  randomizeBtn.className = 'mode-gizmo-btn'
  randomizeBtn.title = 'Generate a new dope throne grid'
  randomizeBtn.setAttribute('aria-label', 'Generate dope throne grid')
  randomizeBtn.textContent = '🔄'
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.id = 'ag-save-svg'
  saveBtn.className = 'mode-gizmo-btn'
  saveBtn.title = 'Export – SVG, JPEG, PNG, or all'
  saveBtn.setAttribute('aria-label', 'Export dope throne grid')
  saveBtn.textContent = '📥'
  const saveDropdown = document.createElement('div')
  saveDropdown.className = 'save-export-dropdown'
  saveDropdown.style.display = 'none'
  saveDropdown.style.position = 'absolute'
  saveDropdown.style.top = '100%'
  saveDropdown.style.right = '0'
  saveDropdown.style.marginTop = '4px'
  saveDropdown.style.background = 'var(--tui-bg, #111)'
  saveDropdown.style.border = '2px solid var(--tui-line-strong)'
  saveDropdown.style.borderRadius = 'var(--tui-radius, 4px)'
  saveDropdown.style.padding = '4px'
  saveDropdown.style.zIndex = '1001'
  saveDropdown.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)'
  const includeGridLabel = document.createElement('label')
  includeGridLabel.style.display = 'flex'
  includeGridLabel.style.alignItems = 'center'
  includeGridLabel.style.gap = '8px'
  includeGridLabel.style.marginBottom = '8px'
  includeGridLabel.style.cursor = 'pointer'
  const includeGridCheckbox = document.createElement('input')
  includeGridCheckbox.type = 'checkbox'
  includeGridCheckbox.id = 'ag-export-include-grid'
  includeGridCheckbox.setAttribute('aria-label', 'Include background grid in export')
  includeGridLabel.append(includeGridCheckbox, document.createTextNode('Include background grid'))
  includeGridLabel.setAttribute('for', 'ag-export-include-grid')
  saveDropdown.appendChild(includeGridLabel)
  ;['Export SVG', 'Export JPEG', 'Export PNG', 'Export all three'].forEach((label) => {
    const opt = document.createElement('button')
    opt.type = 'button'
    opt.className = 'button'
    opt.style.display = 'block'
    opt.style.width = '100%'
    opt.style.textAlign = 'left'
    opt.style.marginBottom = '2px'
    opt.textContent = label
    saveDropdown.appendChild(opt)
  })
  const saveWrap = document.createElement('div')
  saveWrap.style.position = 'relative'
  saveWrap.append(saveBtn, saveDropdown)

  const status = document.createElement('p')
  status.className = 'floor-plan-status'
  status.textContent = 'Generate a dope throne grid.'
  const stats = document.createElement('p')
  stats.className = 'floor-plan-stats'
  stats.textContent = saved?.statsText ?? ''
  controlsContainer.appendChild(controls)

  const app = document.getElementById('app')
  const statusStatsWrap = document.createElement('div')
  statusStatsWrap.className = 'floor-plan-status-stats'
  statusStatsWrap.append(status, stats)
  if (app) app.appendChild(statusStatsWrap)

  // Mode toolbar (selection, stamp, center, generate, save)
  const modeToolbar = document.createElement('div')
  modeToolbar.className = 'mode-toolbar'
  const transformIcon = document.createElement('button')
  transformIcon.type = 'button'
  transformIcon.className = 'mode-gizmo-btn is-active'
  transformIcon.title = 'Selection – Select, drag, rotate, and scale shapes'
  transformIcon.setAttribute('aria-label', 'Selection mode')
  transformIcon.textContent = '✊'
  const stampIcon = document.createElement('button')
  stampIcon.type = 'button'
  stampIcon.className = 'mode-gizmo-btn'
  stampIcon.title = 'Stamp – Place stamp shapes on the canvas'
  stampIcon.setAttribute('aria-label', 'Stamp mode')
  stampIcon.textContent = '📌'
  const centerCameraBtn = document.createElement('button')
  centerCameraBtn.type = 'button'
  centerCameraBtn.className = 'mode-gizmo-btn'
  centerCameraBtn.title = 'Center view – Reset camera to show full canvas'
  centerCameraBtn.setAttribute('aria-label', 'Center camera on canvas')
  centerCameraBtn.textContent = '📍'
  modeToolbar.append(transformIcon, stampIcon, centerCameraBtn, randomizeBtn, saveWrap)
  if (app) app.appendChild(modeToolbar)

  const closeSaveDropdown = () => {
    saveDropdown.style.display = 'none'
  }
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!latestSvg) {
      status.textContent = 'Generate a dope throne grid before saving.'
      return
    }
    saveDropdown.style.display = saveDropdown.style.display === 'none' ? 'block' : 'none'
  })
  const runExport = (which) => {
    closeSaveDropdown()
    syncLatestSvg()
    setLoadingOverlay(true, 'Exporting…')
    setTimeout(async () => {
      try {
        const exportW = readPositiveInt(width.input, 1200)
        const exportH = readPositiveInt(height.input, 2400)
        const includeGrid = includeGridCheckbox.checked
        const svgText = getExportReadySvg(latestSvg, { includeGrid, exportWidth: exportW, exportHeight: exportH })
        const base = `art-grid-${Date.now()}`
        if (which === 'svg') {
          downloadSvg(svgText, `${base}.svg`)
          status.textContent = 'SVG downloaded.'
        } else if (which === 'jpeg') {
          await downloadSvgAsRaster(svgText, 'image/jpeg', 'jpg', base)
          status.textContent = 'JPEG downloaded.'
        } else if (which === 'png') {
          await downloadSvgAsRaster(svgText, 'image/png', 'png', base)
          status.textContent = 'PNG downloaded.'
        } else {
          downloadSvg(svgText, `${base}.svg`)
          await downloadSvgAsRaster(svgText, 'image/jpeg', 'jpg', base)
          await downloadSvgAsRaster(svgText, 'image/png', 'png', base)
          status.textContent = 'SVG, JPEG, and PNG downloaded.'
        }
    } catch (err) {
      status.textContent = `Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`
    } finally {
      setLoadingOverlay(false)
    }
    }, 0)
  }
  saveDropdown.querySelectorAll('button').forEach((opt, idx) => {
    opt.addEventListener('click', () => {
      runExport(idx === 0 ? 'svg' : idx === 1 ? 'jpeg' : idx === 2 ? 'png' : 'all')
    })
  })
  document.addEventListener('click', (e) => {
    if (!saveWrap.contains(e.target)) closeSaveDropdown()
  })

  const updateModeUI = () => {
    transformIcon.classList.toggle('is-active', !stampMode)
    stampIcon.classList.toggle('is-active', stampMode)
  }
  setStampMode = (enabled) => {
    stampMode = enabled
    preview.classList.toggle('stamp-mode', stampMode)
    updateModeUI()
    if (stampMode && stampShape) {
      status.textContent = 'Stamp mode active. Click on canvas to place shape.'
    } else if (stampMode) {
      status.textContent = 'Select a stamp first.'
    } else {
      status.textContent = 'Stamp mode disabled.'
    }
  }
  transformIcon.addEventListener('click', () => setStampMode(false))
  stampIcon.addEventListener('click', () => setStampMode(true))

  centerCameraBtn.addEventListener('click', () => {
    const base = getBaseViewBox()
    if (!base) return
    viewState = { ...base }
    redraw()
    if (currentGrid) persistMetadata()
  })

  // Stamp tool implementation: load individual stamp images from /stamps/ folder
  let loadedStamps = []
  /** Indices into loadedStamps for multi-select (shift+click). Primary stamp = first in set for single placement. */
  let selectedStampIndices = new Set()

  function cropImageToShapeBounds(img, useInvert = false) {
    const w = img.width
    const h = img.height
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = w
    tempCanvas.height = h
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })
    if (!tempCtx) return null
    tempCtx.imageSmoothingEnabled = false
    tempCtx.drawImage(img, 0, 0)
    const imageData = tempCtx.getImageData(0, 0, w, h)
    const { data } = imageData
    const isGridPixel = (r, g, b) => {
      const brightness = (r + g + b) / 3
      const isPureBlack = brightness < 50
      const isPureWhite = brightness > 205
      return !isPureBlack && !isPureWhite
    }
    let minX = w, minY = h, maxX = 0, maxY = 0
    let hasPixels = false
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4
        if (data[i + 3] < 10) continue
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if (isGridPixel(r, g, b)) continue
        const brightness = (r + g + b) / 3
        const isPureBlack = brightness < 50
        const isPureWhite = brightness > 205
        if (!isPureBlack && !isPureWhite) continue
        const isShape = useInvert ? isPureWhite : isPureBlack
        if (isShape) {
          hasPixels = true
          minX = Math.min(minX, px)
          minY = Math.min(minY, py)
          maxX = Math.max(maxX, px)
          maxY = Math.max(maxY, py)
        }
      }
    }
    if (!hasPixels) return null
    const cropWidth = maxX - minX + 1
    const cropHeight = maxY - minY + 1
    const croppedCanvas = document.createElement('canvas')
    croppedCanvas.width = cropWidth
    croppedCanvas.height = cropHeight
    const croppedCtx = croppedCanvas.getContext('2d', { willReadFrequently: true })
    if (!croppedCtx) return null
    croppedCtx.imageSmoothingEnabled = false
    croppedCtx.drawImage(tempCanvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
    return { canvas: croppedCanvas, width: cropWidth, height: cropHeight }
  }

  const STAMP_THUMB_BORDER_DEFAULT = '2px solid var(--tui-line-strong)'
  const STAMP_THUMB_BORDER_SELECTED = '3px solid #4a9eff'

  function updateStampThumbOutlines() {
    stampGridContainer.querySelectorAll('.stamp-thumb').forEach((thumb) => {
      const idx = Number(thumb.dataset.stampIndex)
      thumb.style.border = selectedStampIndices.has(idx) ? STAMP_THUMB_BORDER_SELECTED : STAMP_THUMB_BORDER_DEFAULT
    })
  }

  function selectStampAndUpdatePreview(entry, shiftKey, index) {
    if (shiftKey) {
      if (selectedStampIndices.has(index)) selectedStampIndices.delete(index)
      else selectedStampIndices.add(index)
    } else {
      selectedStampIndices = new Set([index])
    }
    stampShape = selectedStampIndices.size ? loadedStamps[Math.min(...selectedStampIndices)] : null
    updateStampThumbOutlines()
    updateSelectedStampsStrip()
    if (selectedStampIndices.size > 1) {
      status.textContent = `${selectedStampIndices.size} stamps selected. Click canvas to add a layer, or Generate to use only these.`
    } else if (stampShape) {
      status.textContent = 'Stamp selected. Stamp mode enabled.'
    } else {
      status.textContent = 'No stamp selected.'
    }
    if (selectedStampIndices.size && setStampMode) setStampMode(true)
  }

  const loadStampsFromFolder = () => {
    setLoadingOverlay(true, 'Loading stamps…')
    loadedStamps = []
    stampGridContainer.innerHTML = ''
    const baseUrl = import.meta.env.BASE_URL + 'stamps/'
    const total = 120
    let settled = 0
    const checkDone = () => {
      settled++
      if (settled < total) return
      setLoadingOverlay(false)
      status.textContent = loadedStamps.length ? 'Stamps loaded. Click one to select.' : 'No stamps found in /stamps/ folder.'
      if (previewContent && !currentGrid && typeof generate === 'function' && loadedStamps.length) generate()
    }
    for (let n = 1; n <= total; n++) {
      const img = new Image()
      img.onload = () => {
        const entry = cropImageToShapeBounds(img, false)
        if (!entry) {
          checkDone()
          return
        }
        const index = loadedStamps.length
        loadedStamps.push(entry)
        const thumb = document.createElement('button')
        thumb.type = 'button'
        thumb.className = 'stamp-thumb'
        thumb.dataset.stampIndex = String(index)
        thumb.title = `Stamp ${n} (shift+click to select multiple)`
        thumb.setAttribute('aria-label', `Select stamp ${n}`)
        thumb.style.cssText = 'width:100%;aspect-ratio:1;padding:0;border:' + STAMP_THUMB_BORDER_DEFAULT + ';cursor:pointer;background:#333;display:flex;align-items:center;justify-content:center;overflow:hidden;'
        const thumbCanvas = document.createElement('canvas')
        thumbCanvas.width = 32
        thumbCanvas.height = 32
        thumbCanvas.style.imageRendering = 'pixelated'
        thumbCanvas.style.maxWidth = '100%'
        thumbCanvas.style.maxHeight = '100%'
        const tctx = thumbCanvas.getContext('2d')
        if (tctx) {
          tctx.imageSmoothingEnabled = false
          const s = Math.min(32 / entry.width, 32 / entry.height)
          const tw = entry.width * s
          const th = entry.height * s
          tctx.fillStyle = '#333'
          tctx.fillRect(0, 0, 32, 32)
          tctx.drawImage(entry.canvas, (32 - tw) / 2, (32 - th) / 2, tw, th)
        }
        thumb.appendChild(thumbCanvas)
        thumb.addEventListener('click', (e) => selectStampAndUpdatePreview(entry, e.shiftKey, index))
        stampGridContainer.appendChild(thumb)
        checkDone()
      }
      img.onerror = checkDone
      img.src = baseUrl + 'Asset%20' + n + '@2x.png'
    }
  }

  invertCheckbox.addEventListener('change', () => {
    stampInvert = invertCheckbox.checked
  })

  const entityActions = document.createElement('div')
  entityActions.className = 'floor-plan-actions'
  const deleteEntityBtn = document.createElement('button')
  deleteEntityBtn.type = 'button'
  deleteEntityBtn.textContent = 'Delete selected'
  entityActions.append(deleteEntityBtn)
  const entitiesList = document.createElement('ul')
  entitiesList.className = 'floor-plan-entity-list'

  const shapesPanelContent = document.createElement('div')
  shapesPanelContent.className = 'panel-content'
  shapesPanelContent.append(entityActions, entitiesList)

  const shapesPanelFull = document.createElement('div')
  shapesPanelFull.className = 'panel collapsed'
  const shapesPanelHeader = document.createElement('button')
  shapesPanelHeader.className = 'panel-header'
  shapesPanelHeader.type = 'button'
  shapesPanelHeader.innerHTML = '<span class="panel-chevron">▼</span>Shapes'
  shapesPanelHeader.addEventListener('click', () => shapesPanelFull.classList.toggle('collapsed'))
  shapesPanelFull.append(shapesPanelHeader, shapesPanelContent)

  const layersList = document.createElement('ul')
  layersList.className = 'floor-plan-entity-list'

  const layersPanelContent = document.createElement('div')
  layersPanelContent.className = 'panel-content'
  layersPanelContent.append(layersList)

  const layersPanelFull = document.createElement('div')
  layersPanelFull.className = 'panel collapsed'
  const layersPanelHeader = document.createElement('button')
  layersPanelHeader.className = 'panel-header'
  layersPanelHeader.type = 'button'
  layersPanelHeader.innerHTML = '<span class="panel-chevron">▼</span>Layers'
  layersPanelHeader.addEventListener('click', () => layersPanelFull.classList.toggle('collapsed'))
  layersPanelFull.append(layersPanelHeader, layersPanelContent)

  entitiesContainer.append(shapesPanelFull, layersPanelFull)

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

  function showToast(message) {
    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.textContent = message
    toast.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:8px 16px;z-index:2000;'
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 2500)
  }
  
  // Resolution for full-res stamp path (export): higher = smoother lines, larger SVG. Editor uses low-res path.
  const STAMP_PATH_RESOLUTION_EXPORT = 4
  // Max dimension for stamp path while editing; reduces path commands for faster render. Full-res path used on export.
  const EDITOR_STAMP_PATH_MAX = 64

  const READBACK_CONTEXT_OPTIONS = { willReadFrequently: true }

  function bitmapToSvgPath(canvas, invert, pathResolution = 1) {
    const ctx = canvas.getContext('2d', READBACK_CONTEXT_OPTIONS)
    if (!ctx) return ''
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const { data, width, height } = imageData
    const u = 1 / pathResolution

    let path = ''
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const a = data[i + 3]
        if (a < 10) continue
        const brightness = (r + g + b) / 3
        const isPureBlack = brightness < 50
        const isPureWhite = brightness > 205
        if (!isPureBlack && !isPureWhite) continue
        const isShape = invert ? isPureWhite : isPureBlack
        if (isShape) {
          const x0 = x * u
          const y0 = y * u
          path += `M${x0},${y0}h${u}v${u}h${-u}z`
        }
      }
    }
    return path
  }
  
  const getStampScale = () => parseFloat(stampScaleRow.input.value) || 0.25

  /** Build pool from a list of stamp entries (each as normal + inverted). */
  function buildStampPoolFromEntries(entries) {
    const pool = []
    for (const entry of entries) {
      const croppedCanvas = entry.canvas
      const cropWidth = entry.width
      const cropHeight = entry.height
      const stampPathNormal = bitmapToSvgPath(croppedCanvas, false, STAMP_PATH_RESOLUTION_EXPORT)
      const stampPathInverted = bitmapToSvgPath(croppedCanvas, true, STAMP_PATH_RESOLUTION_EXPORT)
      const editorPathMax = Math.max(1, EDITOR_STAMP_PATH_MAX)
      const scaleEditor = Math.min(1, editorPathMax / Math.max(cropWidth, cropHeight))
      const editorW = Math.max(1, Math.round(cropWidth * scaleEditor))
      const editorH = Math.max(1, Math.round(cropHeight * scaleEditor))
      let stampPathEditorNormal = null
      let stampPathEditorInverted = null
      if (editorW * editorH < cropWidth * cropHeight) {
        const smallCanvas = document.createElement('canvas')
        smallCanvas.width = editorW
        smallCanvas.height = editorH
        const smallCtx = smallCanvas.getContext('2d', READBACK_CONTEXT_OPTIONS)
        if (smallCtx) {
          smallCtx.imageSmoothingEnabled = false
          smallCtx.drawImage(croppedCanvas, 0, 0, cropWidth, cropHeight, 0, 0, editorW, editorH)
          stampPathEditorNormal = bitmapToSvgPath(smallCanvas, false, 1)
          stampPathEditorInverted = bitmapToSvgPath(smallCanvas, true, 1)
        }
      }
      const editorPathNormal = stampPathEditorNormal || stampPathNormal
      const editorPathInverted = stampPathEditorInverted || stampPathInverted
      const editorPathW = stampPathEditorNormal != null ? editorW : cropWidth
      const editorPathH = stampPathEditorNormal != null ? editorH : cropHeight
      if (stampPathNormal) pool.push({ stampPath: stampPathNormal, stampWidth: cropWidth, stampHeight: cropHeight, stampPathResolution: STAMP_PATH_RESOLUTION_EXPORT, stampPathEditor: editorPathNormal, stampWidthEditor: editorPathW, stampHeightEditor: editorPathH })
      if (stampPathInverted) pool.push({ stampPath: stampPathInverted, stampWidth: cropWidth, stampHeight: cropHeight, stampPathResolution: STAMP_PATH_RESOLUTION_EXPORT, stampPathEditor: editorPathInverted, stampWidthEditor: editorPathW, stampHeightEditor: editorPathH })
    }
    return pool
  }

  /** Returns stamp pool for random generation. If entriesOverride is provided, use only those stamps; otherwise all loaded. */
  function getStampPool(entriesOverride = null) {
    const entries = entriesOverride?.length ? entriesOverride : loadedStamps
    if (!entries.length) return []
    return buildStampPoolFromEntries(entries)
  }

  /** @param {number} [editorScale] Scale from export size to editor size (e.g. editorW/exportW); use 1 when already in editor coords. */
  function createStampShape(x, y, stampData, color, editorScale = 1) {
    const scale = getStampScale()
    const cw = stampData.width ?? stampData.stampWidth
    const ch = stampData.height ?? stampData.stampHeight
    const rawSize = Math.max(cw, ch)
    const pattern = stampTextureSelect.value || 'solid'
    let stampPath = stampData.stampPath
    let stampPathEditor = stampData.stampPathEditor
    let stampWidthEditor = stampData.stampWidthEditor
    let stampHeightEditor = stampData.stampHeightEditor
    if (stampData.canvas) {
      stampPath = bitmapToSvgPath(stampData.canvas, stampInvert, STAMP_PATH_RESOLUTION_EXPORT)
      if (!stampPath) return null
      const editorPathMax = Math.max(1, EDITOR_STAMP_PATH_MAX)
      const scaleEditor = Math.min(1, editorPathMax / Math.max(cw, ch))
      const editorW = Math.max(1, Math.round(cw * scaleEditor))
      const editorH = Math.max(1, Math.round(ch * scaleEditor))
      if (editorW * editorH < cw * ch) {
        const smallCanvas = document.createElement('canvas')
        smallCanvas.width = editorW
        smallCanvas.height = editorH
        const smallCtx = smallCanvas.getContext('2d', READBACK_CONTEXT_OPTIONS)
        if (smallCtx) {
          smallCtx.imageSmoothingEnabled = false
          smallCtx.drawImage(stampData.canvas, 0, 0, cw, ch, 0, 0, editorW, editorH)
          stampPathEditor = bitmapToSvgPath(smallCanvas, stampInvert, 1)
          stampWidthEditor = editorW
          stampHeightEditor = editorH
        }
      }
      if (!stampPathEditor) {
        stampPathEditor = stampPath
        stampWidthEditor = cw
        stampHeightEditor = ch
      }
    }
    return {
      type: 'stamp',
      x,
      y,
      size: rawSize * scale * editorScale,
      color,
      pattern,
      rotation: 0,
      layer: 'stamps',
      id: `shape-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      stampPath,
      stampWidth: cw,
      stampHeight: ch,
      stampPathResolution: stampData.stampPathResolution ?? STAMP_PATH_RESOLUTION_EXPORT,
      ...(stampPathEditor != null && { stampPathEditor, stampWidthEditor, stampHeightEditor }),
    }
  }

  function setGeneratingState(generating) {
    randomizeBtn.disabled = generating
    generateNewBtn.disabled = generating
    saveBtn.disabled = generating
    deleteEntityBtn.disabled = generating
  }

  function persistSettings(statsText) {
    const spreadVal = parseFloat(spreadRow.input.value)
    const spreadToSave = Number.isFinite(spreadVal) ? Math.max(spreadMin, Math.min(spreadMax, spreadVal)) : spreadDefault
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        seed: readPositiveInt(seed.input, Date.now()),
        width: readPositiveInt(width.input, 1200),
        height: readPositiveInt(height.input, 2400),
        shapeCount: readBoundedInt(shapeCount.input, 80, 20, 300),
        spread: spreadToSave,
        minSize: readBoundedInt(minSize.input, 8, 2, 100),
        maxSize: readBoundedInt(maxSize.input, 120, 10, 300),
        minTextureScale: parseFloat(minTextureScale.input.value) || 0.5,
        maxTextureScale: parseFloat(maxTextureScale.input.value) || 2,
        randomRotation: randomRotationCheckbox.checked,
        nudgeAmount: readBoundedInt(nudgeRow.input, nudgeDefault, nudgeMin, nudgeMax),
        scaleStep: readBoundedInt(scaleStepRow.input, scaleStepDefault, scaleStepMin, scaleStepMax),
        stampScale: getStampScale(),
        stampPattern: stampTextureSelect.value || 'solid',
        colorPalette: [...colorPalette],
        background: getBackground(),
        statsText,
      })
    )
  }

  function persistMetadata() {
    syncLatestSvg()
  }

  /** Returns unique layer ids in draw order: numeric ascending, then string alphabetical. */
  function getSortedLayerIds(grid) {
    const layerSet = new Set()
    ;(grid?.shapes ?? []).forEach((shape) => layerSet.add(shape.layer != null ? shape.layer : 1))
    return Array.from(layerSet).sort((a, b) => {
      const aIsNum = typeof a === 'number'
      const bIsNum = typeof b === 'number'
      if (aIsNum && bIsNum) return a - b
      if (aIsNum) return -1
      if (bIsNum) return 1
      return String(a).localeCompare(String(b))
    })
  }

  function renderLayerList(metadata) {
    layersList.innerHTML = ''
    const layerMap = new Map()
    
    ;(metadata?.shapes ?? []).forEach((shape) => {
      const layer = shape.layer || 1
      if (!layerMap.has(layer)) {
        layerMap.set(layer, [])
      }
      layerMap.get(layer).push(shape)
    })
    
    // Sort layers: numeric layers first (ascending), then string layers (alphabetically)
    const sortedLayers = Array.from(layerMap.keys()).sort((a, b) => {
      const aIsNum = typeof a === 'number'
      const bIsNum = typeof b === 'number'
      if (aIsNum && bIsNum) return a - b
      if (aIsNum) return -1
      if (bIsNum) return 1
      return String(a).localeCompare(String(b))
    })
    
    sortedLayers.forEach((layerNum) => {
      const shapes = layerMap.get(layerNum)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'floor-plan-entity-item'
      if (selectedLayer === layerNum) btn.classList.add('is-selected')
      const layerName = typeof layerNum === 'string' ? layerNum : `Layer ${layerNum}`
      btn.textContent = `${layerName} (${shapes.length} shapes)`
      btn.addEventListener('click', () => {
        selectedLayer = selectedLayer === layerNum ? null : layerNum
        selectedShapeIds.clear()
        if (selectedLayer !== null) {
          shapes.forEach(shape => selectedShapeIds.add(shape.id))
        }
        updateSelection()
      })
      layersList.appendChild(btn)
    })
    
    if (layersList.children.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'floor-plan-entity-empty'
      empty.textContent = 'No layers.'
      layersList.appendChild(empty)
    }
  }

  function renderEntityList(metadata) {
    entitiesList.innerHTML = ''
    ;(metadata?.shapes ?? []).forEach((shape, index) => {
      const id = shape.id ?? `shape-${index + 1}`
      const layer = shape.layer || 1
      const layerDisplay = typeof layer === 'string' ? layer : `L${layer}`
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'floor-plan-entity-item'
      if (selectedShapeIds.has(id)) btn.classList.add('is-selected')
      btn.textContent = `${shape.type} [${layerDisplay}] (${Number(shape.x).toFixed(0)}, ${Number(shape.y).toFixed(0)})`
      btn.addEventListener('click', (e) => {
        const shift = e.shiftKey || (typeof e.getModifierState === 'function' && e.getModifierState('Shift'))
        if (shift) {
          if (selectedShapeIds.has(id)) selectedShapeIds.delete(id)
          else selectedShapeIds.add(id)
        } else {
          selectedShapeIds.clear()
          selectedShapeIds.add(id)
        }
        selectedLayer = null
        updateSelection()
      })
      entitiesList.appendChild(btn)
    })
    if (entitiesList.children.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'floor-plan-entity-empty'
      empty.textContent = 'No shapes.'
      entitiesList.appendChild(empty)
    }
  }

  function updateSelection() {
    drawOverlayCanvas()
    const metadata = currentGrid ? { shapes: currentGrid.shapes } : { shapes: [] }
    renderLayerList(metadata)
    renderEntityList(metadata)
  }

  function bindCanvasInteractions() {
    if (!currentGrid) return
    currentGrid.shapes = Array.isArray(currentGrid.shapes) ? currentGrid.shapes : []
    if (!currentGrid.background) currentGrid.background = getBackground()
    currentGrid.shapes.forEach((shape, index) => {
      if (!shape.layer || shape.layer < 1) {
        shape.layer = (index % 5) + 1
      }
    })
    syncLatestSvg()
    updateSelection()

    const clearHoverOutline = () => {
      hoveredShapeId = null
      drawOverlayCanvas()
    }
    const updateHoverOutline = (sceneX, sceneY) => {
      if (stampMode) return
      const hit = hitTestShapes(sceneX, sceneY)
      const nextId = hit ? hit.id : null
      if (nextId !== hoveredShapeId) {
        hoveredShapeId = nextId
        drawOverlayCanvas()
      }
    }

    const toViewBoxDelta = (deltaPixelsX, deltaPixelsY) => {
      const rect = mainCanvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const vt = getCurrentViewTransform()
      return {
        x: (deltaPixelsX / rect.width) * vt.width,
        y: (deltaPixelsY / rect.height) * vt.height,
      }
    }
    const base = getBaseViewBox()
    const minViewBoxWidth = Math.max(1, (base?.width ?? 400) * 0.2)
    const minViewBoxHeight = Math.max(1, (base?.height ?? 400) * 0.2)
    const maxViewBoxWidth = Math.max(400 * 8, (base?.width ?? 400) * 8)
    const maxViewBoxHeight = Math.max(400 * 8, (base?.height ?? 400) * 8)
    const zoomAtPointer = (event) => {
      const point = toSceneCoords(event.clientX, event.clientY)
      const current = getCurrentViewTransform()
      if (!point) return
      let delta = event.deltaY
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= 240
      const clampedDelta = Math.max(-120, Math.min(120, delta))
      const zoomFactor = Math.pow(1.0018, clampedDelta)
      const nextWidth = clamp(current.width * zoomFactor, minViewBoxWidth, maxViewBoxWidth)
      const nextHeight = clamp(current.height * zoomFactor, minViewBoxHeight, maxViewBoxHeight)
      if (Math.abs(nextWidth - current.width) < 0.0001 && Math.abs(nextHeight - current.height) < 0.0001) return
      const anchorX = (point.x - current.minX) / current.width
      const anchorY = (point.y - current.minY) / current.height
      viewState = {
        minX: point.x - anchorX * nextWidth,
        minY: point.y - anchorY * nextHeight,
        width: nextWidth,
        height: nextHeight,
      }
      redraw()
    }

    mainCanvas.onpointerdown = null
    mainCanvas.onpointermove = null
    mainCanvas.onpointerup = null
    mainCanvas.onpointercancel = null
    mainCanvas.onwheel = null
    mainCanvas.onpointerover = null
    mainCanvas.onpointerout = null

    let hoverRafId = null
    let lastHoverCoords = null
    mainCanvas.onpointermove = (e) => {
      if (dragState) return
      if (stampMode && stampShape) {
        if (hoveredShapeId != null) clearHoverOutline()
        return
      }
      lastHoverCoords = { x: e.clientX, y: e.clientY }
      if (hoverRafId == null) {
        hoverRafId = requestAnimationFrame(() => {
          hoverRafId = null
          if (lastHoverCoords) {
            const pt = toSceneCoords(lastHoverCoords.x, lastHoverCoords.y)
            if (pt) updateHoverOutline(pt.x, pt.y)
          }
        })
      }
    }
    mainCanvas.onpointerover = (e) => {
      if (!stampMode && lastHoverCoords == null) {
        const pt = toSceneCoords(e.clientX, e.clientY)
        if (pt) updateHoverOutline(pt.x, pt.y)
      }
    }
    mainCanvas.onpointerout = () => {
      hoveredShapeId = null
      drawOverlayCanvas()
    }

    let lastPanClientX = 0
    let lastPanClientY = 0
    let panRafId = null
    mainCanvas.onpointerdown = (event) => {
      const rect = mainCanvas.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      if (x < 0 || x >= rect.width || y < 0 || y >= rect.height) return
      clearHoverOutline()
      const point = toSceneCoords(event.clientX, event.clientY)
      if (!point) return
      if (stampMode && !stampShape) {
        showToast('Select a stamp first')
        event.preventDefault()
        return
      }
      if (stampMode && stampShape) {
        event.preventDefault()
        return
      }
      const gizmo = hitTestGizmos(point.x, point.y)
      if (gizmo && gizmo.kind === 'rotate') {
        const shape = currentGrid.shapes.find((s) => s.id === gizmo.id)
        if (!shape) return
        const startAngle = Math.atan2(point.y - shape.y, point.x - shape.x) * (180 / Math.PI)
        stateBeforeDrag = getCurrentState()
        dragState = { kind: 'rotate', id: gizmo.id, centerX: shape.x, centerY: shape.y, startRotation: shape.rotation, startAngle }
        mainCanvas.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
      if (gizmo && gizmo.kind === 'scale') {
        const shape = currentGrid.shapes.find((s) => s.id === gizmo.id)
        if (!shape) return
        const startDistance = Math.hypot(point.x - shape.x, point.y - shape.y)
        stateBeforeDrag = getCurrentState()
        dragState = { kind: 'scale', id: gizmo.id, centerX: shape.x, centerY: shape.y, startSize: shape.size, startDistance }
        mainCanvas.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
      const hitShape = hitTestShapes(point.x, point.y)
      if (hitShape) {
        const id = hitShape.id
        const shift = event.shiftKey || (typeof event.getModifierState === 'function' && event.getModifierState('Shift'))
        if (shift) {
          if (selectedShapeIds.has(id)) selectedShapeIds.delete(id)
          else selectedShapeIds.add(id)
          selectedLayer = null
          updateSelection()
          event.preventDefault()
          return
        }
        if (!selectedShapeIds.has(id)) {
          selectedShapeIds.clear()
          selectedShapeIds.add(id)
          selectedLayer = null
          updateSelection()
        }
        stateBeforeDrag = getCurrentState()
        dragState = { kind: 'shape', id, startX: hitShape.x, startY: hitShape.y, offsetX: point.x - hitShape.x, offsetY: point.y - hitShape.y }
        mainCanvas.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
      selectedShapeIds.clear()
      selectedLayer = null
      updateSelection()
      const current = getCurrentViewTransform()
      dragState = { kind: 'pan', startClientX: event.clientX, startClientY: event.clientY, startViewBox: { ...current } }
      mainCanvas.setPointerCapture(event.pointerId)
      previewContent.classList.add('is-panning')
      event.preventDefault()
    }

    const onPointerMove = (event) => {
      if (!dragState) return
      const point = toSceneCoords(event.clientX, event.clientY)
      if (dragState.kind === 'pan') {
        lastPanClientX = event.clientX
        lastPanClientY = event.clientY
        if (panRafId == null) {
          panRafId = requestAnimationFrame(() => {
            panRafId = null
            if (!dragState || dragState.kind !== 'pan') return
            const delta = toViewBoxDelta(lastPanClientX - dragState.startClientX, lastPanClientY - dragState.startClientY)
            if (!delta) return
            viewState = {
              minX: dragState.startViewBox.minX - delta.x,
              minY: dragState.startViewBox.minY - delta.y,
              width: dragState.startViewBox.width,
              height: dragState.startViewBox.height,
            }
            redraw()
          })
        }
        return
      }
      if (dragState.kind === 'rotate' && point) {
        const shape = currentGrid.shapes.find((s) => s.id === dragState.id)
        if (!shape) return
        const currentAngle = Math.atan2(point.y - dragState.centerY, point.x - dragState.centerX) * (180 / Math.PI)
        let newRotation = (dragState.startRotation + (currentAngle - dragState.startAngle)) % 360
        if (newRotation < 0) newRotation += 360
        if (!event.shiftKey) newRotation = Math.round(newRotation / 45) * 45
        shape.rotation = newRotation % 360
        redraw()
        return
      }
      if (dragState.kind === 'scale' && point) {
        const shape = currentGrid.shapes.find((s) => s.id === dragState.id)
        if (!shape) return
        const currentDistance = Math.hypot(point.x - dragState.centerX, point.y - dragState.centerY)
        shape.size = Math.max(4, dragState.startSize * (currentDistance / dragState.startDistance))
        redraw()
        return
      }
      if (dragState.kind === 'shape' && point) {
        const shape = currentGrid.shapes.find((s) => s.id === dragState.id)
        if (!shape) return
        shape.x = point.x - dragState.offsetX
        shape.y = point.y - dragState.offsetY
        redraw()
      }
    }
    mainCanvas.onpointermove = onPointerMove

    const endDrag = (event) => {
      if (!dragState) return
      mainCanvas.releasePointerCapture(event.pointerId)
      previewContent.classList.remove('is-panning')
      if (stateBeforeDrag != null && (dragState.kind === 'shape' || dragState.kind === 'rotate' || dragState.kind === 'scale')) {
        pushUndoState(stateBeforeDrag)
        stateBeforeDrag = null
      }
      dragState = null
      persistMetadata()
      updateSelection()
    }
    mainCanvas.onpointerup = endDrag
    mainCanvas.onpointercancel = endDrag
    mainCanvas.onwheel = (e) => {
      if (dragState) return
      e.preventDefault()
      zoomAtPointer(e)
    }
  }

  function getCurrentState() {
    return {
      grid: currentGrid ? structuredClone(currentGrid) : null,
      viewState: viewState ? { ...viewState } : null,
    }
  }

  function pushUndoState(state) {
    const toPush = state ?? getCurrentState()
    if (!toPush.grid) return
    undoStack.push(toPush)
    if (undoStack.length > MAX_UNDO) undoStack.shift()
    redoStack.length = 0
  }

  function applyState(state) {
    currentGrid = state.grid ? structuredClone(state.grid) : null
    viewState = state.viewState ? { ...state.viewState } : null
    if (currentGrid) {
      latestSvg = renderArtGridSvg(currentGrid)
      if (!viewState) {
        const base = getBaseViewBox()
        viewState = base ? { ...base } : null
      }
    } else {
      latestSvg = ''
      viewState = null
    }
    sizeCanvases()
    bindCanvasInteractions()
    updateSelection()
  }

  /** @param {boolean} visible - Show or hide overlay. @param {string} [message] - Optional message (e.g. "Exporting…"); when hiding, text resets to default. */
  function setLoadingOverlay(visible, message) {
    loadingOverlay.classList.toggle('is-visible', visible)
    loadingOverlay.setAttribute('aria-hidden', String(!visible))
    if (message !== undefined) loadingOverlayTextEl.textContent = message
    else if (!visible) loadingOverlayTextEl.textContent = defaultLoadingOverlayText
  }

  function generate() {
    if (isGenerating) return
    isGenerating = true
    setLoadingOverlay(true, defaultLoadingOverlayText)
    setGeneratingState(true)
    status.textContent = 'Generating dope throne grid...'
    setTimeout(async () => {
      try {
        const entriesOverride = selectedStampIndices.size > 1
          ? [...selectedStampIndices].sort((a, b) => a - b).map((i) => loadedStamps[i])
          : null
        const stampPool = getStampPool(entriesOverride)
        if (!stampPool.length) {
          showToast('No stamps loaded. Add images to the /stamps/ folder.')
          return
        }
        pushUndoState()
        const exportW = readPositiveInt(width.input, 1200)
        const exportH = readPositiveInt(height.input, 2400)
        const { w: editorW, h: editorH } = getEditorSize(exportW, exportH)
        const spreadRaw = parseFloat(spreadRow.input.value)
        const spread = Number.isFinite(spreadRaw) ? Math.max(spreadMin, Math.min(spreadMax, spreadRaw)) : spreadDefault
        const scaleToEditor = Math.min(editorW / exportW, editorH / exportH)
        const existingShapes = currentGrid?.shapes?.length > 0
        const appendNewLayer = existingShapes && selectedShapeIds.size > 0
        const genWidth = appendNewLayer ? currentGrid.meta.width : editorW
        const genHeight = appendNewLayer ? currentGrid.meta.height : editorH
        const options = {
          seed: readPositiveInt(seed.input, Date.now()),
          width: genWidth,
          height: genHeight,
          shapeCount: readBoundedInt(shapeCount.input, 80, 20, 300),
          spread,
          minSize: Math.max(2, Math.round(readBoundedInt(minSize.input, 8, 2, 100) * scaleToEditor)),
          maxSize: Math.max(4, Math.round(readBoundedInt(maxSize.input, 120, 10, 300) * scaleToEditor)),
          minTextureScale: parseFloat(minTextureScale.input.value) || 0.5,
          maxTextureScale: parseFloat(maxTextureScale.input.value) || 2,
          randomRotation: randomRotationCheckbox.checked,
          colors: getColorsForGeneration(),
          stamps: stampPool,
        }
        seed.input.value = String(options.seed)
        let grid
        if (appendNewLayer) {
          const sorted = getSortedLayerIds(currentGrid)
          const topLayer = sorted.length > 0 ? sorted[sorted.length - 1] : 1
          const newLayerId = typeof topLayer === 'number' ? topLayer + 1 : (() => {
            const numerics = sorted.filter((id) => typeof id === 'number')
            return numerics.length > 0 ? Math.max(...numerics) + 1 : 1
          })()
          grid = generateArtGrid(options)
          const newShapes = grid.shapes.map((s) => ({ ...s, layer: newLayerId }))
          grid = {
            meta: {
              width: currentGrid.meta.width,
              height: currentGrid.meta.height,
              shapeCount: currentGrid.shapes.length + newShapes.length,
            },
            shapes: [...currentGrid.shapes, ...newShapes],
            background: getBackground(),
          }
        } else {
          const useStampSubset = selectedStampIndices.size > 1
          const existingStampShapes = (() => {
            if (useStampSubset) return []
            if (selectedLayer === 'stamps') return []
            if (!currentGrid?.shapes) return []
            return currentGrid.shapes.filter((s) => s.layer === 'stamps')
          })()
          grid = generateArtGrid(options)
          if (existingStampShapes.length > 0) {
            grid.shapes.push(...existingStampShapes)
            grid.meta.shapeCount = grid.shapes.length
          }
          grid.background = getBackground()
        }
        setGrid(grid)
        const base = getBaseViewBox()
        if (base) {
          viewState = { ...base }
          redraw()
        }
        const statsText = `Shapes: ${grid.meta.shapeCount} · Export size: ${exportW}×${exportH}px`
        stats.textContent = statsText
        persistSettings(statsText)
        selectedShapeIds.clear()
        selectedLayer = null
        bindCanvasInteractions()
        updateSelection()
        status.textContent = 'Art grid generated.'
      } catch (error) {
        status.textContent = `Could not generate dope throne grid: ${error instanceof Error ? error.message : 'Unknown error'}`
      } finally {
        setLoadingOverlay(false)
        isGenerating = false
        setGeneratingState(false)
      }
    }, 0)
  }

  deleteEntityBtn.addEventListener('click', () => {
    if (!currentGrid) return
    currentGrid.shapes = Array.isArray(currentGrid.shapes) ? currentGrid.shapes : []
    if (selectedShapeIds.size > 0) {
      pushUndoState()
      selectedShapeIds.forEach(id => {
        currentGrid.shapes = currentGrid.shapes.filter((entry) => entry.id !== id)
      })
      selectedShapeIds.clear()
      selectedLayer = null
      currentGrid.meta.shapeCount = currentGrid.shapes.length
      syncLatestSvg()
      redraw()
      bindCanvasInteractions()
      updateSelection()
      status.textContent = 'Shape deleted.'
      return
    }
    status.textContent = 'Select a shape first.'
  })

  window.addEventListener('keydown', (event) => {
    if (previewContainer.classList.contains('hidden')) return
    const target = event.target
    const inInput = target && (target.closest('input') || target.closest('textarea') || target.closest('select'))
    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key === 'z') {
      if (inInput) return
      event.preventDefault()
      if (event.shiftKey) {
        if (redoStack.length > 0) {
          const current = getCurrentState()
          if (current.grid) {
            undoStack.push(current)
            if (undoStack.length > MAX_UNDO) undoStack.shift()
          }
          applyState(redoStack.pop())
          status.textContent = 'Redo.'
        }
      } else {
        if (undoStack.length > 0) {
          redoStack.push(getCurrentState())
          applyState(undoStack.pop())
          status.textContent = 'Undo.'
        }
      }
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedShapeIds.size > 0) {
      deleteEntityBtn.click()
      event.preventDefault()
      return
    }
    const arrowKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
    if (arrowKeys.includes(event.key)) {
      if (inInput) return
      if (currentGrid && selectedShapeIds.size > 0) {
        event.preventDefault()
        const nudge = readBoundedInt(nudgeRow.input, nudgeDefault, nudgeMin, nudgeMax)
        let dx = 0
        let dy = 0
        if (event.key === 'ArrowLeft') dx = -nudge
        else if (event.key === 'ArrowRight') dx = nudge
        else if (event.key === 'ArrowUp') dy = -nudge
        else if (event.key === 'ArrowDown') dy = nudge
        if (dx !== 0 || dy !== 0) {
          pushUndoState()
          selectedShapeIds.forEach((id) => {
            const shape = currentGrid.shapes.find((s) => s.id === id)
            if (shape && typeof shape.x === 'number' && typeof shape.y === 'number') {
              shape.x += dx
              shape.y += dy
            }
          })
          syncLatestSvg()
          redraw()
          const dir = dx !== 0 ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up')
          status.textContent = `Moved ${dir} ${nudge}px.`
        }
      }
      return
    }
    if (mod && (event.key === 'r' || event.key === 'R')) {
      event.preventDefault()
      if (inInput) return
      if (currentGrid && selectedShapeIds.size > 0) {
        pushUndoState()
        selectedShapeIds.forEach((id) => {
          const shape = currentGrid.shapes.find((s) => s.id === id)
          if (shape && typeof shape.rotation === 'number') {
            shape.rotation = (shape.rotation + 45) % 360
          }
        })
        syncLatestSvg()
        redraw()
        status.textContent = 'Rotated 45°.'
      }
      return
    }
    if (mod && (event.key === '+' || event.key === '=')) {
      event.preventDefault()
      if (inInput) return
      if (currentGrid && selectedShapeIds.size > 0) {
        const step = readBoundedInt(scaleStepRow.input, scaleStepDefault, scaleStepMin, scaleStepMax)
        pushUndoState()
        selectedShapeIds.forEach((id) => {
          const shape = currentGrid.shapes.find((s) => s.id === id)
          if (shape && typeof shape.size === 'number') {
            shape.size = Math.min(500, shape.size + step)
          }
        })
        syncLatestSvg()
        redraw()
        status.textContent = `Scaled up ${step}px.`
      }
      return
    }
    if (mod && event.key === '-') {
      event.preventDefault()
      if (inInput) return
      if (currentGrid && selectedShapeIds.size > 0) {
        const step = readBoundedInt(scaleStepRow.input, scaleStepDefault, scaleStepMin, scaleStepMax)
        pushUndoState()
        selectedShapeIds.forEach((id) => {
          const shape = currentGrid.shapes.find((s) => s.id === id)
          if (shape && typeof shape.size === 'number') {
            shape.size = Math.max(2, shape.size - step)
          }
        })
        syncLatestSvg()
        redraw()
        status.textContent = `Scaled down ${step}px.`
      }
      return
    }
    if (event.key === '[') {
      if (inInput) return
      if (currentGrid && selectedShapeIds.size > 0) {
        event.preventDefault()
        const sorted = getSortedLayerIds(currentGrid)
        if (sorted.length === 0) return
        const selectedLayers = new Set()
        selectedShapeIds.forEach((id) => {
          const shape = currentGrid.shapes.find((s) => s.id === id)
          if (shape) selectedLayers.add(shape.layer != null ? shape.layer : 1)
        })
        let minIndex = sorted.length
        selectedLayers.forEach((layer) => {
          const idx = sorted.indexOf(layer)
          if (idx !== -1 && idx < minIndex) minIndex = idx
        })
        let targetLayer
        if (minIndex > 0) {
          targetLayer = sorted[minIndex - 1]
        } else {
          const bottom = sorted[0]
          targetLayer = typeof bottom === 'number' ? bottom - 1 : 0
        }
        pushUndoState()
        selectedShapeIds.forEach((id) => {
          const shape = currentGrid.shapes.find((s) => s.id === id)
          if (shape) shape.layer = targetLayer
        })
        syncLatestSvg()
        redraw()
        updateSelection()
        const name = typeof targetLayer === 'string' ? targetLayer : `Layer ${targetLayer}`
        status.textContent = minIndex > 0 ? `Moved to ${name}.` : 'Moved to new layer below.'
      }
      return
    }
    if (event.key === ']') {
      if (inInput) return
      if (currentGrid && selectedShapeIds.size > 0) {
        event.preventDefault()
        const sorted = getSortedLayerIds(currentGrid)
        if (sorted.length === 0) return
        const selectedLayers = new Set()
        selectedShapeIds.forEach((id) => {
          const shape = currentGrid.shapes.find((s) => s.id === id)
          if (shape) selectedLayers.add(shape.layer != null ? shape.layer : 1)
        })
        let maxIndex = -1
        selectedLayers.forEach((layer) => {
          const idx = sorted.indexOf(layer)
          if (idx !== -1 && idx > maxIndex) maxIndex = idx
        })
        let targetLayer
        if (maxIndex < sorted.length - 1) {
          targetLayer = sorted[maxIndex + 1]
        } else {
          const top = sorted[sorted.length - 1]
          if (typeof top === 'number') {
            targetLayer = top + 1
          } else {
            const numerics = sorted.filter((id) => typeof id === 'number')
            targetLayer = numerics.length > 0 ? Math.max(...numerics) + 1 : 1
          }
        }
        pushUndoState()
        selectedShapeIds.forEach((id) => {
          const shape = currentGrid.shapes.find((s) => s.id === id)
          if (shape) shape.layer = targetLayer
        })
        syncLatestSvg()
        redraw()
        updateSelection()
        const name = typeof targetLayer === 'string' ? targetLayer : `Layer ${targetLayer}`
        status.textContent = maxIndex < sorted.length - 1 ? `Moved to ${name}.` : 'Moved to new layer above.'
      }
      return
    }
    if (inInput) return
    if (event.key === 'v' || event.key === 'V') {
      if (setStampMode) setStampMode(false)
      event.preventDefault()
      return
    }
    if (event.key === 'b' || event.key === 'B') {
      if (setStampMode) setStampMode(true)
      event.preventDefault()
      return
    }
    if (event.key === 'n' || event.key === 'N') {
      centerCameraBtn.click()
      event.preventDefault()
      return
    }
    if (event.key === 'm' || event.key === 'M') {
      seed.input.value = String(randomSeed())
      generate()
      event.preventDefault()
      return
    }
  })

  randomizeBtn.addEventListener('click', () => {
    if (selectedLayer !== null) {
      if (!currentGrid) return
      setLoadingOverlay(true, defaultLoadingOverlayText)
      setTimeout(() => {
        try {
          const entriesOverride = selectedStampIndices.size > 1
            ? [...selectedStampIndices].sort((a, b) => a - b).map((i) => loadedStamps[i])
            : null
          const stampPool = getStampPool(entriesOverride)
          if (!stampPool.length) {
            showToast('No stamps loaded. Add images to the /stamps/ folder.')
            return
          }
          pushUndoState()
          const exportW = readPositiveInt(width.input, 1200)
          const exportH = readPositiveInt(height.input, 2400)
          const { w: canvasWidth, h: canvasHeight } = getEditorSize(exportW, exportH)
          const scaleToEditor = Math.min(canvasWidth / exportW, canvasHeight / exportH)
          const layerShapes = currentGrid.shapes.filter(s => s.layer === selectedLayer)
          const otherShapes = currentGrid.shapes.filter(s => s.layer !== selectedLayer)
          const layerSpreadRaw = parseFloat(spreadRow.input.value)
          const layerSpread = Number.isFinite(layerSpreadRaw) ? Math.max(spreadMin, Math.min(spreadMax, layerSpreadRaw)) : spreadDefault
          const layerOptions = {
            seed: randomSeed(),
            width: canvasWidth,
            height: canvasHeight,
            shapeCount: layerShapes.length,
            spread: layerSpread,
            minSize: Math.max(2, Math.round(readBoundedInt(minSize.input, 8, 2, 100) * scaleToEditor)),
            maxSize: Math.max(4, Math.round(readBoundedInt(maxSize.input, 120, 10, 300) * scaleToEditor)),
            minTextureScale: parseFloat(minTextureScale.input.value) || 0.5,
            maxTextureScale: parseFloat(maxTextureScale.input.value) || 2,
            randomRotation: randomRotationCheckbox.checked,
            colors: getColorsForGeneration(),
            stamps: stampPool,
          }
          const layerGrid = generateArtGrid(layerOptions)
          const newLayerShapes = layerGrid.shapes.map((s) => ({ ...s, layer: selectedLayer }))
          currentGrid.shapes = [...otherShapes, ...newLayerShapes]
          currentGrid.meta.shapeCount = currentGrid.shapes.length
          syncLatestSvg()
          redraw()
          selectedShapeIds.clear()
          newLayerShapes.forEach(shape => selectedShapeIds.add(shape.id))
          bindCanvasInteractions()
          updateSelection()
          status.textContent = `Regenerated ${newLayerShapes.length} shapes in Layer ${selectedLayer}.`
        } finally {
          setLoadingOverlay(false)
        }
      }, 0)
    } else {
      // No layer selected - randomize seed and regenerate everything
      seed.input.value = String(randomSeed())
      generate()
    }
  })

  generateNewBtn.addEventListener('click', () => {
    seed.input.value = String(randomSeed())
    generate()
  })

  // Load stamps from /stamps/ folder (last so setLoadingOverlay exists; first generate runs when load settles)
  loadStampsFromFolder()
}
