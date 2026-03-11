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

// Pattern tile size as fraction of shape bbox (0.1 = 10 repetitions per shape). Same in editor and export.
const PATTERN_TILE_FRAC = 0.1;
const PATTERN_STROKE_FRAC = 0.02;

function createPatternDef(shape, id) {
  const tile = PATTERN_TILE_FRAC;
  const sw = PATTERN_STROKE_FRAC;
  const c = shape.color;

  switch (shape.pattern) {
    case 'hatch':
      return `
<pattern id="${id}" x="0" y="0" width="${tile}" height="${tile}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox" patternTransform="rotate(45)">
  <line x1="0.5" y1="0" x2="0.5" y2="1" stroke="${c}" stroke-width="${sw}" />
</pattern>`;
    case 'cross-hatch':
      return `
<pattern id="${id}" x="0" y="0" width="${tile}" height="${tile}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox">
  <line x1="0" y1="0" x2="1" y2="1" stroke="${c}" stroke-width="${sw}" />
  <line x1="1" y1="0" x2="0" y2="1" stroke="${c}" stroke-width="${sw}" />
</pattern>`;
    case 'dots':
      return `
<pattern id="${id}" x="0" y="0" width="${tile}" height="${tile}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox">
  <circle cx="0.5" cy="0.5" r="${0.35}" fill="${c}" />
</pattern>`;
    case 'checkerboard':
      return `
<pattern id="${id}" x="0" y="0" width="${tile}" height="${tile}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox">
  <rect x="0" y="0" width="0.5" height="0.5" fill="${c}" />
  <rect x="0.5" y="0.5" width="0.5" height="0.5" fill="${c}" />
</pattern>`;
    case 'stripes':
      return `
<pattern id="${id}" x="0" y="0" width="${tile}" height="${tile}" patternUnits="objectBoundingBox" patternContentUnits="objectBoundingBox">
  <rect x="0" y="0" width="0.5" height="1" fill="${c}" />
</pattern>`;
    default:
      return '';
  }
}

/** Compare layer ids: negative if A is below B, 0 if same, positive if A is above B. Numeric ascending, then string alphabetical. */
function compareLayerIds(layerA, layerB) {
  const a = layerA ?? 1;
  const b = layerB ?? 1;
  const aIsNum = typeof a === 'number';
  const bIsNum = typeof b === 'number';
  if (aIsNum && bIsNum) return a - b;
  if (aIsNum && !bIsNum) return -1;
  if (!aIsNum && bIsNum) return 1;
  return String(a).localeCompare(String(b));
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

  const shapesDrawOrderSorted = [...grid.shapes].sort((a, b) => compareLayerIds(a.layer, b.layer));
  const patterns = shapesDrawOrderSorted
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

  const shapes = shapesDrawOrderSorted
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

// --- Canvas 2D renderer ---

const PATTERN_TILE_PX = 32;
const MAX_PATTERN_SCALE = 4;

const patternCache = new Map();

function patternCacheKey(patternType, color, scaleBucket) {
  return `${patternType}:${color}:${scaleBucket}`;
}

function bucketTextureScale(scale) {
  const s = Math.max(1, Number(scale) || 1);
  return Math.min(MAX_PATTERN_SCALE, Math.ceil(s));
}

function createPatternCanvas(patternType, color, scaleFactor) {
  const tilePx = Math.max(PATTERN_TILE_PX, Math.round(PATTERN_TILE_PX * scaleFactor));
  const canvas = document.createElement('canvas');
  canvas.width = tilePx;
  canvas.height = tilePx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const s = tilePx;
  const strokeW = Math.max(1, PATTERN_STROKE_FRAC * s);
  const r = 0.35 * s;
  switch (patternType) {
    case 'hatch':
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeW;
      ctx.beginPath();
      ctx.moveTo(s / 2, 0);
      ctx.lineTo(s / 2, s);
      ctx.stroke();
      break;
    case 'cross-hatch':
      ctx.strokeStyle = color;
      ctx.lineWidth = strokeW;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(s, s);
      ctx.moveTo(s, 0);
      ctx.lineTo(0, s);
      ctx.stroke();
      break;
    case 'dots':
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'checkerboard':
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, s / 2, s / 2);
      ctx.fillRect(s / 2, s / 2, s / 2, s / 2);
      break;
    case 'stripes':
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, s / 2, s);
      break;
    default:
      return null;
  }
  return canvas;
}

function getCachedPattern(ctx, patternType, color, textureScale = 1) {
  const scaleBucket = bucketTextureScale(textureScale);
  const key = patternCacheKey(patternType, color, scaleBucket);
  let pattern = patternCache.get(key);
  if (!pattern) {
    const canvas = createPatternCanvas(patternType, color, scaleBucket);
    if (canvas) {
      pattern = ctx.createPattern(canvas, 'repeat');
      if (pattern) patternCache.set(key, pattern);
    }
  }
  return pattern || null;
}

function drawBackground(ctx, grid, width, height, pixelScale = 1) {
  const background = grid.background ?? { color: '#000000', textureType: 'solid' };
  const color = background.color || '#000000';
  if (background.textureType === 'solid') {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (background.textureType === 'stamp' && background.stampPath && background.stampWidth && background.stampHeight) {
    const scale = background.textureScale ?? 1;
    const cellW = background.stampWidth * scale;
    const cellH = background.stampHeight * scale;
    try {
      const path = new Path2D(background.stampPath);
      for (let y = 0; y < height + cellH; y += cellH) {
        for (let x = 0; x < width + cellW; x += cellW) {
          ctx.save();
          ctx.translate(x, y);
          ctx.scale(scale, scale);
          ctx.fillStyle = color;
          ctx.fill(path);
          ctx.restore();
        }
      }
    } catch (_) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
    }
    return;
  }
  if (background.textureType !== 'pattern' || !background.pattern) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const patternType = background.pattern;
  const scale = Math.max(0.25, background.textureScale ?? 1);
  const patternSizeLogical = Math.max(4, Math.round(PATTERN_TILE_PX * scale));
  const patternSizePx = Math.max(patternSizeLogical, Math.round(patternSizeLogical * pixelScale));
  const canvas = document.createElement('canvas');
  canvas.width = patternSizePx;
  canvas.height = patternSizePx;
  const pctx = canvas.getContext('2d');
  if (!pctx) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const strokeW = Math.max(0.5, (0.5 * patternSizePx) / PATTERN_TILE_PX);
  if (patternType === 'hatch') {
    pctx.save();
    pctx.translate(patternSizePx / 2, patternSizePx / 2);
    pctx.rotate((45 * Math.PI) / 180);
    pctx.translate(-patternSizePx / 2, -patternSizePx / 2);
    pctx.strokeStyle = color;
    pctx.lineWidth = strokeW;
    pctx.beginPath();
    pctx.moveTo(patternSizePx / 2, 0);
    pctx.lineTo(patternSizePx / 2, patternSizePx);
    pctx.stroke();
    pctx.restore();
  } else if (patternType === 'cross-hatch') {
    pctx.strokeStyle = color;
    pctx.lineWidth = strokeW;
    pctx.beginPath();
    pctx.moveTo(0, 0);
    pctx.lineTo(patternSizePx, patternSizePx);
    pctx.moveTo(patternSizePx, 0);
    pctx.lineTo(0, patternSizePx);
    pctx.stroke();
  } else if (patternType === 'dots') {
    pctx.fillStyle = color;
    pctx.beginPath();
    pctx.arc(patternSizePx / 2, patternSizePx / 2, 0.35 * patternSizePx, 0, Math.PI * 2);
    pctx.fill();
  } else if (patternType === 'checkerboard') {
    const half = patternSizePx / 2;
    pctx.fillStyle = color;
    pctx.fillRect(0, 0, half, half);
    pctx.fillRect(half, half, half, half);
  } else if (patternType === 'stripes') {
    pctx.fillStyle = color;
    pctx.fillRect(0, 0, patternSizePx / 2, patternSizePx);
  }
  const bgPattern = ctx.createPattern(canvas, 'repeat');
  if (bgPattern) {
    ctx.save();
    ctx.scale(1 / pixelScale, 1 / pixelScale);
    ctx.fillStyle = bgPattern;
    ctx.fillRect(0, 0, width * pixelScale, height * pixelScale);
    ctx.restore();
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, width, height);
  }
}

function drawShape(ctx, shape, patternCacheGetter) {
  const layer = shape.layer || 1;
  const halfSize = shape.size / 2;
  const strokeWidth = shape.pattern === 'solid' ? 0.5 : 0.25;
  const strokeColor = shape.pattern === 'solid' ? '#000000' : shape.color;

  ctx.save();
  ctx.translate(shape.x, shape.y);
  ctx.rotate((shape.rotation * Math.PI) / 180);

  let fillStyle = shape.color;
  if (shape.pattern !== 'solid') {
    const textureScale = shape.textureScale ?? 1;
    const pattern = patternCacheGetter(shape.pattern, shape.color, textureScale);
    if (pattern) fillStyle = pattern;
  }
  ctx.fillStyle = fillStyle;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = strokeWidth;

  if (shape.type === 'circle') {
    ctx.beginPath();
    ctx.arc(0, 0, shape.size / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (shape.type === 'stamp' && shape.stampPath) {
    const useEditor = shape.stampPathEditor != null && shape.stampWidthEditor != null && shape.stampHeightEditor != null;
    const pathD = useEditor ? shape.stampPathEditor : shape.stampPath;
    const w = useEditor ? shape.stampWidthEditor : shape.stampWidth;
    const h = useEditor ? shape.stampHeightEditor : shape.stampHeight;
    if (pathD && w != null && h != null) {
      const res = useEditor ? 1 : (shape.stampPathResolution || 1);
      const scale = (shape.size / Math.max(w, h)) * res;
      const centerX = w / (2 * res);
      const centerY = h / (2 * res);
      const stampFill = shape.pattern === 'solid' ? shape.color : (patternCacheGetter(shape.pattern, shape.color, shape.textureScale ?? 1) || shape.color);
      ctx.fillStyle = stampFill;
      if (shape.pattern !== 'solid') ctx.strokeStyle = shape.color;
      try {
        const path = new Path2D(pathD);
        ctx.save();
        ctx.translate(-centerX * scale, -centerY * scale);
        ctx.scale(scale, scale);
        ctx.fill(path);
        if (shape.pattern !== 'solid') {
          ctx.lineWidth = 0.25 / scale;
          ctx.stroke(path);
        }
        ctx.restore();
      } catch (_) {
        ctx.fillRect(-halfSize, -halfSize, shape.size, shape.size);
      }
    } else {
      ctx.fillRect(-halfSize, -halfSize, shape.size, shape.size);
      ctx.strokeRect(-halfSize, -halfSize, shape.size, shape.size);
    }
  } else {
    ctx.fillRect(-halfSize, -halfSize, shape.size, shape.size);
    ctx.strokeRect(-halfSize, -halfSize, shape.size, shape.size);
  }

  ctx.restore();
}

function shapesDrawOrder(shapes) {
  return [...shapes].sort((a, b) => compareLayerIds(a.layer, b.layer));
}

/**
 * Render the art grid into a Canvas 2D context.
 * @param {Object} grid - { meta: { width, height }, shapes, background }
 * @param {CanvasRenderingContext2D} ctx - 2D context to draw into
 * @param {{ minX: number, minY: number, width: number, height: number }} viewTransform - viewport in scene coordinates (same semantics as SVG viewBox)
 * @param {number} canvasWidth - canvas element width in pixels
 * @param {number} canvasHeight - canvas element height in pixels
 */
export function renderArtGridCanvas(grid, ctx, viewTransform, canvasWidth, canvasHeight) {
  const { minX, minY, width, height } = viewTransform;
  const scaleX = canvasWidth / width;
  const scaleY = canvasHeight / height;

  ctx.save();
  ctx.setTransform(scaleX, 0, 0, scaleY, -minX * scaleX, -minY * scaleY);

  const gw = grid.meta.width;
  const gh = grid.meta.height;
  ctx.beginPath();
  ctx.rect(0, 0, gw, gh);
  ctx.clip();

  const pixelScale = Math.max(1, Math.min(scaleX, scaleY));
  drawBackground(ctx, grid, gw, gh, pixelScale);

  const getPattern = (patternType, color, textureScale) => getCachedPattern(ctx, patternType, color, textureScale);
  const ordered = shapesDrawOrder(grid.shapes);
  for (const shape of ordered) {
    drawShape(ctx, shape, getPattern);
  }

  ctx.restore();
}

/** Transform scene point to shape-local (center at origin, no rotation). */
function sceneToShapeLocal(shape, sceneX, sceneY) {
  const rad = ((shape.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const dx = sceneX - shape.x;
  const dy = sceneY - shape.y;
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/**
 * Hit-test a single shape at scene coordinates (e.g. from pointer).
 * Uses reverse of draw order: call for shapes in reverse layer order and return first hit.
 * @param {Object} shape
 * @param {number} sceneX
 * @param {number} sceneY
 * @returns {boolean}
 */
export function isPointInShape(shape, sceneX, sceneY) {
  const { x: localX, y: localY } = sceneToShapeLocal(shape, sceneX, sceneY);
  const half = shape.size / 2;
  if (shape.type === 'circle') {
    return localX * localX + localY * localY <= half * half;
  }
  if (shape.type === 'rect' || (!shape.type && true)) {
    return Math.abs(localX) <= half && Math.abs(localY) <= half;
  }
  if (shape.type === 'stamp' && shape.stampPath) {
    const useEditor = shape.stampPathEditor != null && shape.stampWidthEditor != null && shape.stampHeightEditor != null;
    const pathD = useEditor ? shape.stampPathEditor : shape.stampPath;
    const w = useEditor ? shape.stampWidthEditor : shape.stampWidth;
    const h = useEditor ? shape.stampHeightEditor : shape.stampHeight;
    if (!pathD || w == null || h == null) {
      return Math.abs(localX) <= half && Math.abs(localY) <= half;
    }
    const res = useEditor ? 1 : (shape.stampPathResolution || 1);
    const scale = (shape.size / Math.max(w, h)) * res;
    const centerX = w / (2 * res);
    const centerY = h / (2 * res);
    const pathLocalX = localX / scale + centerX;
    const pathLocalY = localY / scale + centerY;
    try {
      const path = new Path2D(pathD);
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) return Math.abs(localX) <= half && Math.abs(localY) <= half;
      return ctx.isPointInPath(path, pathLocalX, pathLocalY);
    } catch (_) {
      return Math.abs(localX) <= half && Math.abs(localY) <= half;
    }
  }
  return Math.abs(localX) <= half && Math.abs(localY) <= half;
}

/**
 * Shapes in reverse draw order (top-most first) for hit-testing.
 */
export function shapesHitTestOrder(shapes) {
  return [...shapes].sort((a, b) => compareLayerIds(b.layer, a.layer));
}
