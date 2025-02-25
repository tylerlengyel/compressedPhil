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
  if (!color || color === 'none') return 'none';
  if (color.startsWith('#')) return color.slice(1);
  if (color === 'black') return '000000';
  if (color === 'white') return 'FFFFFF';
  
  // Handle rgb() format
  const rgbMatch = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (rgbMatch) {
    const [_, r, g, b] = rgbMatch.map(Number);
    return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }
  
  return '000000'; // Default to black
}

// Extract paths with all attributes
function extractPaths(svgString) {
  const pathRegex = /<path[^>]*>/g;
  const paths = [];
  let match;
  
  while ((match = pathRegex.exec(svgString)) !== null) {
    const pathTag = match[0];
    
    // Extract d attribute
    const dMatch = pathTag.match(/d="([^"]*)"/);
    if (!dMatch) continue;
    const d = dMatch[1];
    
    // Extract other attributes
    const fillMatch = pathTag.match(/fill="([^"]*)"/);
    const strokeMatch = pathTag.match(/stroke="([^"]*)"/);
    const opacityMatch = pathTag.match(/opacity="([^"]*)"/);
    const strokeWidthMatch = pathTag.match(/stroke-width="([^"]*)"/);
    
    const fill = fillMatch ? fillMatch[1] : 'none';
    const stroke = strokeMatch ? strokeMatch[1] : 'none';
    const opacity = opacityMatch ? opacityMatch[1] : '1';
    const strokeWidth = strokeWidthMatch ? strokeWidthMatch[1] : '0';
    
    paths.push({ d, fill, stroke, opacity, strokeWidth });
  }
  
  return paths;
}

// Compress SVG to text format
function compressSVG(svgString) {
  const optimized = optimize(svgString, svgoConfig).data;
  const paths = extractPaths(optimized);
  
  // Extract viewBox
  const viewBoxMatch = optimized.match(/viewBox="([^"]*)"/);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 420 420';
  
  // Start with viewBox
  const result = [viewBox];
  
  // Add paths
  paths.forEach(({ d, fill, stroke, opacity, strokeWidth }) => {
    const quantizedD = quantizePathData(d);
    const fillHex = colorToHex(fill);
    const strokeHex = colorToHex(stroke);
    
    // Only include opacity and strokeWidth if they're not default values
    let pathStr = `${fillHex}|${strokeHex}`;
    
    if (opacity !== '1') {
      pathStr += `|${opacity}`;
      
      if (strokeWidth !== '0') {
        pathStr += `|${strokeWidth}`;
      }
    } else if (strokeWidth !== '0') {
      pathStr += `||${strokeWidth}`; // Add empty opacity slot
    }
    
    pathStr += `|${quantizedD}`;
    result.push(pathStr);
  });
  
  return result.join(';');
}

// Process SVGs
function processSVGs() {
  const inputDir = path.join(__dirname, 'SVGs');
  const outputDir = path.join(__dirname, 'compressed');
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }
  
  const results = {};

  fs.readdirSync(inputDir).forEach(file => {
    if (file.endsWith('.svg')) {
      const svgPath = path.join(inputDir, file);
      const svgContent = fs.readFileSync(svgPath, 'utf8');
      
      try {
        const compressed = compressSVG(svgContent);
        const outputPath = path.join(outputDir, `${file.replace('.svg', '.bin')}`);
        
        // Write compressed data
        fs.writeFileSync(outputPath, compressed);
        
        // Log compression stats
        const originalSize = svgContent.length;
        const compressedSize = compressed.length;
        const ratio = ((originalSize - compressedSize) / originalSize * 100).toFixed(2);
        console.log(`Compressed ${file}: ${originalSize} → ${compressedSize} bytes (${ratio}% reduction)`);
        
        results[file] = {
          original: originalSize,
          compressed: compressedSize,
          ratio: `${ratio}%`
        };
      } catch (error) {
        console.error(`Error compressing ${file}:`, error);
      }
    }
  });
  
  // Write compression summary
  fs.writeFileSync(
    path.join(outputDir, 'compression_summary.json'), 
    JSON.stringify(results, null, 2)
  );
  
  console.log('\nCompression summary written to compression_summary.json');
}

// Execute compression
processSVGs();