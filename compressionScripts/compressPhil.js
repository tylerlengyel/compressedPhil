const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeXMLProcInst', active: true },
    { name: 'removeComments', active: true },
    { name: 'removeMetadata', active: true },
    { name: 'removeEditorsNSData', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'mergePaths', active: false },
    { name: 'convertColors', active: true },
    { name: 'removeUnusedNS', active: true },
    { name: 'removeUselessStrokeAndFill', active: true },
    { name: 'cleanupNumericValues', params: { floatPrecision: 0 } },
    { name: 'convertPathData', params: { floatPrecision: 0, utilizeAbsolute: true } },
  ],
};

// Quantization scale
const QUANTIZATION_SCALE = 10;

// Function to quantize path data (absolute coordinates)
function quantizePathData(pathData) {
  return pathData.replace(/-?\d+\.\d+|-?\d+/g, num => {
    const val = parseFloat(num);
    if (isNaN(val)) return num; // Preserve non-numeric parts
    return Math.round(val * QUANTIZATION_SCALE);
  });
}

// Color to hex
function colorToHex(color) {
  if (color === 'none') return 'none';
  if (color.startsWith('#')) return color.slice(1);
  if (color === 'black') return '000000';
  const [r, g, b] = color.match(/\d+/g)?.map(Number) || [0, 0, 0];
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

// Extract paths
function extractPaths(svgString) {
  const pathRegex = /<path[^>]*d="([^"]*)"[^>]*>/g;
  const paths = [];
  let match;
  while ((match = pathRegex.exec(svgString)) !== null) {
    const pathTag = match[0];
    const d = match[1];
    const fillMatch = pathTag.match(/fill="([^"]*)"/);
    const strokeMatch = pathTag.match(/stroke="([^"]*)"/);
    const fill = fillMatch ? fillMatch[1] : 'none';
    const stroke = strokeMatch ? strokeMatch[1] : 'none';
    paths.push({ d, fill, stroke });
  }
  return paths;
}

// Compress SVG
function compressSVG(svgString) {
  const optimized = optimize(svgString, svgoConfig).data;
  const paths = extractPaths(optimized);
  return paths
    .map(({ d, fill, stroke }) => {
      const quantizedD = quantizePathData(d);
      const fillHex = colorToHex(fill);
      const strokeHex = colorToHex(stroke);
      return `${fillHex}|${strokeHex}|${quantizedD}`;
    })
    .join(';');
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