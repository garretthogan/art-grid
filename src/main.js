import './design-system.css'
import './style.css'
import './art-grid-app.css'
import { mountArtGridTool } from './lib/art-grid-tool.js'

const previewRoot = document.getElementById('floor-plan-tool-root')
const controlsRoot = document.getElementById('floor-plan-controls-root')
const entitiesRoot = document.getElementById('floor-plan-entities-root')

if (previewRoot && controlsRoot && entitiesRoot) {
  mountArtGridTool({
    previewContainer: previewRoot,
    controlsContainer: controlsRoot,
    entitiesContainer: entitiesRoot,
  })
}

const controlsArea = document.getElementById('controls-area')
const controlsAreaToggle = document.getElementById('controls-area-toggle')
if (controlsArea && controlsAreaToggle) {
  controlsAreaToggle.addEventListener('click', () => {
    controlsArea.classList.toggle('collapsed')
    controlsAreaToggle.setAttribute('aria-expanded', String(!controlsArea.classList.contains('collapsed')))
  })
}

// Open controls by default on load
if (controlsArea && !controlsArea.classList.contains('collapsed')) {
  controlsArea.classList.remove('collapsed')
  if (controlsAreaToggle) {
    controlsAreaToggle.setAttribute('aria-expanded', 'true')
  }
}
