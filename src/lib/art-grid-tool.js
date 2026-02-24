import { generateArtGrid, renderArtGridSvg, PATTERNS } from './art-grid-engine.js'
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

function getExportReadySvg(svgText, options = {}) {
  const { includeGrid = false } = options
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg) return svgText
  svg.querySelectorAll('.canvas-boundary, #selection-outlines, .art-shape-hit-area, .hover-outline, #hover-outlines, #stamp-preview').forEach((el) => el.remove())
  // Ensure bg rect has solid black fill when missing (default; user config from Background tool is preserved)
  const bgRect = svg.querySelector('.bg')
  if (bgRect && (!bgRect.getAttribute('fill') || bgRect.getAttribute('fill').trim() === '')) {
    bgRect.setAttribute('fill', '#000000')
  }
  if (includeGrid) {
    // Use base viewBox only so grid is always full-canvas and even (current viewBox can be zoomed/panned and causes uneven cells)
    const baseViewBoxRaw = svg.getAttribute('data-base-viewbox') || svg.getAttribute('viewBox')
    const vb = baseViewBoxRaw ? baseViewBoxRaw.trim().split(/\s+/).map(Number) : [0, 0, 1200, 1200]
    const [vx, vy, vw, vh] = vb.length >= 4 ? vb : [0, 0, 1200, 1200]
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

function parseSvgDimensions(svgText) {
  const vb = svgText.match(/viewBox=["']?\s*([\d.\s-]+)["']?/)?.[1]?.trim()?.split(/\s+/)
  if (vb && vb.length >= 4) return { w: Number(vb[2]), h: Number(vb[3]) }
  const w = svgText.match(/width=["']?\s*([\d.]+)/)?.[1]
  const h = svgText.match(/height=["']?\s*([\d.]+)/)?.[1]
  if (w && h) return { w: Number(w), h: Number(h) }
  return { w: 1200, h: 1200 }
}

function downloadSvgAsRaster(svgText, mimeType, extension, fileNameBase) {
  const base = fileNameBase || `art-grid-${Date.now()}`
  const dims = parseSvgDimensions(svgText)
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.onload = () => {
    URL.revokeObjectURL(url)
    const canvas = document.createElement('canvas')
    canvas.width = dims.w
    canvas.height = dims.h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0, dims.w, dims.h)
    canvas.toBlob((blob) => {
      if (!blob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${base}.${extension}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(a.href)
    }, mimeType, mimeType === 'image/jpeg' ? 0.92 : undefined)
  }
  img.onerror = () => URL.revokeObjectURL(url)
  img.src = url
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
  let selectedShapeIds = new Set()
  let selectedLayer = null
  let dragState = null
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
  loadingOverlay.innerHTML = '<span class="ag-loading-overlay-spinner" aria-hidden="true"></span><span class="ag-loading-overlay-text">Generating art grid…</span>'
  const svgWrapper = document.createElement('div')
  svgWrapper.className = 'color-palette-svg-wrapper'
  previewContent.appendChild(loadingOverlay)
  previewContent.appendChild(svgWrapper)
  preview.appendChild(previewContent)
  previewContainer.appendChild(preview)

  /** Parse SVG string as XML so metadata/namespaces are preserved; replace wrapper content and return the SVG element. */
  function setSvgContent(svgString) {
    if (!svgString || typeof svgString !== 'string') return null
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgString, 'image/svg+xml')
    const svg = doc.querySelector('svg')
    if (!svg) return null
    svgWrapper.innerHTML = ''
    svgWrapper.appendChild(svg)
    return svg
  }

  const getColorsForGeneration = () =>
    colorPalette.length > 0 ? colorPalette : DEFAULT_COLORS
  
  // Click outside SVG to disable stamp mode (setStampMode defined after controls)
  // Also handle stamp placement here so clicks register reliably (svg pointerdown can be blocked by overlays)
  let setStampMode = null
  previewContent.addEventListener('click', (e) => {
    const svg = previewContent.querySelector('svg')
    const clickedOnSvg = e.target.closest('svg') || e.target.tagName === 'svg'

    // Stamp placement: handle at previewContent level so we always receive the click
    // Allow placing on top of other shapes (no clickedShape check)
    if (stampMode && stampShape && svg) {
      const ctm = svg.getScreenCTM()
      if (ctm) {
        const pt = svg.createSVGPoint()
        pt.x = e.clientX
        pt.y = e.clientY
        const svgPoint = pt.matrixTransform(ctm.inverse())
        const baseViewBox = readBaseViewBox(svg)
        if (baseViewBox && svgPoint.x >= 0 && svgPoint.x <= baseViewBox.width && svgPoint.y >= 0 && svgPoint.y <= baseViewBox.height) {
          const metadata = decodeSvgMetadata(svg)
          if (metadata) {
            e.stopPropagation()
            e.preventDefault()
            const prevBodyCursor = document.body.style.getPropertyValue('cursor') || document.body.style.cursor
            document.body.style.setProperty('cursor', 'wait', 'important')
            preview.classList.add('stamp-placing')
            // Force cursor refresh (some browsers only update on mouse move)
            document.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY, bubbles: true }))
            // Double rAF so the browser paints the wait cursor before we block the main thread
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                try {
                  const colors = getColorsForGeneration()
                  const randomColor = colors[Math.floor(Math.random() * colors.length)]
                  const newShape = createStampShape(svgPoint.x, svgPoint.y, stampShape, randomColor)
                  metadata.shapes.push(newShape)
                  const currentViewBoxRaw = svg.getAttribute('viewBox')
                  const grid = {
                    meta: {
                      width: readPositiveInt(width.input, 1200),
                      height: readPositiveInt(height.input, 2400),
                      seed: readPositiveInt(seed.input, Date.now()),
                      shapeCount: metadata.shapes.length,
                    },
                    shapes: metadata.shapes,
                    background: getBackground(),
                  }
                  latestSvg = renderArtGridSvg(grid)
                  const refreshedSvg = setSvgContent(latestSvg)
                  if (refreshedSvg && currentViewBoxRaw) refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
                  selectedShapeIds.clear()
                  selectedShapeIds.add(newShape.id)
                  bindSvgInteractions()
                  updateSelection()
                  status.textContent = 'Stamp placed.'
                } finally {
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
    }

    if (stampMode && !clickedOnSvg && setStampMode) {
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
  generateNewBtn.title = 'Generate a new art grid'
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
      applyBackground()
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
    applyBackground()
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
    applyBackground()
  })
  bgTypeSolid.addEventListener('click', () => { background.textureType = 'solid'; updateBgTypeUI(); applyBackground() })
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
    applyBackground()
  })
  bgTypeStamp.addEventListener('click', () => { background.textureType = 'stamp'; updateBgTypeUI(); applyBackground() })
  bgPatternSelect.addEventListener('change', () => { background.pattern = bgPatternSelect.value; applyBackground() })
  bgRandomBtn.addEventListener('click', () => {
    background.pattern = PATTERNS[Math.floor(Math.random() * PATTERNS.length)]
    bgPatternSelect.value = background.pattern
    const colors = getColorsForGeneration()
    background.color = colors[Math.floor(Math.random() * colors.length)]
    bgColorInput.value = background.color
    bgHexInput.value = background.color
    applyBackground()
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
    applyBackground()
    showToast('Stamp set as background')
  })
  bgSection.append(bgLabel, bgColorRow, bgTypeRow, bgPatternRow, bgTextureScaleRow.row, bgStampRow)

  const getBackground = () => ({ ...background })
  function applyBackground() {
    const svg = previewContent.querySelector('svg')
    if (!svg) return
    const metadata = decodeSvgMetadata(svg)
    if (!metadata) return
    const baseViewBox = readBaseViewBox(svg)
    const w = baseViewBox ? baseViewBox.width : readPositiveInt(width.input, 1200)
    const h = baseViewBox ? baseViewBox.height : readPositiveInt(height.input, 2400)
    metadata.background = getBackground()
    const grid = {
      meta: { width: w, height: h, seed: metadata.seed ?? readPositiveInt(seed.input, Date.now()), shapeCount: metadata.shapes.length },
      shapes: metadata.shapes,
      background: getBackground(),
    }
    const currentViewBoxRaw = svg.getAttribute('viewBox')
    latestSvg = renderArtGridSvg(grid)
    const refreshedSvg = setSvgContent(latestSvg)
    if (refreshedSvg && currentViewBoxRaw) refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
    bindSvgInteractions()
  }

  settingsContent.append(
    seed.row,
    canvasSizeRow,
    shapeCount.row,
    spreadRow.row,
    minSize.row,
    maxSize.row,
    minTextureScale.row,
    maxTextureScale.row,
    randomRotationLabel
  )
  
  // Stamp tool content
  const stampContent = document.createElement('div')
  stampContent.className = 'panel-content'
  
  // Upload shape sheet
  const uploadLabel = document.createElement('label')
  uploadLabel.style.display = 'block'
  uploadLabel.style.marginBottom = '8px'
  uploadLabel.textContent = 'Upload Shape Sheet:'
  const uploadInput = document.createElement('input')
  uploadInput.type = 'file'
  uploadInput.accept = 'image/*'
  uploadInput.style.width = '100%'
  uploadInput.style.marginBottom = '8px'
  
  // Sheet preview canvas
  const sheetCanvas = document.createElement('canvas')
  sheetCanvas.style.width = '100%'
  sheetCanvas.style.border = '2px solid var(--tui-line-strong)'
  sheetCanvas.style.cursor = 'crosshair'
  sheetCanvas.style.display = 'none'
  sheetCanvas.style.imageRendering = 'pixelated'
  
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

  const stampPreview = document.createElement('canvas')
  stampPreview.style.width = '64px'
  stampPreview.style.height = '64px'
  stampPreview.style.border = '2px solid var(--tui-line-strong)'
  stampPreview.style.display = 'none'
  stampPreview.style.imageRendering = 'pixelated'
  stampPreview.width = 64
  stampPreview.height = 64
  
  stampControls.append(invertToggle, stampScaleRow.row, stampTextureRow, stampPreview)
  stampContent.append(uploadLabel, uploadInput, sheetCanvas, stampControls)
  
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
        persistSettings(stats?.textContent ?? '')
      })
      colorInput.addEventListener('change', () => {
        colorPalette[i] = colorInput.value
        hexInput.value = colorInput.value
        renderPaletteList()
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
  randomizeBtn.title = 'Generate a new art grid'
  randomizeBtn.setAttribute('aria-label', 'Generate art grid')
  randomizeBtn.textContent = '🔄'
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.id = 'ag-save-svg'
  saveBtn.className = 'mode-gizmo-btn'
  saveBtn.title = 'Export – SVG, JPEG, PNG, or all'
  saveBtn.setAttribute('aria-label', 'Export art grid')
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
  status.textContent = 'Generate an art grid.'
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
      status.textContent = 'Generate an art grid before saving.'
      return
    }
    saveDropdown.style.display = saveDropdown.style.display === 'none' ? 'block' : 'none'
  })
  const runExport = (which) => {
    closeSaveDropdown()
    const base = `art-grid-${Date.now()}`
    const includeGrid = includeGridCheckbox.checked
    const svgText = getExportReadySvg(latestSvg, { includeGrid })
    if (which === 'svg') {
      downloadSvg(svgText, `${base}.svg`)
      status.textContent = 'SVG downloaded.'
    } else if (which === 'jpeg') {
      downloadSvgAsRaster(svgText, 'image/jpeg', 'jpg', base)
      status.textContent = 'JPEG downloaded.'
    } else if (which === 'png') {
      downloadSvgAsRaster(svgText, 'image/png', 'png', base)
      status.textContent = 'PNG downloaded.'
    } else {
      downloadSvg(svgText, `${base}.svg`)
      downloadSvgAsRaster(svgText, 'image/jpeg', 'jpg', base)
      downloadSvgAsRaster(svgText, 'image/png', 'png', base)
      status.textContent = 'SVG, JPEG, and PNG downloaded.'
    }
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
    const svg = previewContent.querySelector('svg')
    if (!svg) return
    const baseViewBox = svg.getAttribute('data-base-viewbox')
    if (!baseViewBox) return
    const metadata = decodeSvgMetadata(svg)
    svg.setAttribute('viewBox', baseViewBox)
    if (metadata) persistMetadata(svg, metadata)
  })

  // Stamp tool implementation
  let sheetImage = null
  let sheetGridCols = 8
  let sheetGridRows = 5
  
  // Load default stamp sheet
  const loadStampSheet = (src) => {
    const img = new Image()
    img.onload = () => {
      sheetImage = img
      sheetCanvas.width = img.width
      sheetCanvas.height = img.height
      sheetCanvas.style.display = 'block'
      
      const ctx = sheetCanvas.getContext('2d')
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(img, 0, 0)
      
      if (src.includes('stamps.png')) {
        status.textContent = 'Default stamp sheet loaded. Click a cell to select.'
      } else {
        status.textContent = 'Custom stamp sheet loaded. Click a cell to select.'
      }
      // If no SVG on canvas yet, generate one now that stamps are available
      if (previewContent && !previewContent.querySelector('svg') && typeof generate === 'function') {
        generate()
      }
    }
    img.onerror = () => {
      if (src.includes('stamps.png')) {
        console.log('Default stamp sheet not found, upload your own.')
      }
    }
    img.src = src
  }
  
  // Load default sheet on mount (use base URL for deployed subpath)
  loadStampSheet(import.meta.env.BASE_URL + 'stamps.png')
  
  uploadInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    
    const reader = new FileReader()
    reader.onload = (event) => {
      loadStampSheet(event.target.result)
    }
    reader.readAsDataURL(file)
  })
  
  sheetCanvas.addEventListener('click', (e) => {
    if (!sheetImage) return
    
    const rect = sheetCanvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    
    const col = Math.floor(x * sheetGridCols)
    const row = Math.floor(y * sheetGridRows)
    
    if (col < 0 || col >= sheetGridCols || row < 0 || row >= sheetGridRows) return
    
    const cellWidth = sheetImage.width / sheetGridCols
    const cellHeight = sheetImage.height / sheetGridRows
    
    // Extract the cell
    const tempCanvas = document.createElement('canvas')
    tempCanvas.width = cellWidth
    tempCanvas.height = cellHeight
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })
    if (!tempCtx) return
    tempCtx.imageSmoothingEnabled = false
    tempCtx.drawImage(
      sheetImage,
      col * cellWidth, row * cellHeight, cellWidth, cellHeight,
      0, 0, cellWidth, cellHeight
    )
    
    // Find bounding box of shape pixels (excluding gray grid)
    const imageData = tempCtx.getImageData(0, 0, cellWidth, cellHeight)
    const { data, width: w, height: h } = imageData
    
    let minX = w, minY = h, maxX = 0, maxY = 0
    let hasPixels = false
    
    const isGridPixel = (r, g, b) => {
      const brightness = (r + g + b) / 3
      
      // Only allow pure black (0-50) or pure white (205-255)
      // Everything else is considered grid/background
      const isPureBlack = brightness < 50
      const isPureWhite = brightness > 205
      
      return !isPureBlack && !isPureWhite
    }
    
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4
        const a = data[i + 3]
        
        if (a < 10) continue // Skip fully transparent
        
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        
        // Skip gray grid pixels
        if (isGridPixel(r, g, b)) continue
        
        const brightness = (r + g + b) / 3
        const isPureBlack = brightness < 50
        const isPureWhite = brightness > 205
        
        if (!isPureBlack && !isPureWhite) continue // Skip non-shape pixels
        
        const isShape = stampInvert ? isPureWhite : isPureBlack
        
        if (isShape) {
          hasPixels = true
          minX = Math.min(minX, px)
          minY = Math.min(minY, py)
          maxX = Math.max(maxX, px)
          maxY = Math.max(maxY, py)
        }
      }
    }
    
    if (!hasPixels) {
      status.textContent = 'Empty cell selected. Try another one.'
      return
    }
    
    // Crop to bounding box
    const cropX = minX
    const cropY = minY
    const cropWidth = maxX - minX + 1
    const cropHeight = maxY - minY + 1
    
    const croppedCanvas = document.createElement('canvas')
    croppedCanvas.width = cropWidth
    croppedCanvas.height = cropHeight
    const croppedCtx = croppedCanvas.getContext('2d', { willReadFrequently: true })
    if (!croppedCtx) return
    croppedCtx.imageSmoothingEnabled = false
    croppedCtx.drawImage(
      tempCanvas,
      cropX, cropY, cropWidth, cropHeight,
      0, 0, cropWidth, cropHeight
    )
    
    stampShape = {
      canvas: croppedCanvas,
      width: cropWidth,
      height: cropHeight,
      col,
      row,
    }
    
    // Show preview
    stampPreview.style.display = 'block'
    const previewCtx = stampPreview.getContext('2d')
    previewCtx.imageSmoothingEnabled = false
    previewCtx.clearRect(0, 0, 64, 64)
    previewCtx.fillStyle = '#333'
    previewCtx.fillRect(0, 0, 64, 64)
    const scale = Math.min(64 / cropWidth, 64 / cropHeight)
    const drawWidth = cropWidth * scale
    const drawHeight = cropHeight * scale
    const drawX = (64 - drawWidth) / 2
    const drawY = (64 - drawHeight) / 2
    previewCtx.drawImage(croppedCanvas, drawX, drawY, drawWidth, drawHeight)
    
    status.textContent = `Selected stamp from row ${row + 1}, col ${col + 1}. Stamp mode enabled.`
    if (setStampMode) setStampMode(true)
  })
  
  invertCheckbox.addEventListener('change', () => {
    stampInvert = invertCheckbox.checked
    if (stampShape) {
      // Update preview
      const previewCtx = stampPreview.getContext('2d')
      previewCtx.imageSmoothingEnabled = false
      previewCtx.clearRect(0, 0, 64, 64)
      previewCtx.drawImage(stampShape.canvas, 0, 0, 64, 64)
    }
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
  
  // Higher = smoother when scaling stamps up, but larger SVG and slower parse/render. 4 balances quality and performance.
  const STAMP_PATH_RESOLUTION = 1

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

  /** Returns all stamp variants from the sheet (each cell as normal + inverted) for random generation. */
  function getStampPool() {
    if (!sheetImage) return []
    const cellWidth = sheetImage.width / sheetGridCols
    const cellHeight = sheetImage.height / sheetGridRows
    const pool = []
    const isGridPixel = (r, g, b) => {
      const brightness = (r + g + b) / 3
      const isPureBlack = brightness < 50
      const isPureWhite = brightness > 205
      return !isPureBlack && !isPureWhite
    }
    for (let row = 0; row < sheetGridRows; row++) {
      for (let col = 0; col < sheetGridCols; col++) {
        const tempCanvas = document.createElement('canvas')
        tempCanvas.width = cellWidth
        tempCanvas.height = cellHeight
        const tempCtx = tempCanvas.getContext('2d', READBACK_CONTEXT_OPTIONS)
        if (!tempCtx) continue
        tempCtx.imageSmoothingEnabled = false
        tempCtx.drawImage(
          sheetImage,
          col * cellWidth, row * cellHeight, cellWidth, cellHeight,
          0, 0, cellWidth, cellHeight
        )
        const imageData = tempCtx.getImageData(0, 0, cellWidth, cellHeight)
        const { data, width: w, height: h } = imageData
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
            hasPixels = true
            minX = Math.min(minX, px)
            minY = Math.min(minY, py)
            maxX = Math.max(maxX, px)
            maxY = Math.max(maxY, py)
          }
        }
        if (!hasPixels) continue
        const cropWidth = maxX - minX + 1
        const cropHeight = maxY - minY + 1
        const croppedCanvas = document.createElement('canvas')
        croppedCanvas.width = cropWidth
        croppedCanvas.height = cropHeight
        const croppedCtx = croppedCanvas.getContext('2d', READBACK_CONTEXT_OPTIONS)
        if (!croppedCtx) continue
        croppedCtx.imageSmoothingEnabled = false
        croppedCtx.drawImage(tempCanvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight)
        const stampPathNormal = bitmapToSvgPath(croppedCanvas, false, STAMP_PATH_RESOLUTION)
        const stampPathInverted = bitmapToSvgPath(croppedCanvas, true, STAMP_PATH_RESOLUTION)
        if (stampPathNormal) pool.push({ stampPath: stampPathNormal, stampWidth: cropWidth, stampHeight: cropHeight, stampPathResolution: STAMP_PATH_RESOLUTION })
        if (stampPathInverted) pool.push({ stampPath: stampPathInverted, stampWidth: cropWidth, stampHeight: cropHeight, stampPathResolution: STAMP_PATH_RESOLUTION })
      }
    }
    return pool
  }

  function createStampShape(x, y, stampData, color) {
    const scale = getStampScale()
    const svgPath = bitmapToSvgPath(stampData.canvas, stampInvert, STAMP_PATH_RESOLUTION)
    const rawSize = Math.max(stampData.width, stampData.height)
    const pattern = stampTextureSelect.value || 'solid'
    return {
      type: 'stamp',
      x,
      y,
      size: rawSize * scale,
      color,
      pattern,
      rotation: 0,
      layer: 'stamps',
      id: `shape-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      stampPath: svgPath,
      stampWidth: stampData.width,
      stampHeight: stampData.height,
      stampPathResolution: STAMP_PATH_RESOLUTION,
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
        stampScale: getStampScale(),
        stampPattern: stampTextureSelect.value || 'solid',
        colorPalette: [...colorPalette],
        background: getBackground(),
        statsText,
      })
    )
  }

  function persistMetadata(svg, metadata) {
    const metadataNode = svg.querySelector('#occult-floorplan-meta')
    if (metadataNode != null) metadataNode.textContent = encodeSvgMetadata(metadata)
    const stampPreview = svg.querySelector('#stamp-preview')
    if (stampPreview) stampPreview.remove()
    latestSvg = svg.outerHTML
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
        if (e.shiftKey) {
          if (selectedShapeIds.has(id)) {
            selectedShapeIds.delete(id)
          } else {
            selectedShapeIds.add(id)
          }
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
    const svg = previewContent.querySelector('svg')
    if (!svg) return
    const metadata = decodeSvgMetadata(svg)
    if (!metadata) return
    
    // Update shape visual selection
    svg.querySelectorAll('.art-shape').forEach((element) => {
      const id = element.getAttribute('data-id')
      element.classList.toggle('is-selected', id != null && selectedShapeIds.has(id))
    })
    
    // Add selection outlines
    let outlineGroup = svg.querySelector('#selection-outlines')
    if (!outlineGroup) {
      outlineGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      outlineGroup.id = 'selection-outlines'
      svg.appendChild(outlineGroup)
    }
    outlineGroup.innerHTML = ''
    
    const baseViewBox = readBaseViewBox(svg)
    const refSize = 1200
    const canvasSize = baseViewBox ? Math.min(baseViewBox.width, baseViewBox.height) : refSize
    const scale = canvasSize / refSize
    const padding = Math.max(1, 4 * scale)
    const outlineStrokeWidth = Math.max(0.5, 2 * scale)
    const outlineDashLen = Math.max(1, 4 * scale)
    const gizmoRadius = Math.max(2, 6 * scale)
    const gizmoStrokeWidth = Math.max(0.5, 2 * scale)

    selectedShapeIds.forEach(id => {
      const shape = metadata.shapes.find(s => s.id === id)
      if (!shape) return
      
      const outlineX = shape.x - shape.size / 2 - padding
      const outlineY = shape.y - shape.size / 2 - padding
      const outlineWidth = shape.size + padding * 2
      const outlineHeight = shape.size + padding * 2
      
      const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      outline.setAttribute('x', outlineX)
      outline.setAttribute('y', outlineY)
      outline.setAttribute('width', outlineWidth)
      outline.setAttribute('height', outlineHeight)
      outline.setAttribute('fill', 'none')
      outline.setAttribute('stroke', '#00ffff')
      outline.setAttribute('stroke-width', String(outlineStrokeWidth))
      outline.setAttribute('stroke-dasharray', `${outlineDashLen} ${outlineDashLen}`)
      outline.style.pointerEvents = 'none'
      outlineGroup.appendChild(outline)
      
      // Add rotation gizmo in top right corner
      const rotateGizmoX = outlineX + outlineWidth
      const rotateGizmoY = outlineY
      
      const rotateGizmo = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      rotateGizmo.setAttribute('cx', rotateGizmoX)
      rotateGizmo.setAttribute('cy', rotateGizmoY)
      rotateGizmo.setAttribute('r', gizmoRadius)
      rotateGizmo.setAttribute('fill', '#00ffff')
      rotateGizmo.setAttribute('stroke', '#ffffff')
      rotateGizmo.setAttribute('stroke-width', String(gizmoStrokeWidth))
      rotateGizmo.style.cursor = 'grab'
      rotateGizmo.style.pointerEvents = 'all'
      rotateGizmo.setAttribute('data-rotation-gizmo', id)
      const rotateTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      rotateTitle.textContent = 'Rotate (snaps to 45°; hold Shift for free rotation)'
      rotateGizmo.appendChild(rotateTitle)
      outlineGroup.appendChild(rotateGizmo)
      
      // Add scale gizmo in bottom right corner
      const scaleGizmoX = outlineX + outlineWidth
      const scaleGizmoY = outlineY + outlineHeight
      
      const scaleGizmo = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      scaleGizmo.setAttribute('x', scaleGizmoX - gizmoRadius)
      scaleGizmo.setAttribute('y', scaleGizmoY - gizmoRadius)
      scaleGizmo.setAttribute('width', gizmoRadius * 2)
      scaleGizmo.setAttribute('height', gizmoRadius * 2)
      scaleGizmo.setAttribute('fill', '#ffff00')
      scaleGizmo.setAttribute('stroke', '#ffffff')
      scaleGizmo.setAttribute('stroke-width', String(gizmoStrokeWidth))
      scaleGizmo.style.cursor = 'nwse-resize'
      scaleGizmo.style.pointerEvents = 'all'
      scaleGizmo.setAttribute('data-scale-gizmo', id)
      outlineGroup.appendChild(scaleGizmo)
    })
    
    renderLayerList(metadata)
    renderEntityList(metadata)
  }

  function bindSvgInteractions() {
    const svg = previewContent.querySelector('svg')
    if (!svg) return
    const metadata = decodeSvgMetadata(svg)
    if (!metadata) return
    const viewBox = parseViewBox(svg)
    if (!viewBox) return
    
    metadata.shapes = Array.isArray(metadata.shapes) ? metadata.shapes : []
    if (!metadata.background) metadata.background = getBackground()
    
    // Assign layers to shapes that don't have them
    let needsUpdate = false
    metadata.shapes.forEach((shape, index) => {
      if (!shape.layer || shape.layer < 1) {
        shape.layer = (index % 5) + 1 // Distribute across 5 layers
        needsUpdate = true
      }
    })
    
    if (needsUpdate) {
      // Update the SVG elements with layer data
      svg.querySelectorAll('.art-shape').forEach((element) => {
        const id = element.getAttribute('data-id')
        const shape = metadata.shapes.find(s => s.id === id)
        if (shape && shape.layer) {
          element.setAttribute('data-layer', shape.layer)
        }
      })
    persistMetadata(svg, metadata)
    }

    // Add canvas boundary for editor preview only (not exported)
    if (!svg.querySelector('.canvas-boundary')) {
      const baseViewBox = readBaseViewBox(svg)
      if (baseViewBox) {
        const refSize = 1200
        const canvasSize = Math.min(baseViewBox.width, baseViewBox.height)
        const scale = canvasSize / refSize
        const strokeWidth = Math.max(0.5, 4 * scale)
        const dashLen = Math.max(2, 12 * scale)
        const gapLen = Math.max(2, 8 * scale)
        const boundary = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        boundary.classList.add('canvas-boundary')
        boundary.setAttribute('x', String(strokeWidth / 2))
        boundary.setAttribute('y', String(strokeWidth / 2))
        boundary.setAttribute('width', baseViewBox.width - strokeWidth)
        boundary.setAttribute('height', baseViewBox.height - strokeWidth)
        boundary.setAttribute('fill', 'none')
        boundary.setAttribute('stroke', '#00ffff')
        boundary.setAttribute('stroke-width', String(strokeWidth))
        boundary.setAttribute('stroke-dasharray', `${dashLen} ${gapLen}`)
        boundary.setAttribute('opacity', '0.8')
        boundary.style.pointerEvents = 'none'
        svg.appendChild(boundary)
      }
    }

    updateSelection()

    const svgPoint = svg.createSVGPoint()
    const toSvgCoordinates = (event) => {
      const ctm = svg.getScreenCTM()
      if (!ctm) return null
      svgPoint.x = event.clientX
      svgPoint.y = event.clientY
      return svgPoint.matrixTransform(ctm.inverse())
    }

    // Hover outline - only when grab/selection tool active (!stampMode)
    let hoverOutlineEl = null
    let hoveredShapeEl = null
    const clearHoverOutline = () => {
      if (hoverOutlineEl) {
        hoverOutlineEl.remove()
        hoverOutlineEl = null
      }
      const hoverOutlinesGroup = svg.querySelector('#hover-outlines')
      if (hoverOutlinesGroup) hoverOutlinesGroup.remove()
      hoveredShapeEl = null
    }
    const updateHoverOutline = (target) => {
      if (stampMode) return
      const shapeEl = target?.closest('.art-shape')
      if (shapeEl?.closest('#selection-outlines')) return
      if (shapeEl === hoveredShapeEl) return
      clearHoverOutline()
      hoveredShapeEl = shapeEl
      if (!shapeEl) return
      const baseViewBox = readBaseViewBox(svg)
      const refSize = 1200
      const canvasSize = baseViewBox ? Math.min(baseViewBox.width, baseViewBox.height) : refSize
      const scale = canvasSize / refSize
      const strokeWidth = Math.max(0.5, 3 * scale)
      const padding = Math.max(2, 4 * scale)
      const planX = parseFloat(shapeEl.getAttribute('data-plan-x')) || 0
      const planY = parseFloat(shapeEl.getAttribute('data-plan-y')) || 0
      const transformStr = shapeEl.getAttribute('transform') || ''
      const rotateMatch = transformStr.match(/rotate\s*\(\s*([-\d.]+)/)
      const rotationRad = rotateMatch ? (parseFloat(rotateMatch[1]) * Math.PI) / 180 : 0
      const cos = Math.cos(rotationRad)
      const sin = Math.sin(rotationRad)
      const localBBox = shapeEl.getBBox()
      const toRoot = (lx, ly) => ({
        x: planX + lx * cos - ly * sin,
        y: planY + lx * sin + ly * cos,
      })
      const c1 = toRoot(localBBox.x, localBBox.y)
      const c2 = toRoot(localBBox.x + localBBox.width, localBBox.y)
      const c3 = toRoot(localBBox.x + localBBox.width, localBBox.y + localBBox.height)
      const c4 = toRoot(localBBox.x, localBBox.y + localBBox.height)
      const minX = Math.min(c1.x, c2.x, c3.x, c4.x)
      const minY = Math.min(c1.y, c2.y, c3.y, c4.y)
      const maxX = Math.max(c1.x, c2.x, c3.x, c4.x)
      const maxY = Math.max(c1.y, c2.y, c3.y, c4.y)
      const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      outline.setAttribute('x', minX - padding)
      outline.setAttribute('y', minY - padding)
      outline.setAttribute('width', maxX - minX + padding * 2)
      outline.setAttribute('height', maxY - minY + padding * 2)
      outline.setAttribute('fill', 'none')
      outline.setAttribute('stroke', 'rgba(255, 105, 180, 0.9)')
      outline.setAttribute('stroke-width', String(strokeWidth))
      outline.style.pointerEvents = 'none'
      outline.classList.add('hover-outline')
      let hoverOutlinesGroup = svg.querySelector('#hover-outlines')
      if (!hoverOutlinesGroup) {
        hoverOutlinesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        hoverOutlinesGroup.id = 'hover-outlines'
        svg.appendChild(hoverOutlinesGroup)
      }
      hoverOutlinesGroup.appendChild(outline)
      hoverOutlineEl = outline
    }

    svg.addEventListener('pointerover', (e) => {
      if (stampMode && stampShape) {
        clearHoverOutline()
      } else {
        updateHoverOutline(e.target)
      }
    })
    svg.addEventListener('pointermove', (e) => {
      if (stampMode && stampShape) {
        clearHoverOutline()
      } else {
        updateHoverOutline(e.target)
      }
    })
    svg.addEventListener('pointerout', (e) => {
      if (!e.relatedTarget || !svg.contains(e.relatedTarget)) {
        clearHoverOutline()
      }
    })

    const toViewBoxDelta = (deltaPixelsX, deltaPixelsY) => {
      const rect = svg.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      return {
        x: (deltaPixelsX / rect.width) * viewBox.width,
        y: (deltaPixelsY / rect.height) * viewBox.height,
      }
    }
    const baseViewBox = readBaseViewBox(svg)
    const minViewBoxWidth = Math.max(1, (baseViewBox?.width ?? viewBox.width) * 0.2)
    const minViewBoxHeight = Math.max(1, (baseViewBox?.height ?? viewBox.height) * 0.2)
    const maxViewBoxWidth = Math.max(viewBox.width * 8, (baseViewBox?.width ?? viewBox.width) * 8)
    const maxViewBoxHeight = Math.max(viewBox.height * 8, (baseViewBox?.height ?? viewBox.height) * 8)
    const zoomAtPointer = (event) => {
      const point = toSvgCoordinates(event)
      const currentViewBox = parseViewBox(svg)
      if (!point || !currentViewBox) return
      let delta = event.deltaY
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= 240
      const clampedDelta = Math.max(-120, Math.min(120, delta))
      const zoomFactor = Math.pow(1.0018, clampedDelta)
      const nextWidth = clamp(currentViewBox.width * zoomFactor, minViewBoxWidth, maxViewBoxWidth)
      const nextHeight = clamp(currentViewBox.height * zoomFactor, minViewBoxHeight, maxViewBoxHeight)
      if (
        Math.abs(nextWidth - currentViewBox.width) < 0.0001 &&
        Math.abs(nextHeight - currentViewBox.height) < 0.0001
      ) return
      const anchorX = (point.x - currentViewBox.minX) / currentViewBox.width
      const anchorY = (point.y - currentViewBox.minY) / currentViewBox.height
      const nextViewBox = {
        minX: point.x - anchorX * nextWidth,
        minY: point.y - anchorY * nextHeight,
        width: nextWidth,
        height: nextHeight,
      }
      svg.setAttribute('viewBox', `${nextViewBox.minX} ${nextViewBox.minY} ${nextViewBox.width} ${nextViewBox.height}`)
      const currentViewBoxRaw = svg.getAttribute('viewBox')
      persistMetadata(svg, metadata)
      const refreshedSvg = setSvgContent(latestSvg)
      if (refreshedSvg && currentViewBoxRaw) {
        refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
      }
      bindSvgInteractions()
    }

    svg.onpointerdown = (event) => {
      clearHoverOutline()
      // Check for rotation gizmo click
      const rotateGizmo = event.target.closest('[data-rotation-gizmo]')
      if (rotateGizmo) {
        const id = rotateGizmo.getAttribute('data-rotation-gizmo')
        const shape = metadata.shapes.find((entry) => entry.id === id)
        const point = toSvgCoordinates(event)
        if (!id || !shape || !point) return
        
        const startAngle = Math.atan2(point.y - shape.y, point.x - shape.x) * (180 / Math.PI)
        
        dragState = {
          kind: 'rotate',
          id,
          element: rotateGizmo,
          shapeElement: svg.querySelector(`.art-shape[data-id="${id}"]`),
          centerX: shape.x,
          centerY: shape.y,
          startRotation: shape.rotation,
          startAngle,
        }
        rotateGizmo.setPointerCapture(event.pointerId)
        rotateGizmo.style.cursor = 'grabbing'
        event.preventDefault()
        return
      }
      
      // Check for scale gizmo click
      const scaleGizmo = event.target.closest('[data-scale-gizmo]')
      if (scaleGizmo) {
        const id = scaleGizmo.getAttribute('data-scale-gizmo')
        const shape = metadata.shapes.find((entry) => entry.id === id)
        const point = toSvgCoordinates(event)
        if (!id || !shape || !point) return
        
        const startDistance = Math.sqrt(
          Math.pow(point.x - shape.x, 2) + Math.pow(point.y - shape.y, 2)
        )
        
        dragState = {
          kind: 'scale',
          id,
          element: scaleGizmo,
          shapeElement: svg.querySelector(`.art-shape[data-id="${id}"]`),
          centerX: shape.x,
          centerY: shape.y,
          startSize: shape.size,
          startDistance,
        }
        scaleGizmo.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
      
      // Stamp mode - placement handled by previewContent click; here we just prevent pan/drag
      if (stampMode && !stampShape) {
        showToast('Select a stamp first')
        event.preventDefault()
        return
      }
      if (stampMode && stampShape) {
        event.preventDefault()
        return
      }
      
      const shapeElement = event.target.closest('.art-shape')
      if (shapeElement) {
        const id = shapeElement.getAttribute('data-id')
        const shape = metadata.shapes.find((entry) => entry.id === id)
        const point = toSvgCoordinates(event)
        if (!id || !shape || !point) return
        
        // Multi-select with shift
        if (event.shiftKey) {
          if (selectedShapeIds.has(id)) {
            selectedShapeIds.delete(id)
          } else {
            selectedShapeIds.add(id)
          }
          updateSelection()
          event.preventDefault()
          return
        }
        
        // Single select and start drag
        if (!selectedShapeIds.has(id)) {
          selectedShapeIds.clear()
          selectedShapeIds.add(id)
          selectedLayer = null
          updateSelection()
        }
        
        dragState = {
          kind: 'shape',
          id,
          element: shapeElement,
          startX: shape.x,
          startY: shape.y,
          offsetX: point.x - shape.x,
          offsetY: point.y - shape.y,
        }
        shapeElement.setPointerCapture(event.pointerId)
        event.preventDefault()
        return
      }
      selectedShapeIds.clear()
      selectedLayer = null
      const currentViewBox = parseViewBox(svg)
      if (!currentViewBox) return
      updateSelection()
      dragState = {
        kind: 'pan',
        element: svg,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewBox: currentViewBox,
      }
      svg.setPointerCapture(event.pointerId)
      svg.classList.add('is-panning')
      event.preventDefault()
    }

    svg.onpointermove = (event) => {
      if (!dragState) return
      if (dragState.kind === 'pan') {
        const delta = toViewBoxDelta(
          event.clientX - dragState.startClientX,
          event.clientY - dragState.startClientY
        )
        if (!delta) return
        svg.setAttribute(
          'viewBox',
          `${dragState.startViewBox.minX - delta.x} ${dragState.startViewBox.minY - delta.y} ${dragState.startViewBox.width} ${dragState.startViewBox.height}`
        )
        return
      }
      if (dragState.kind === 'rotate') {
        const point = toSvgCoordinates(event)
        if (!point) return
        
        const currentAngle = Math.atan2(point.y - dragState.centerY, point.x - dragState.centerX) * (180 / Math.PI)
        const angleDelta = currentAngle - dragState.startAngle
        let newRotation = (dragState.startRotation + angleDelta) % 360
        if (newRotation < 0) newRotation += 360
        if (!event.shiftKey) {
          newRotation = Math.round(newRotation / 45) * 45
          newRotation = newRotation % 360
        }
        
        const shape = metadata.shapes.find((entry) => entry.id === dragState.id)
        if (!shape) return
        
        shape.rotation = newRotation
        const transform = `translate(${shape.x}, ${shape.y}) rotate(${shape.rotation})`
        dragState.shapeElement.setAttribute('transform', transform)
        return
      }
      if (dragState.kind === 'scale') {
        const point = toSvgCoordinates(event)
        if (!point) return
        
        const currentDistance = Math.sqrt(
          Math.pow(point.x - dragState.centerX, 2) + Math.pow(point.y - dragState.centerY, 2)
        )
        
        const scaleFactor = currentDistance / dragState.startDistance
        const newSize = Math.max(4, dragState.startSize * scaleFactor) // Minimum size of 4
        
        const shape = metadata.shapes.find((entry) => entry.id === dragState.id)
        if (!shape) return
        
        shape.size = newSize
        
        // Update the shape's visual representation
        const transform = `translate(${shape.x}, ${shape.y}) rotate(${shape.rotation})`
        dragState.shapeElement.setAttribute('transform', transform)
        
        // Update the shape's size attribute based on type
        if (shape.type === 'circle') {
          const circle = dragState.shapeElement.querySelector('circle')
          if (circle) {
            circle.setAttribute('r', newSize / 2)
          }
        } else if (shape.type === 'stamp') {
          const path = dragState.shapeElement.querySelector('path')
          if (path && shape.stampWidth && shape.stampHeight) {
            const res = shape.stampPathResolution || 1
            const scale = (newSize / Math.max(shape.stampWidth, shape.stampHeight)) * res
            const centerX = shape.stampWidth / (2 * res)
            const centerY = shape.stampHeight / (2 * res)
            path.setAttribute('transform', `translate(${-centerX * scale}, ${-centerY * scale}) scale(${scale})`)
          }
        } else {
          // Rectangle
          const rect = dragState.shapeElement.querySelector('rect')
          if (rect) {
            const halfSize = newSize / 2
            rect.setAttribute('x', -halfSize)
            rect.setAttribute('y', -halfSize)
            rect.setAttribute('width', newSize)
            rect.setAttribute('height', newSize)
          }
        }
        return
      }
      const point = toSvgCoordinates(event)
      if (!point) return
      if (dragState.kind === 'shape') {
        const shape = metadata.shapes.find((entry) => entry.id === dragState.id)
        if (!shape) return
        shape.x = point.x - dragState.offsetX
        shape.y = point.y - dragState.offsetY
        const transform = `translate(${shape.x}, ${shape.y}) rotate(${shape.rotation})`
        dragState.element.setAttribute('transform', transform)
        dragState.element.setAttribute('data-plan-x', String(shape.x))
        dragState.element.setAttribute('data-plan-y', String(shape.y))
        updateSelection()
      }
    }

    const endDrag = (event) => {
      if (!dragState) return
      clearHoverOutline()
      dragState.element.releasePointerCapture(event.pointerId)
      svg.classList.remove('is-panning')
      
      // Reset rotation gizmo cursor if it was being dragged
      if (dragState.kind === 'rotate') {
        const gizmo = svg.querySelector(`[data-rotation-gizmo="${dragState.id}"]`)
        if (gizmo) {
          gizmo.style.cursor = 'grab'
        }
      }
      
      dragState = null
      persistMetadata(svg, metadata)
      updateSelection()
    }
    svg.onpointerup = endDrag
    svg.onpointercancel = endDrag
    svg.onwheel = (event) => {
      if (dragState) return
      event.preventDefault()
      zoomAtPointer(event)
    }
  }

  function setLoadingOverlay(visible) {
    loadingOverlay.classList.toggle('is-visible', visible)
    loadingOverlay.setAttribute('aria-hidden', String(!visible))
  }

  async function generate() {
    if (isGenerating) return
    isGenerating = true
    const stampPool = getStampPool()
    if (!stampPool.length) {
      showToast('Load a stamp sheet first.')
      isGenerating = false
      setGeneratingState(false)
      return
    }
    setLoadingOverlay(true)
    const spreadRaw = parseFloat(spreadRow.input.value)
    const spread = Number.isFinite(spreadRaw) ? Math.max(spreadMin, Math.min(spreadMax, spreadRaw)) : spreadDefault
    const options = {
      seed: readPositiveInt(seed.input, Date.now()),
      width: readPositiveInt(width.input, 1200),
      height: readPositiveInt(height.input, 2400),
      shapeCount: readBoundedInt(shapeCount.input, 80, 20, 300),
      spread,
      minSize: readBoundedInt(minSize.input, 8, 2, 100),
      maxSize: readBoundedInt(maxSize.input, 120, 10, 300),
      minTextureScale: parseFloat(minTextureScale.input.value) || 0.5,
      maxTextureScale: parseFloat(maxTextureScale.input.value) || 2,
      randomRotation: randomRotationCheckbox.checked,
      colors: getColorsForGeneration(),
      stamps: stampPool,
    }
    seed.input.value = String(options.seed)
    status.textContent = 'Generating art grid...'
    setGeneratingState(true)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    try {
      const currentSvg = previewContent.querySelector('svg')
      const previousViewBoxRaw = currentSvg ? (parseViewBoxFromRaw(currentSvg.getAttribute('viewBox')) ? currentSvg.getAttribute('viewBox') : null) : null
      const existingStampShapes = (() => {
        if (selectedLayer === 'stamps') return []
        if (!currentSvg) return []
        const metadata = decodeSvgMetadata(currentSvg)
        if (!metadata?.shapes) return []
        return metadata.shapes.filter((s) => s.layer === 'stamps')
      })()
      const grid = generateArtGrid(options)
      if (existingStampShapes.length > 0) {
        grid.shapes.push(...existingStampShapes)
        grid.meta.shapeCount = grid.shapes.length
      }
      grid.background = getBackground()
      latestSvg = renderArtGridSvg(grid)
      const generatedSvg = setSvgContent(latestSvg)
      if (generatedSvg) {
        const baseViewBox = readBaseViewBox(generatedSvg) ?? { minX: 0, minY: 0, width: options.width, height: options.height }
        const W = baseViewBox.width
        const H = baseViewBox.height
        const margin = Math.max(W, H) * 0.15
        const vx = baseViewBox.minX - margin
        const vy = baseViewBox.minY - margin
        const vw = W + margin * 2
        const vh = H + margin * 2
        generatedSvg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`)
        latestSvg = generatedSvg.outerHTML
      }
      const statsText = `Shapes: ${grid.meta.shapeCount} · Size: ${grid.meta.width}×${grid.meta.height}px`
      stats.textContent = statsText
      persistSettings(statsText)
      selectedShapeIds.clear()
      selectedLayer = null
      setLoadingOverlay(false)
      bindSvgInteractions()
      updateSelection()
      status.textContent = 'Art grid generated.'
    } catch (error) {
      status.textContent = `Could not generate art grid: ${error instanceof Error ? error.message : 'Unknown error'}`
    } finally {
      setLoadingOverlay(false)
      isGenerating = false
      setGeneratingState(false)
    }
  }

  deleteEntityBtn.addEventListener('click', () => {
    const svg = previewContent.querySelector('svg')
    if (!svg) return
    const metadata = decodeSvgMetadata(svg)
    if (!metadata) return
    metadata.shapes = Array.isArray(metadata.shapes) ? metadata.shapes : []
    if (selectedShapeIds.size > 0) {
      const currentViewBoxRaw = svg.getAttribute('viewBox')
      selectedShapeIds.forEach(id => {
        metadata.shapes = metadata.shapes.filter((entry) => entry.id !== id)
      })
      selectedShapeIds.clear()
      selectedLayer = null
      const grid = {
        meta: {
          width: readPositiveInt(width.input, 1200),
          height: readPositiveInt(height.input, 2400),
          seed: readPositiveInt(seed.input, Date.now()),
          shapeCount: metadata.shapes.length,
        },
        shapes: metadata.shapes,
        background: getBackground(),
      }
      latestSvg = renderArtGridSvg(grid)
      const refreshedSvg = setSvgContent(latestSvg)
      if (refreshedSvg && currentViewBoxRaw) {
        refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
      }
      bindSvgInteractions()
      status.textContent = 'Shape deleted.'
      return
    }
    status.textContent = 'Select a shape first.'
  })

  window.addEventListener('keydown', (event) => {
    if (previewContainer.classList.contains('hidden')) return
    const target = event.target
    const inInput = target && (target.closest('input') || target.closest('textarea') || target.closest('select'))
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedShapeIds.size > 0) {
      deleteEntityBtn.click()
      event.preventDefault()
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
    // If a layer is selected, only regenerate shapes in that layer
    if (selectedLayer !== null) {
      const svg = previewContent.querySelector('svg')
      if (!svg) return
      const metadata = decodeSvgMetadata(svg)
      if (!metadata) return
      const stampPool = getStampPool()
      if (!stampPool.length) {
        showToast('Load a stamp sheet first.')
        return
      }
      setLoadingOverlay(true)
      // Yield so the browser paints the loading overlay before we block the main thread
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            const currentViewBoxRaw = svg.getAttribute('viewBox')
            const canvasWidth = readPositiveInt(width.input, 1200)
            const canvasHeight = readPositiveInt(height.input, 2400)
            const layerShapes = metadata.shapes.filter(s => s.layer === selectedLayer)
            const otherShapes = metadata.shapes.filter(s => s.layer !== selectedLayer)
            const layerSpreadRaw = parseFloat(spreadRow.input.value)
            const layerSpread = Number.isFinite(layerSpreadRaw) ? Math.max(spreadMin, Math.min(spreadMax, layerSpreadRaw)) : spreadDefault
            const layerOptions = {
              seed: randomSeed(),
              width: canvasWidth,
              height: canvasHeight,
              shapeCount: layerShapes.length,
              spread: layerSpread,
              minSize: readBoundedInt(minSize.input, 8, 2, 100),
              maxSize: readBoundedInt(maxSize.input, 120, 10, 300),
              minTextureScale: parseFloat(minTextureScale.input.value) || 0.5,
              maxTextureScale: parseFloat(maxTextureScale.input.value) || 2,
              randomRotation: randomRotationCheckbox.checked,
              colors: getColorsForGeneration(),
              stamps: stampPool,
            }
            const layerGrid = generateArtGrid(layerOptions)
            const newLayerShapes = layerGrid.shapes.map((s) => ({ ...s, layer: selectedLayer }))
            metadata.shapes = [...otherShapes, ...newLayerShapes]
            const grid = {
              meta: {
                width: canvasWidth,
                height: canvasHeight,
                seed: readPositiveInt(seed.input, Date.now()),
                shapeCount: metadata.shapes.length,
              },
              shapes: metadata.shapes,
              background: getBackground(),
            }
            latestSvg = renderArtGridSvg(grid)
            const refreshedSvg = setSvgContent(latestSvg)
            if (refreshedSvg && currentViewBoxRaw) {
              refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
            }
            selectedShapeIds.clear()
            newLayerShapes.forEach(shape => selectedShapeIds.add(shape.id))
            bindSvgInteractions()
            status.textContent = `Regenerated ${newLayerShapes.length} shapes in Layer ${selectedLayer}.`
          } finally {
            setLoadingOverlay(false)
          }
        })
      })
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

  // First generate runs from loadStampSheet's img.onload once the stamp sheet is ready
}
