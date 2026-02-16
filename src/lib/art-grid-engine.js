/**
 * Art Grid generator - creates geometric art compositions
 */

const DEFAULT_OPTIONS = {
  width: 420,
  height: 920,
  shapeCount: 80,
  seed: Date.now(),
  minSize: 8,
  maxSize: 120,
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
  const shapeType = randomChoice(rng, ['rect', 'circle', 'rect', 'circle']);
  const size = randomInt(rng, options.minSize, options.maxSize);
  const halfSize = size / 2;
  
  // Ensure shapes stay within bounds by accounting for their size
  const minX = halfSize;
  const maxX = bounds.width - halfSize;
  const minY = halfSize;
  const maxY = bounds.height - halfSize;
  
  // Clamp positions to keep shapes fully inside the canvas
  const x = minX + rng() * (maxX - minX);
  const y = minY + rng() * (maxY - minY);
  
  const color = randomChoice(rng, options.colors);
  const pattern = randomChoice(rng, options.patterns);
  const rotation = rng() * 360;
  
  return {
    type: shapeType,
    x,
    y,
    size,
    color,
    pattern,
    rotation,
    id: `shape-${Math.floor(rng() * 1000000)}`,
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
  
  // Add some small decorative elements
  const decorativeCount = Math.floor(options.shapeCount * 0.3);
  for (let i = 0; i < decorativeCount; i++) {
    const smallShape = generateShape(rng, { ...options, minSize: 2, maxSize: 12 }, bounds);
    shapes.push(smallShape);
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

function createPatternDef(shape, id) {
  const patternSize = 4;
  const strokeWidth = 0.5;
  
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
  <circle cx="${patternSize / 2}" cy="${patternSize / 2}" r="0.8" fill="${shape.color}" />
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
  
  if (shape.type === 'circle') {
    return `
<g data-id="${shape.id}" transform="${transform}">
  <circle cx="0" cy="0" r="${shape.size / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke" />
</g>`;
  } else {
    const halfSize = shape.size / 2;
    return `
<g data-id="${shape.id}" transform="${transform}">
  <rect x="${-halfSize}" y="${-halfSize}" width="${shape.size}" height="${shape.size}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" vector-effect="non-scaling-stroke" />
</g>`;
  }
}

export function renderArtGridSvg(grid, options = {}) {
  const width = grid.meta.width;
  const height = grid.meta.height;
  
  const patterns = grid.shapes
    .map((shape, index) => createPatternDef(shape, `pattern-${index}`))
    .join('');
  
  const shapes = grid.shapes
    .map((shape, index) => renderShape(shape, index))
    .join('');
  
  const metadata = encodePlanMetadata({
    seed: Number(grid.meta.seed),
    shapes: grid.shapes.map((shape) => ({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      size: shape.size,
      color: shape.color,
      pattern: shape.pattern,
      rotation: shape.rotation,
    })),
  });
  
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="geometricPrecision" text-rendering="geometricPrecision" image-rendering="optimizeQuality" color-interpolation-filters="sRGB" data-base-viewbox="0 0 ${width} ${height}" role="img" aria-label="Generated art grid">
  <title>Art Grid - ${width}x${height}px</title>
  <desc>Geometric art composition generated with seed ${grid.meta.seed}</desc>
  <metadata id="occult-floorplan-meta">${metadata}</metadata>
  <defs>
    ${patterns}
    <clipPath id="canvas-clip">
      <rect x="0" y="0" width="${width}" height="${height}" />
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#000000" />
  <g clip-path="url(#canvas-clip)">
    ${shapes}
  </g>
</svg>`.trim();
}
