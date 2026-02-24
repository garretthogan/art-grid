/**
 * Art Grid generator - creates geometric art compositions
 */

const DEFAULT_OPTIONS = {
  width: 1200,
  height: 2400,
  shapeCount: 80,
  seed: Date.now(),
  minSize: 8,
  maxSize: 120,
  minTextureScale: 0.5,
  maxTextureScale: 2,
  randomRotation: true,
  spread: 1,
  patterns: ['solid', 'hatch', 'cross-hatch', 'dots', 'checkerboard', 'stripes'],
  colors: ['#00ff00', '#ff0000', '#00ffff', '#ff00ff', '#ffff00', '#ffffff', '#0000ff'],
};

function createRng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function randomInt(rng, minInclusive, maxInclusive) {
  return Math.floor(rng() * (maxInclusive - minInclusive + 1)) + minInclusive;
}

function randomChoice(rng, values) {
  return values[randomInt(rng, 0, values.length - 1)];
}

function generateShape(rng, options, bounds) {
  const stamps = options.stamps;
  const useStamps = Array.isArray(stamps) && stamps.length > 0;

  const size = randomInt(rng, options.minSize, options.maxSize);
  const spread = Math.max(0.1, Number(options.spread) || 1);
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  const halfSide = Math.min(bounds.width, bounds.height) / 2;
  const extent = halfSide * spread;
  const x = centerX + (2 * rng() - 1) * extent;
  const y = centerY + (2 * rng() - 1) * extent;
  const color = randomChoice(rng, options.colors);
  const pattern = randomChoice(rng, options.patterns);
  const rotation = options.randomRotation !== false ? rng() * 360 : 0;
  const layer = randomInt(rng, 1, 5);
  const minTexScale = options.minTextureScale ?? 0.5;
  const maxTexScale = options.maxTextureScale ?? 2;
  const textureScale = minTexScale + rng() * (maxTexScale - minTexScale);
  const id = `shape-${Math.floor(rng() * 1000000)}`;

  if (useStamps) {
    const stamp = stamps[randomInt(rng, 0, stamps.length - 1)];
    const shape = {
      type: 'stamp',
      x,
      y,
      size,
      color,
      pattern,
      rotation,
      layer,
      textureScale,
      id,
      stampPath: stamp.stampPath,
      stampWidth: stamp.stampWidth,
      stampHeight: stamp.stampHeight,
      stampPathResolution: stamp.stampPathResolution,
    };
    if (stamp.stampPathEditor != null) {
      shape.stampPathEditor = stamp.stampPathEditor;
      shape.stampWidthEditor = stamp.stampWidthEditor;
      shape.stampHeightEditor = stamp.stampHeightEditor;
    }
    return shape;
  }

  const shapeType = randomChoice(rng, ['rect', 'circle', 'rect', 'circle']);
  return {
    type: shapeType,
    x,
    y,
    size,
    color,
    pattern,
    rotation,
    layer,
    textureScale,
    id,
  };
}

export function generateArtGrid(userOptions = {}) {
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  const rng = createRng(options.seed);
  
  const bounds = {
    width: options.width,
    height: options.height,
  };
  
  const shapes = [];
  for (let i = 0; i < options.shapeCount; i++) {
    shapes.push(generateShape(rng, options, bounds));
  }
  
  // Add some additional decorative elements (using the same size range as main shapes)
  const decorativeCount = Math.floor(options.shapeCount * 0.3);
  for (let i = 0; i < decorativeCount; i++) {
    shapes.push(generateShape(rng, options, bounds));
  }
  
  return {
    meta: {
      width: options.width,
      height: options.height,
      seed: options.seed,
      shapeCount: shapes.length,
    },
    shapes,
  };
}

function encodePlanMetadata(metadata) {
  return btoa(encodeURIComponent(JSON.stringify(metadata)));
}

export const PATTERNS = ['hatch', 'cross-hatch', 'dots', 'checkerboard', 'stripes'];

function createBackgroundPatternDef(background, id) {
  const { color, textureType, pattern, textureScale = 1 } = background;
  if (textureType === 'solid' || !pattern) return '';
  const scale = textureScale ?? 1;
  const patternSize = 4 * scale;
  const strokeWidth = 0.5 * scale;
  if (pattern === 'hatch') {
    return `<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${patternSize}" stroke="${color}" stroke-width="${strokeWidth}" /></pattern>`;
  }
  if (pattern === 'cross-hatch') {
    return `<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="${patternSize}" y2="${patternSize}" stroke="${color}" stroke-width="${strokeWidth}" /><line x1="${patternSize}" y1="0" x2="0" y2="${patternSize}" stroke="${color}" stroke-width="${strokeWidth}" /></pattern>`;
  }
  if (pattern === 'dots') {
    return `<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse"><circle cx="${patternSize / 2}" cy="${patternSize / 2}" r="${0.8 * scale}" fill="${color}" /></pattern>`;
  }
  if (pattern === 'checkerboard') {
    return `<pattern id="${id}" width="${patternSize * 2}" height="${patternSize * 2}" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="${patternSize}" height="${patternSize}" fill="${color}" /><rect x="${patternSize}" y="${patternSize}" width="${patternSize}" height="${patternSize}" fill="${color}" /></pattern>`;
  }
  if (pattern === 'stripes') {
    return `<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse"><rect x="0" y="0" width="${patternSize / 2}" height="${patternSize}" fill="${color}" /></pattern>`;
  }
  return '';
}

function createBackgroundStampPatternDef(background, id, width, height) {
  const { stampPath, stampWidth, stampHeight, color, textureScale = 1 } = background;
  if (!stampPath || !stampWidth || !stampHeight) return '';
  const scale = textureScale ?? 1;
  const cellW = stampWidth * scale;
  const cellH = stampHeight * scale;
  return `<pattern id="${id}" width="${cellW}" height="${cellH}" patternUnits="userSpaceOnUse"><g transform="scale(${scale})"><path d="${stampPath}" fill="${color}" stroke="none" shape-rendering="crispEdges" /></g></pattern>`;
}

const REFERENCE_SIZE = 50;

function createPatternDef(shape, id) {
  let textureScale = shape.textureScale ?? 1;
  // Stamp shapes: scale pattern with shape size so larger stamps get finer texture (more repetitions)
  if (shape.type === 'stamp' && shape.size != null && shape.size > 0) {
    textureScale = textureScale * (REFERENCE_SIZE / Math.max(shape.size, 1));
  }
  const patternSize = 4 * textureScale;
  const strokeWidth = 0.5 * textureScale;
  
  switch (shape.pattern) {
    case 'hatch':
      return `
<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
  <line x1="0" y1="0" x2="0" y2="${patternSize}" stroke="${shape.color}" stroke-width="${strokeWidth}" />
</pattern>`;
    case 'cross-hatch':
      return `
<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse">
  <line x1="0" y1="0" x2="${patternSize}" y2="${patternSize}" stroke="${shape.color}" stroke-width="${strokeWidth}" />
  <line x1="${patternSize}" y1="0" x2="0" y2="${patternSize}" stroke="${shape.color}" stroke-width="${strokeWidth}" />
</pattern>`;
    case 'dots':
      return `
<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse">
  <circle cx="${patternSize / 2}" cy="${patternSize / 2}" r="${0.8 * textureScale}" fill="${shape.color}" />
</pattern>`;
    case 'checkerboard':
      return `
<pattern id="${id}" width="${patternSize * 2}" height="${patternSize * 2}" patternUnits="userSpaceOnUse">
  <rect x="0" y="0" width="${patternSize}" height="${patternSize}" fill="${shape.color}" />
  <rect x="${patternSize}" y="${patternSize}" width="${patternSize}" height="${patternSize}" fill="${shape.color}" />
</pattern>`;
    case 'stripes':
      return `
<pattern id="${id}" width="${patternSize}" height="${patternSize}" patternUnits="userSpaceOnUse">
  <rect x="0" y="0" width="${patternSize / 2}" height="${patternSize}" fill="${shape.color}" />
</pattern>`;
    default:
      return '';
  }
}

function renderShape(shape, index) {
  const patternId = `pattern-${index}`;
  const fill = shape.pattern === 'solid' ? shape.color : `url(#${patternId})`;
  const stroke = shape.pattern === 'solid' ? '#000000' : shape.color;
  const strokeWidth = shape.pattern === 'solid' ? 0.5 : 0.25;
  
  const transform = `translate(${shape.x}, ${shape.y}) rotate(${shape.rotation})`;
  const layer = shape.layer || 1;
  const halfSize = shape.size / 2;
  const hitArea = `<rect class="art-shape-hit-area" x="${-halfSize}" y="${-halfSize}" width="${shape.size}" height="${shape.size}" fill="white" fill-opacity="0.001" pointer-events="all" />`;

  // Handle stamp shapes (with optional texture pattern). Use low-res path when present (editing); full-res used on export.
  if (shape.type === 'stamp' && shape.stampPath) {
    const useEditorPath = shape.stampPathEditor != null && shape.stampWidthEditor != null && shape.stampHeightEditor != null
    const pathD = useEditorPath ? shape.stampPathEditor : shape.stampPath
    const w = useEditorPath ? shape.stampWidthEditor : shape.stampWidth
    const h = useEditorPath ? shape.stampHeightEditor : shape.stampHeight
    const res = useEditorPath ? 1 : (shape.stampPathResolution || 1)
    const scale = (shape.size / Math.max(w, h)) * res
    const centerX = w / (2 * res)
    const centerY = h / (2 * res)
    const knownPatterns = ['solid', 'hatch', 'cross-hatch', 'dots', 'checkerboard', 'stripes']
    const stampPattern = knownPatterns.includes(shape.pattern) ? shape.pattern : 'solid'
    const stampFill = stampPattern === 'solid' ? shape.color : `url(#${patternId})`
    const stampStroke = stampPattern === 'solid' ? 'none' : shape.color
    const stampStrokeWidth = stampPattern === 'solid' ? 0 : 0.25
    const strokeAttrs = stampPattern === 'solid'
      ? 'stroke="none"'
      : `stroke="${stampStroke}" stroke-width="${stampStrokeWidth}" vector-effect="non-scaling-stroke"`
    return `
<g class="art-shape" data-id="${shape.id}" data-layer="${layer}" data-plan-x="${shape.x}" data-plan-y="${shape.y}" transform="${transform}">
  ${hitArea}
  <path d="${pathD}" fill="${stampFill}" ${strokeAttrs} shape-rendering="crispEdges" transform="translate(${-centerX * scale}, ${-centerY * scale}) scale(${scale})" />
</g>`;
  }
  
  if (shape.type === 'circle') {
    return `
<g class="art-shape" data-id="${shape.id}" data-layer="${layer}" data-plan-x="${shape.x}" data-plan-y="${shape.y}" transform="${transform}">
  ${hitArea}
  <circle cx="0" cy="0" r="${shape.size / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke" />
</g>`;
  } else {
    return `
<g class="art-shape" data-id="${shape.id}" data-layer="${layer}" data-plan-x="${shape.x}" data-plan-y="${shape.y}" transform="${transform}">
  ${hitArea}
  <rect x="${-halfSize}" y="${-halfSize}" width="${shape.size}" height="${shape.size}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke" />
</g>`;
  }
}

export function renderArtGridSvg(grid, options = {}) {
  const width = grid.meta.width;
  const height = grid.meta.height;
  const background = grid.background ?? { color: '#000000', textureType: 'solid' };

  const patterns = grid.shapes
    .map((shape, index) => createPatternDef(shape, `pattern-${index}`))
    .join('');

  let bgPatternDef = '';
  let bgFill = background.color || '#000000';
  if (background.textureType === 'pattern' && background.pattern) {
    bgPatternDef = createBackgroundPatternDef(background, 'bg-pattern');
    bgFill = 'url(#bg-pattern)';
  } else if (background.textureType === 'stamp' && background.stampPath) {
    bgPatternDef = createBackgroundStampPatternDef(background, 'bg-stamp', width, height);
    bgFill = 'url(#bg-stamp)';
  }

  const shapes = grid.shapes
    .map((shape, index) => renderShape(shape, index))
    .join('');
  
  const metadata = encodePlanMetadata({
    seed: Number(grid.meta.seed),
    background,
    shapes: grid.shapes.map((shape) => ({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      size: shape.size,
      color: shape.color,
      pattern: shape.pattern,
      rotation: shape.rotation,
      layer: shape.layer || 1,
      textureScale: shape.textureScale ?? 1,
      ...(shape.type === 'stamp' && {
        stampPath: shape.stampPath,
        stampWidth: shape.stampWidth,
        stampHeight: shape.stampHeight,
        stampPathResolution: shape.stampPathResolution,
        ...(shape.stampPathEditor != null && {
          stampPathEditor: shape.stampPathEditor,
          stampWidthEditor: shape.stampWidthEditor,
          stampHeightEditor: shape.stampHeightEditor,
        }),
      }),
    })),
  });
  
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision" text-rendering="geometricPrecision" image-rendering="optimizeQuality" color-interpolation-filters="sRGB" data-base-viewbox="0 0 ${width} ${height}" role="img" aria-label="Generated art grid">
  <title>Art Grid - ${width}x${height}px</title>
  <desc>Geometric art composition generated with seed ${grid.meta.seed}</desc>
  <metadata id="occult-floorplan-meta">${metadata}</metadata>
  <defs>
    ${bgPatternDef}
    ${patterns}
    <clipPath id="canvas-clip">
      <rect x="0" y="0" width="${width}" height="${height}" />
    </clipPath>
  </defs>
  <style>
    .art-shape { cursor: grab; }
    .art-shape.is-selected { filter: brightness(1.5); }
  </style>
  <rect class="bg" x="0" y="0" width="${width}" height="${height}" fill="${bgFill}" />
  <g clip-path="url(#canvas-clip)">
    ${shapes}
  </g>
</svg>`.trim();
}
