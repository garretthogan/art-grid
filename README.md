# Art Grid SVG Generator

A procedural art generator that creates geometric compositions similar to the reference image, with interactive editing capabilities.

## Features

- **Procedural Generation**: Generates art compositions with configurable parameters
- **Shape Types**: Rectangles and circles with various patterns
- **Patterns**: Solid fills, hatching, cross-hatching, dots, checkerboard, and stripes
- **Interactive Editing**:
  - Pan and zoom with mouse wheel
  - Drag shapes to reposition them
  - Select and delete individual shapes
  - Click on shapes in the entity list to select them
- **Persistent State**: Saves your last generated composition and settings
- **SVG Export**: Download high-quality SVG files

## Controls

### Generation
- **Seed**: Random seed for reproducible compositions (or click "Randomize Seed")
- **Width/Height**: Canvas dimensions in pixels
- **Shape Count**: Number of main shapes to generate (20-200)
- **Min/Max Size**: Size range for generated shapes

### Interaction
- **Mouse Wheel**: Zoom in/out
- **Click + Drag** (on background): Pan the canvas
- **Click + Drag** (on shape): Move the shape
- **Click** (on shape or in list): Select a shape
- **Delete/Backspace**: Delete selected shape

## Architecture

Built using the same UX pattern as the floor-plan tool from brush-editor:

- `art-grid-engine.js`: Core generation algorithm
- `art-grid-tool.js`: UI controls and interaction logic
- `tui.css`: Terminal-style UI styling (copied from brush-editor)

## Development

```bash
npm run dev     # Start dev server
npm run build   # Build for production
```

The app runs at http://localhost:5173/
