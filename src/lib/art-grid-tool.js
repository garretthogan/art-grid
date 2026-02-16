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
  let selectedShapeId = null
  let dragState = null
  let isGenerating = false

  const preview = document.createElement('section')
  preview.className = 'floor-plan-preview'
  const previewContent = document.createElement('div')
  previewContent.className = 'floor-plan-preview-content'
  preview.appendChild(previewContent)
  previewContainer.appendChild(preview)

  const controls = document.createElement('div')
  controls.className = 'floor-plan-controls'
  const title = document.createElement('h2')
  title.textContent = 'Art Grid SVG Generator'
  const seed = createNumberField('Seed', 'ag-seed', saved?.seed ?? randomSeed(), 1, MAX_SEED)
  const width = createNumberField('Width (px)', 'ag-width', saved?.width ?? 420, 100, 2000)
  const height = createNumberField('Height (px)', 'ag-height', saved?.height ?? 920, 100, 2000)
  const shapeCount = createRangeField('Shape count', 'ag-shapes', saved?.shapeCount ?? 80, 20, 200)
  const minSize = createRangeField('Min size', 'ag-min-size', saved?.minSize ?? 8, 2, 100)
  const maxSize = createRangeField('Max size', 'ag-max-size', saved?.maxSize ?? 120, 10, 300)

  const actions = document.createElement('div')
  actions.className = 'floor-plan-actions'
  const randomizeBtn = document.createElement('button')
  randomizeBtn.type = 'button'
  randomizeBtn.id = 'ag-randomize-seed'
  randomizeBtn.textContent = 'Randomize Seed'
  const generateBtn = document.createElement('button')
  generateBtn.type = 'button'
  generateBtn.className = 'primary'
  generateBtn.textContent = 'Generate'
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.id = 'ag-save-svg'
  saveBtn.textContent = 'Save SVG'
  actions.append(randomizeBtn, generateBtn, saveBtn)

  const status = document.createElement('p')
  status.className = 'floor-plan-status'
  status.textContent = 'Generate an art grid.'
  const stats = document.createElement('p')
  stats.className = 'floor-plan-stats'
  stats.textContent = saved?.statsText ?? ''
  controls.append(
    title,
    seed.row,
    width.row,
    height.row,
    shapeCount.row,
    minSize.row,
    maxSize.row,
    actions,
    status,
    stats
  )
  controlsContainer.appendChild(controls)

  const entitiesWrap = document.createElement('div')
  entitiesWrap.className = 'floor-plan-entities'
  const entityActions = document.createElement('div')
  entityActions.className = 'floor-plan-actions'
  const deleteEntityBtn = document.createElement('button')
  deleteEntityBtn.type = 'button'
  deleteEntityBtn.textContent = 'Delete selected'
  entityActions.append(deleteEntityBtn)
  const entitiesList = document.createElement('ul')
  entitiesList.className = 'floor-plan-entity-list'
  entitiesWrap.append(entityActions, entitiesList)
  entitiesContainer.appendChild(entitiesWrap)

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

  function setGeneratingState(generating) {
    generateBtn.disabled = generating
    randomizeBtn.disabled = generating
    saveBtn.disabled = generating
    deleteEntityBtn.disabled = generating
  }

  function persistSettings(statsText) {
    window.localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        seed: readPositiveInt(seed.input, Date.now()),
        width: readPositiveInt(width.input, 420),
        height: readPositiveInt(height.input, 920),
        shapeCount: readBoundedInt(shapeCount.input, 80, 20, 200),
        minSize: readBoundedInt(minSize.input, 8, 2, 100),
        maxSize: readBoundedInt(maxSize.input, 120, 10, 300),
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

  function renderEntityList(metadata) {
    entitiesList.innerHTML = ''
    ;(metadata?.shapes ?? []).forEach((shape, index) => {
      const id = shape.id ?? `shape-${index + 1}`
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'floor-plan-entity-item'
      if (selectedShapeId === id) btn.classList.add('is-selected')
      btn.textContent = `${shape.type} (${Number(shape.x).toFixed(0)}, ${Number(shape.y).toFixed(0)})`
      btn.addEventListener('click', () => {
        selectedShapeId = id
        bindSvgInteractions()
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

  function bindSvgInteractions() {
    const svg = previewContent.querySelector('svg')
    if (!svg) return
    const metadata = decodeSvgMetadata(svg)
    if (!metadata) return
    const viewBox = parseViewBox(svg)
    if (!viewBox) return
    
    metadata.shapes = Array.isArray(metadata.shapes) ? metadata.shapes : []

    svg.querySelectorAll('.art-shape').forEach((element) => {
      const id = element.getAttribute('data-id')
      element.classList.toggle('is-selected', id != null && id === selectedShapeId)
    })
    renderEntityList(metadata)

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
      persistMetadata(svg, metadata)
      previewContent.innerHTML = latestSvg
      bindSvgInteractions()
    }

    svg.onpointerdown = (event) => {
      const shapeElement = event.target.closest('.art-shape')
      if (shapeElement) {
        const id = shapeElement.getAttribute('data-id')
        const shape = metadata.shapes.find((entry) => entry.id === id)
        const point = toSvgCoordinates(event)
        if (!id || !shape || !point) return
        selectedShapeId = id
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
      selectedShapeId = null
      const currentViewBox = parseViewBox(svg)
      if (!currentViewBox) return
      svg.querySelectorAll('.art-shape').forEach((el) => el.classList.remove('is-selected'))
      renderEntityList(metadata)
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
      dragState = null
      persistMetadata(svg, metadata)
      previewContent.innerHTML = latestSvg
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
      width: readPositiveInt(width.input, 420),
      height: readPositiveInt(height.input, 920),
      shapeCount: readBoundedInt(shapeCount.input, 80, 20, 200),
      minSize: readBoundedInt(minSize.input, 8, 2, 100),
      maxSize: readBoundedInt(maxSize.input, 120, 10, 300),
    }
    seed.input.value = String(options.seed)
    status.textContent = 'Generating art grid...'
    setGeneratingState(true)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    try {
      const previousViewBoxRaw = (() => {
        const currentSvg = previewContent.querySelector('svg')
        if (!currentSvg) return null
        const raw = currentSvg.getAttribute('viewBox')
        return parseViewBoxFromRaw(raw) ? raw : null
      })()
      const grid = generateArtGrid(options)
      latestSvg = renderArtGridSvg(grid)
      previewContent.innerHTML = latestSvg
      const generatedSvg = previewContent.querySelector('svg')
      if (generatedSvg && previousViewBoxRaw) {
        generatedSvg.setAttribute('viewBox', previousViewBoxRaw)
        latestSvg = generatedSvg.outerHTML
      }
      window.localStorage.setItem(LATEST_SVG_KEY, latestSvg)
      const statsText = `Shapes: ${grid.meta.shapeCount} · Size: ${grid.meta.width}×${grid.meta.height}px`
      stats.textContent = statsText
      persistSettings(statsText)
      selectedShapeId = null
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
    if (selectedShapeId != null) {
      metadata.shapes = metadata.shapes.filter((entry) => entry.id !== selectedShapeId)
      selectedShapeId = null
      const grid = {
        meta: {
          width: readPositiveInt(width.input, 420),
          height: readPositiveInt(height.input, 920),
          seed: readPositiveInt(seed.input, Date.now()),
          shapeCount: metadata.shapes.length,
        },
        shapes: metadata.shapes,
      }
      latestSvg = renderArtGridSvg(grid)
      previewContent.innerHTML = latestSvg
      bindSvgInteractions()
      status.textContent = 'Shape deleted.'
      return
    }
    status.textContent = 'Select a shape first.'
  })

  window.addEventListener('keydown', (event) => {
    if (previewContainer.classList.contains('hidden')) return
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedShapeId != null) {
      deleteEntityBtn.click()
      event.preventDefault()
    }
  })

  randomizeBtn.addEventListener('click', () => {
    seed.input.value = String(randomSeed())
    generate()
  })
  generateBtn.addEventListener('click', generate)
  saveBtn.addEventListener('click', () => {
    if (!latestSvg) {
      status.textContent = 'Generate an art grid before saving.'
      return
    }
    downloadSvg(latestSvg)
    status.textContent = 'SVG downloaded.'
  })

  const savedSvg = window.localStorage.getItem(LATEST_SVG_KEY)
  if (savedSvg) {
    latestSvg = savedSvg
    previewContent.innerHTML = latestSvg
    // Reset viewBox to default on load to avoid loading with a zoomed/panned view
    const loadedSvg = previewContent.querySelector('svg')
    if (loadedSvg) {
      const baseViewBox = readBaseViewBox(loadedSvg)
      if (baseViewBox) {
        loadedSvg.setAttribute('viewBox', `${baseViewBox.minX} ${baseViewBox.minY} ${baseViewBox.width} ${baseViewBox.height}`)
        latestSvg = loadedSvg.outerHTML
      }
    }
    status.textContent = 'Loaded previous art grid.'
    bindSvgInteractions()
  } else {
    generate()
  }
}
