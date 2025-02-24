const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration (disable convertColors to preserve original colors)
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeComments', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'convertColors', active: false }, // Disable to prevent color conversion
    { name: 'removeUselessStrokeAndFill', active: true },
    { name: 'cleanupNumericValues', params: { floatPrecision: 2 } }, // Allow decimal precision
  ],
};

// Quantization scale for coordinates and radius (not opacity)
const QUANTIZATION_SCALE = 10;

// Convert color to hex
function colorToHex(color) {
  console.log('Processing color:', color); // Debug: Log the color being processed
  if (color === 'none') return 'none';
  if (color.startsWith('url(#')) return color.match(/#([^"]*)/)[1]; // Extract gradient ID
  if (color.startsWith('#')) {
    // Handle direct hex, ensuring uppercase and 6 digits
    let hex = color.slice(1).toUpperCase();
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join(''); // Expand #abc to #aabbcc
    if (hex.length !== 6) {
      console.warn('Invalid hex color, defaulting to 000000:', color);
      return '000000'; // Fallback for invalid hex
    }
    return hex;
  }
  if (color === 'black') return '000000';
  const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) {
    const [_, r, g, b] = rgbMatch.map(Number);
    return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
  }
  console.warn('Unknown color format, defaulting to 000000:', color);
  return '000000'; // Default fallback
}

// Compress rectangle
function compressRect(rect) {
  const width = rect.match(/width="([^"]*)"/)[1];
  const height = rect.match(/height="([^"]*)"/)[1];
  const fillMatch = rect.match(/fill="([^"]*)"/);
  const fill = fillMatch ? fillMatch[1] : 'none';
  const qWidth = width === '100%' ? 420 * QUANTIZATION_SCALE : Math.round(parseFloat(width) * QUANTIZATION_SCALE);
  const qHeight = height === '100%' ? 420 * QUANTIZATION_SCALE : Math.round(parseFloat(height) * QUANTIZATION_SCALE);
  return `r|${colorToHex(fill)}|${qWidth},${qHeight}`;
}

// Compress circles with delta encoding and grouped fills, preserving exact opacity
function compressCircles(circles) {
  const fillGroups = {};
  circles.forEach(circle => {
    const fillMatch = circle.match(/fill="([^"]*)"/);
    const fill = fillMatch ? fillMatch[1] : 'none';
    console.log('Circle fill:', fill); // Debug: Log each circle's fill
    if (!fillGroups[fill]) fillGroups[fill] = [];
    fillGroups[fill].push(circle);
  });

  let compressed = '';
  for (const fill in fillGroups) {
    const group = fillGroups[fill];
    console.log('Processing fill group:', fill, 'with', group.length, 'circles'); // Debug: Log fill groups
    compressed += `f|${colorToHex(fill)}|`;
    let prevCx = 0, prevCy = 0, prevR = 0;

    group.forEach((circle, index) => {
      const cx = Math.round(parseFloat(circle.match(/cx="([^"]*)"/)[1]) * QUANTIZATION_SCALE);
      const cy = Math.round(parseFloat(circle.match(/cy="([^"]*)"/)[1]) * QUANTIZATION_SCALE);
      const r = Math.round(parseFloat(circle.match(/r="([^"]*)"/)[1]) * QUANTIZATION_SCALE);
      const opacityMatch = circle.match(/opacity="([^"]*)"/);
      const opacity = opacityMatch ? parseFloat(opacityMatch[1]) : 1.0; // Preserve exact opacity as float

      const deltaCx = index === 0 ? cx : cx - prevCx;
      const deltaCy = index === 0 ? cy : cy - prevCy;
      const deltaR = index === 0 ? r : r - prevR;

      // Use a decimal point for opacity (e.g., "0.1" instead of "1")
      compressed += `${opacity.toFixed(2)},${deltaCx},${deltaCy},${deltaR}`;
      if (index < group.length - 1) compressed += ',';

      prevCx = cx;
      prevCy = cy;
      prevR = r;
    });
    compressed += ';';
  }

  return compressed.slice(0, -1); // Remove trailing ';'
}

// Compress gradient definitions, preserving exact stop-opacity
function compressDefs(defs) {
  const gradientMatch = defs.match(/<radialGradient id="([^"]*)"[^>]*>(.*?)<\/radialGradient>/);
  if (!gradientMatch) return '';
  const id = gradientMatch[1];
  const stops = gradientMatch[2].match(/<stop[^>]*>/g) || [];
  const stopData = stops.map(stop => {
    const offset = stop.match(/offset="([^"]*)"/)[1].replace('%', '');
    const color = stop.match(/stop-color="([^"]*)"/)[1];
    const opacityMatch = stop.match(/stop-opacity="([^"]*)"/);
    const opacity = opacityMatch ? parseFloat(opacityMatch[1]) : 1.0; // Preserve exact opacity as float
    return `${offset},${colorToHex(color)},${opacity.toFixed(2)}`; // Use decimal for opacity
  }).join(',');
  return `g|${id}|${stopData}`;
}

// Compress SVG
function compressSVG(svgString) {
  const optimized = optimize(svgString, svgoConfig).data;
  const rectMatch = optimized.match(/<rect[^>]*>/);
  const circleMatches = optimized.match(/<circle[^>]*>/g) || [];
  const defsMatch = optimized.match(/<defs[^>]*>.*?<\/defs>/);

  const parts = [];
  if (rectMatch) parts.push(compressRect(rectMatch[0]));
  if (circleMatches.length) parts.push(compressCircles(circleMatches));
  if (defsMatch) parts.push(compressDefs(defsMatch[0]));

  return parts.join(';');
}

// Process SVGs
function processSVGs() {
  const inputDir = path.join(__dirname, 'SVGs');
  const outputDir = path.join(__dirname, 'compressed');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  fs.readdirSync(inputDir).forEach(file => {
    if (file.endsWith('.svg')) {
      const svgPath = path.join(inputDir, file);
      const svgContent = fs.readFileSync(svgPath, 'utf8');
      const compressed = compressSVG(svgContent);
      const outputPath = path.join(outputDir, `${file.replace('.svg', '')}.txt`);
      fs.writeFileSync(outputPath, compressed);
      console.log(`Compressed ${file} to ${outputPath}`);
    }
  });
}

processSVGs();