import { generateArtGrid, renderArtGridSvg } from './art-grid-engine.js'

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
const LATEST_SVG_KEY = 'artGrid.latestSvg'
const DEFAULT_COLORS = ['#00ff00', '#ff0000', '#00ffff', '#ff00ff', '#ffff00', '#ffffff', '#0000ff']

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

function getExportReadySvg(svgText) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(svgText, 'image/svg+xml')
  const svg = doc.querySelector('svg')
  if (!svg) return svgText
  svg.querySelectorAll('.canvas-boundary, #selection-outlines').forEach((el) => el.remove())
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

  const preview = document.createElement('section')
  preview.className = 'floor-plan-preview'
  const previewContent = document.createElement('div')
  previewContent.className = 'floor-plan-preview-content'
  const svgWrapper = document.createElement('div')
  svgWrapper.className = 'color-palette-svg-wrapper'
  previewContent.appendChild(svgWrapper)
  preview.appendChild(previewContent)
  previewContainer.appendChild(preview)

  const getColorsForGeneration = () =>
    colorPalette.length > 0 ? colorPalette : DEFAULT_COLORS
  
  // Click outside SVG to disable stamp mode (setStampMode defined after controls)
  let setStampMode = null
  previewContent.addEventListener('click', (e) => {
    const clickedOnSvg = e.target.closest('svg') || e.target.tagName === 'svg'
    if (stampMode && !clickedOnSvg && setStampMode) {
      setStampMode(false)
      status.textContent = 'Stamp mode disabled (clicked outside canvas).'
    }
  })

  const controls = document.createElement('div')
  controls.className = 'floor-plan-controls'
  
  // Create consolidated tools panel (Settings + Stamp Tool with tabs)
  const toolsPanel = document.createElement('div')
  toolsPanel.className = 'panel'
  toolsPanel.id = 'tools-panel'
  
  const toolsHeader = document.createElement('button')
  toolsHeader.className = 'panel-header'
  toolsHeader.type = 'button'
  toolsHeader.innerHTML = '<span class="panel-chevron">▼</span>Tools'
  toolsHeader.addEventListener('click', () => {
    toolsPanel.classList.toggle('collapsed')
  })
  
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

  settingsContent.append(
    seed.row,
    canvasSizeRow,
    shapeCount.row,
    minSize.row,
    maxSize.row,
    minTextureScale.row,
    maxTextureScale.row
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
  
  const stampPreview = document.createElement('canvas')
  stampPreview.style.width = '64px'
  stampPreview.style.height = '64px'
  stampPreview.style.border = '2px solid var(--tui-line-strong)'
  stampPreview.style.display = 'none'
  stampPreview.style.imageRendering = 'pixelated'
  stampPreview.width = 64
  stampPreview.height = 64
  
  stampControls.append(invertToggle, stampPreview)
  stampContent.append(uploadLabel, uploadInput, sheetCanvas, stampControls)
  
  // Tools tab bar and panels
  const toolsTabBar = document.createElement('div')
  toolsTabBar.className = 'entities-tabs'
  const stampTab = document.createElement('button')
  stampTab.type = 'button'
  stampTab.className = 'entities-tab is-active'
  stampTab.textContent = 'Stamps'
  stampTab.setAttribute('data-tab', 'stamp')
  const settingsTab = document.createElement('button')
  settingsTab.type = 'button'
  settingsTab.className = 'entities-tab'
  settingsTab.textContent = 'Settings'
  settingsTab.setAttribute('data-tab', 'settings')
  const paletteTab = document.createElement('button')
  paletteTab.type = 'button'
  paletteTab.className = 'entities-tab'
  paletteTab.textContent = 'Colors'
  paletteTab.setAttribute('data-tab', 'palette')
  toolsTabBar.append(stampTab, settingsTab, paletteTab)
  
  const toolsTabPanels = document.createElement('div')
  toolsTabPanels.className = 'entities-tab-panels'
  
  const stampTabPanel = document.createElement('div')
  stampTabPanel.className = 'entities-tab-panel is-active'
  stampTabPanel.setAttribute('data-panel', 'stamp')
  stampTabPanel.append(stampContent)
  
  const settingsTabPanel = document.createElement('div')
  settingsTabPanel.className = 'entities-tab-panel'
  settingsTabPanel.setAttribute('data-panel', 'settings')
  settingsTabPanel.append(settingsContent)
  
  const paletteTabPanel = document.createElement('div')
  paletteTabPanel.className = 'entities-tab-panel'
  paletteTabPanel.setAttribute('data-panel', 'palette')
  const paletteContent = document.createElement('div')
  paletteContent.className = 'panel-content'
  const paletteListEl = document.createElement('ul')
  paletteListEl.className = 'color-palette-list'
  const paletteAddBtn = document.createElement('button')
  paletteAddBtn.type = 'button'
  paletteAddBtn.textContent = 'Add color'
  paletteAddBtn.style.marginTop = '8px'
  paletteAddBtn.style.width = '100%'
  const paletteHint = document.createElement('p')
  paletteHint.className = 'floor-plan-status'
  paletteHint.style.margin = '8px 0 0'
  paletteHint.textContent = 'Define colors used when generating shapes. Leave empty to use default colors.'
  paletteContent.append(paletteListEl, paletteAddBtn, paletteHint)
  paletteTabPanel.append(paletteContent)
  
  function renderPaletteList() {
    paletteListEl.innerHTML = ''
    colorPalette.forEach((color, i) => {
      const li = document.createElement('li')
      li.className = 'color-palette-list-item'
      const colorInput = document.createElement('input')
      colorInput.type = 'color'
      colorInput.value = color
      colorInput.className = 'color-palette-picker'
      const label = document.createElement('span')
      label.textContent = color
      label.className = 'color-palette-hex'
      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.textContent = 'Delete'
      deleteBtn.style.marginLeft = 'auto'
      li.append(colorInput, label, deleteBtn)
      li.style.cursor = 'pointer'
      label.style.cursor = 'pointer'
      li.addEventListener('click', (e) => {
        if (e.target === deleteBtn) return
        colorInput.click()
      })
      colorInput.addEventListener('input', () => {
        colorPalette[i] = colorInput.value
        label.textContent = colorInput.value
        persistSettings(stats?.textContent ?? '')
      })
      colorInput.addEventListener('change', () => {
        colorPalette[i] = colorInput.value
        label.textContent = colorInput.value
        renderPaletteList()
        persistSettings(stats?.textContent ?? '')
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
  }
  paletteAddBtn.addEventListener('click', () => {
    colorPalette.push('#808080')
    renderPaletteList()
    persistSettings(stats?.textContent ?? '')
  })
  renderPaletteList()
  
  toolsTabPanels.append(stampTabPanel, settingsTabPanel, paletteTabPanel)
  
  const toolsContent = document.createElement('div')
  toolsContent.className = 'panel-content'
  toolsContent.append(toolsTabBar, toolsTabPanels)
  
  const switchToolsTab = (tabId) => {
    toolsTabBar.querySelectorAll('.entities-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-tab') === tabId)
    })
    toolsTabPanels.querySelectorAll('.entities-tab-panel').forEach((panel) => {
      panel.classList.toggle('is-active', panel.getAttribute('data-panel') === tabId)
    })
  }
  stampTab.addEventListener('click', () => switchToolsTab('stamp'))
  settingsTab.addEventListener('click', () => switchToolsTab('settings'))
  paletteTab.addEventListener('click', () => switchToolsTab('palette'))
  
  toolsPanel.append(toolsHeader, toolsContent)

  const actions = document.createElement('div')
  actions.className = 'floor-plan-actions'
  actions.style.position = 'sticky'
  actions.style.top = '0'
  actions.style.backgroundColor = 'var(--tui-bg)'
  actions.style.zIndex = '5'
  actions.style.paddingBottom = 'var(--tui-gap)'
  const randomizeBtn = document.createElement('button')
  randomizeBtn.type = 'button'
  randomizeBtn.id = 'ag-randomize-seed'
  randomizeBtn.textContent = 'Generate'
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.id = 'ag-save-svg'
  saveBtn.textContent = 'Save SVG'
  actions.append(randomizeBtn, saveBtn)

  const status = document.createElement('p')
  status.className = 'floor-plan-status'
  status.textContent = 'Generate an art grid.'
  const stats = document.createElement('p')
  stats.className = 'floor-plan-stats'
  stats.textContent = saved?.statsText ?? ''
  controls.append(
    actions,
    toolsPanel
  )
  controlsContainer.appendChild(controls)

  const app = document.getElementById('app')
  const statusStatsWrap = document.createElement('div')
  statusStatsWrap.className = 'floor-plan-status-stats'
  statusStatsWrap.append(status, stats)
  if (app) app.appendChild(statusStatsWrap)

  // Mode toolbar (transform = selection, stamp = stamp mode, center camera)
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
  modeToolbar.append(transformIcon, stampIcon, centerCameraBtn)
  if (app) app.appendChild(modeToolbar)

  const updateModeUI = () => {
    transformIcon.classList.toggle('is-active', !stampMode)
    stampIcon.classList.toggle('is-active', stampMode)
  }
  setStampMode = (enabled) => {
    stampMode = enabled
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
    }
    img.onerror = () => {
      if (src.includes('stamps.png')) {
        console.log('Default stamp sheet not found, upload your own.')
      }
    }
    img.src = src
  }
  
  // Load default sheet on mount
  loadStampSheet('/stamps.png')
  
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
    const tempCtx = tempCanvas.getContext('2d')
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
    const croppedCtx = croppedCanvas.getContext('2d')
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

  const entitiesWrap = document.createElement('div')
  entitiesWrap.className = 'floor-plan-entities'
  
  // Tab bar
  const tabBar = document.createElement('div')
  tabBar.className = 'entities-tabs'
  const shapesTab = document.createElement('button')
  shapesTab.type = 'button'
  shapesTab.className = 'entities-tab is-active'
  shapesTab.textContent = 'Shapes'
  shapesTab.setAttribute('data-tab', 'shapes')
  const layersTab = document.createElement('button')
  layersTab.type = 'button'
  layersTab.className = 'entities-tab'
  layersTab.textContent = 'Layers'
  layersTab.setAttribute('data-tab', 'layers')
  tabBar.append(shapesTab, layersTab)
  
  // Tab panels container
  const tabPanels = document.createElement('div')
  tabPanels.className = 'entities-tab-panels'
  
  // Shapes panel (default active)
  const shapesPanel = document.createElement('div')
  shapesPanel.className = 'entities-tab-panel is-active'
  shapesPanel.setAttribute('data-panel', 'shapes')
  const entityActions = document.createElement('div')
  entityActions.className = 'floor-plan-actions'
  const deleteEntityBtn = document.createElement('button')
  deleteEntityBtn.type = 'button'
  deleteEntityBtn.textContent = 'Delete selected'
  entityActions.append(deleteEntityBtn)
  const entitiesList = document.createElement('ul')
  entitiesList.className = 'floor-plan-entity-list'
  shapesPanel.append(entityActions, entitiesList)
  
  // Layers panel
  const layersPanel = document.createElement('div')
  layersPanel.className = 'entities-tab-panel'
  layersPanel.setAttribute('data-panel', 'layers')
  const layersList = document.createElement('ul')
  layersList.className = 'floor-plan-entity-list'
  layersPanel.append(layersList)
  
  tabPanels.append(shapesPanel, layersPanel)
  entitiesWrap.append(tabBar, tabPanels)
  entitiesContainer.appendChild(entitiesWrap)
  
  // Tab switching
  const switchTab = (tabId) => {
    tabBar.querySelectorAll('.entities-tab').forEach((btn) => {
      btn.classList.toggle('is-active', btn.getAttribute('data-tab') === tabId)
    })
    tabPanels.querySelectorAll('.entities-tab-panel').forEach((panel) => {
      panel.classList.toggle('is-active', panel.getAttribute('data-panel') === tabId)
    })
  }
  shapesTab.addEventListener('click', () => switchTab('shapes'))
  layersTab.addEventListener('click', () => switchTab('layers'))

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

  function showToast(message) {
    const toast = document.createElement('div')
    toast.className = 'toast'
    toast.textContent = message
    toast.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);padding:8px 16px;z-index:2000;'
    document.body.appendChild(toast)
    setTimeout(() => toast.remove(), 2500)
  }
  
  function bitmapToSvgPath(canvas, invert) {
    const ctx = canvas.getContext('2d')
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const { data, width, height } = imageData
    
    let path = ''
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const a = data[i + 3]
        
        if (a < 10) continue // Skip transparent
        
        const brightness = (r + g + b) / 3
        
        // Only process pure black or pure white pixels
        const isPureBlack = brightness < 50
        const isPureWhite = brightness > 205
        
        if (!isPureBlack && !isPureWhite) continue // Skip gray/grid pixels
        
        const isShape = invert ? isPureWhite : isPureBlack
        
        if (isShape) {
          path += `M${x},${y}h1v1h-1z`
        }
      }
    }
    
    return path
  }
  
  function createStampShape(x, y, stampData, color) {
    const svgPath = bitmapToSvgPath(stampData.canvas, stampInvert)
    const scale = 1 // You can adjust this
    const centerX = stampData.width / 2
    const centerY = stampData.height / 2
    
    return {
      type: 'stamp',
      x,
      y,
      size: Math.max(stampData.width, stampData.height),
      color,
      pattern: 'stamp',
      rotation: 0,
      layer: 'stamps',
      id: `shape-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      stampPath: svgPath,
      stampWidth: stampData.width,
      stampHeight: stampData.height,
    }
  }

  function setGeneratingState(generating) {
    randomizeBtn.disabled = generating
    saveBtn.disabled = generating
    deleteEntityBtn.disabled = generating
  }

  function persistSettings(statsText) {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        seed: readPositiveInt(seed.input, Date.now()),
        width: readPositiveInt(width.input, 1200),
        height: readPositiveInt(height.input, 2400),
        shapeCount: readBoundedInt(shapeCount.input, 80, 20, 300),
        minSize: readBoundedInt(minSize.input, 8, 2, 100),
        maxSize: readBoundedInt(maxSize.input, 120, 10, 300),
        minTextureScale: parseFloat(minTextureScale.input.value) || 0.5,
        maxTextureScale: parseFloat(maxTextureScale.input.value) || 2,
        colorPalette: [...colorPalette],
        statsText,
      })
    )
  }

  function persistMetadata(svg, metadata) {
    const metadataNode = svg.querySelector('#occult-floorplan-meta')
    if (metadataNode != null) metadataNode.textContent = encodeSvgMetadata(metadata)
    latestSvg = svg.outerHTML
    window.localStorage.setItem(LATEST_SVG_KEY, latestSvg)
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
    
    selectedShapeIds.forEach(id => {
      const shape = metadata.shapes.find(s => s.id === id)
      if (!shape) return
      
      const padding = 4
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
      outline.setAttribute('stroke-width', '2')
      outline.setAttribute('stroke-dasharray', '4 4')
      outline.style.pointerEvents = 'none'
      outlineGroup.appendChild(outline)
      
      const gizmoRadius = 6
      
      // Add rotation gizmo in top right corner
      const rotateGizmoX = outlineX + outlineWidth
      const rotateGizmoY = outlineY
      
      const rotateGizmo = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      rotateGizmo.setAttribute('cx', rotateGizmoX)
      rotateGizmo.setAttribute('cy', rotateGizmoY)
      rotateGizmo.setAttribute('r', gizmoRadius)
      rotateGizmo.setAttribute('fill', '#00ffff')
      rotateGizmo.setAttribute('stroke', '#ffffff')
      rotateGizmo.setAttribute('stroke-width', '2')
      rotateGizmo.style.cursor = 'grab'
      rotateGizmo.style.pointerEvents = 'all'
      rotateGizmo.setAttribute('data-rotation-gizmo', id)
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
      scaleGizmo.setAttribute('stroke-width', '2')
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
      svgWrapper.innerHTML = latestSvg
      const refreshedSvg = previewContent.querySelector('svg')
      if (refreshedSvg && currentViewBoxRaw) {
        refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
      }
      bindSvgInteractions()
    }

    svg.onpointerdown = (event) => {
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
      
      // Stamp mode - place stamp on canvas click (unless clicking on existing shape)
      if (stampMode && !stampShape) {
        showToast('Select a stamp first')
        event.preventDefault()
        return
      }
      if (stampMode && stampShape) {
        const clickedShape = event.target.closest('.art-shape')
        if (!clickedShape) {
          const point = toSvgCoordinates(event)
          if (!point) return
          
          const colors = getColorsForGeneration()
          const randomColor = colors[Math.floor(Math.random() * colors.length)]
          
          const newShape = createStampShape(point.x, point.y, stampShape, randomColor)
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
          }
          
          latestSvg = renderArtGridSvg(grid)
          svgWrapper.innerHTML = latestSvg
          const refreshedSvg = previewContent.querySelector('svg')
          if (refreshedSvg && currentViewBoxRaw) {
            refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
          }
          
          selectedShapeIds.clear()
          selectedShapeIds.add(newShape.id)
          bindSvgInteractions()
          status.textContent = 'Stamp placed.'
          event.preventDefault()
          return
        }
        // If stamp mode is on and we clicked an existing shape, don't allow dragging - just return
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
        const newRotation = (dragState.startRotation + angleDelta) % 360
        
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
          // For stamps, we need to scale the path transform
          const path = dragState.shapeElement.querySelector('path')
          if (path && shape.stampWidth && shape.stampHeight) {
            const scale = newSize / Math.max(shape.stampWidth, shape.stampHeight)
            const centerX = shape.stampWidth / 2
            const centerY = shape.stampHeight / 2
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
      }
    }

    const endDrag = (event) => {
      if (!dragState) return
      dragState.element.releasePointerCapture(event.pointerId)
      svg.classList.remove('is-panning')
      
      // Reset rotation gizmo cursor if it was being dragged
      if (dragState.kind === 'rotate') {
        const gizmo = svg.querySelector(`[data-rotation-gizmo="${dragState.id}"]`)
        if (gizmo) {
          gizmo.style.cursor = 'grab'
        }
      }
      
      const currentViewBoxRaw = svg.getAttribute('viewBox')
      dragState = null
      persistMetadata(svg, metadata)
      svgWrapper.innerHTML = latestSvg
      const refreshedSvg = previewContent.querySelector('svg')
      if (refreshedSvg && currentViewBoxRaw) {
        refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
      }
      bindSvgInteractions()
    }
    svg.onpointerup = endDrag
    svg.onpointercancel = endDrag
    svg.onwheel = (event) => {
      if (dragState) return
      event.preventDefault()
      zoomAtPointer(event)
    }
  }

  async function generate() {
    if (isGenerating) return
    isGenerating = true
    const options = {
      seed: readPositiveInt(seed.input, Date.now()),
      width: readPositiveInt(width.input, 1200),
      height: readPositiveInt(height.input, 2400),
      shapeCount: readBoundedInt(shapeCount.input, 80, 20, 300),
      minSize: readBoundedInt(minSize.input, 8, 2, 100),
      maxSize: readBoundedInt(maxSize.input, 120, 10, 300),
      minTextureScale: parseFloat(minTextureScale.input.value) || 0.5,
      maxTextureScale: parseFloat(maxTextureScale.input.value) || 2,
      colors: getColorsForGeneration(),
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
      latestSvg = renderArtGridSvg(grid)
      svgWrapper.innerHTML = latestSvg
      const generatedSvg = previewContent.querySelector('svg')
      if (generatedSvg && previousViewBoxRaw) {
        generatedSvg.setAttribute('viewBox', previousViewBoxRaw)
        latestSvg = generatedSvg.outerHTML
      }
      window.localStorage.setItem(LATEST_SVG_KEY, latestSvg)
      const statsText = `Shapes: ${grid.meta.shapeCount} · Size: ${grid.meta.width}×${grid.meta.height}px`
      stats.textContent = statsText
      persistSettings(statsText)
      selectedShapeIds.clear()
      selectedLayer = null
      bindSvgInteractions()
      status.textContent = 'Art grid generated.'
    } catch (error) {
      status.textContent = `Could not generate art grid: ${error instanceof Error ? error.message : 'Unknown error'}`
    } finally {
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
      }
      latestSvg = renderArtGridSvg(grid)
      svgWrapper.innerHTML = latestSvg
      const refreshedSvg = previewContent.querySelector('svg')
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
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedShapeIds.size > 0) {
      deleteEntityBtn.click()
      event.preventDefault()
    }
  })

  randomizeBtn.addEventListener('click', () => {
    // If a layer is selected, only regenerate shapes in that layer
    if (selectedLayer !== null) {
      const svg = previewContent.querySelector('svg')
      if (!svg) return
      const metadata = decodeSvgMetadata(svg)
      if (!metadata) return
      
      const currentViewBoxRaw = svg.getAttribute('viewBox')
      const canvasWidth = readPositiveInt(width.input, 1200)
      const canvasHeight = readPositiveInt(height.input, 2400)
      
      // Get shapes in the selected layer and regenerate them
      const layerShapes = metadata.shapes.filter(s => s.layer === selectedLayer)
      const otherShapes = metadata.shapes.filter(s => s.layer !== selectedLayer)
      
      // Generate new shapes for this layer with a random seed
      const newSeed = randomSeed()
      const rng = (() => {
        let state = (Number(newSeed) >>> 0) || 1;
        return () => {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          return (state >>> 0) / 4294967296;
        };
      })()
      
      const randomInt = (min, max) => Math.floor(rng() * (max - min + 1)) + min
      const randomChoice = (arr) => arr[randomInt(0, arr.length - 1)]
      
      const minSz = readBoundedInt(minSize.input, 8, 2, 100)
      const maxSz = readBoundedInt(maxSize.input, 120, 10, 300)
      const minTexScale = parseFloat(minTextureScale.input.value) || 0.5
      const maxTexScale = parseFloat(maxTextureScale.input.value) || 2
      const colors = getColorsForGeneration()
      const patterns = ['solid', 'hatch', 'cross-hatch', 'dots', 'checkerboard', 'stripes']
      
      const newLayerShapes = layerShapes.map(oldShape => {
        const shapeType = randomChoice(['rect', 'circle', 'rect', 'circle'])
        const size = randomInt(minSz, maxSz)
        const halfSize = size / 2
        const minX = halfSize
        const maxX = canvasWidth - halfSize
        const minY = halfSize
        const maxY = canvasHeight - halfSize
        const x = minX + rng() * (maxX - minX)
        const y = minY + rng() * (maxY - minY)
        const textureScale = minTexScale + rng() * (maxTexScale - minTexScale)
        
        return {
          ...oldShape,
          type: shapeType,
          x,
          y,
          size,
          color: randomChoice(colors),
          pattern: randomChoice(patterns),
          rotation: rng() * 360,
          textureScale,
        }
      })
      
      metadata.shapes = [...otherShapes, ...newLayerShapes]
      
      const grid = {
        meta: {
          width: canvasWidth,
          height: canvasHeight,
          seed: readPositiveInt(seed.input, Date.now()),
          shapeCount: metadata.shapes.length,
        },
        shapes: metadata.shapes,
      }
      
      latestSvg = renderArtGridSvg(grid)
      svgWrapper.innerHTML = latestSvg
      const refreshedSvg = previewContent.querySelector('svg')
      if (refreshedSvg && currentViewBoxRaw) {
        refreshedSvg.setAttribute('viewBox', currentViewBoxRaw)
      }
      
      // Keep the layer selected and update selection
      selectedShapeIds.clear()
      newLayerShapes.forEach(shape => selectedShapeIds.add(shape.id))
      bindSvgInteractions()
      status.textContent = `Regenerated ${newLayerShapes.length} shapes in Layer ${selectedLayer}.`
    } else {
      // No layer selected - randomize seed and regenerate everything
      seed.input.value = String(randomSeed())
      generate()
    }
  })
  saveBtn.addEventListener('click', () => {
    if (!latestSvg) {
      status.textContent = 'Generate an art grid before saving.'
      return
    }
    downloadSvg(getExportReadySvg(latestSvg))
    status.textContent = 'SVG downloaded.'
  })

  const savedSvg = window.localStorage.getItem(LATEST_SVG_KEY)
  if (savedSvg) {
    latestSvg = savedSvg
    svgWrapper.innerHTML = latestSvg
    const loadedSvg = previewContent.querySelector('svg')
    if (loadedSvg) {
      // Check if SVG has the art-shape classes needed for interaction
      const hasShapeClasses = loadedSvg.querySelector('.art-shape') !== null
      if (!hasShapeClasses) {
        // Old SVG format - regenerate with current settings
        status.textContent = 'Upgrading SVG format...'
        generate()
        return
      }
    }
    status.textContent = 'Loaded previous art grid.'
    bindSvgInteractions()
  } else {
    generate()
  }
}
