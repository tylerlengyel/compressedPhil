const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration - optimized for path-based SVGs
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeXMLProcInst', active: true },
    { name: 'removeComments', active: true },
    { name: 'removeMetadata', active: true },
    { name: 'removeEditorsNSData', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'inlineStyles', active: true },
    { name: 'minifyStyles', active: true },
    { name: 'mergePaths', active: true },
    { name: 'convertColors', active: true },
    { name: 'removeUnusedNS', active: true },
    { name: 'removeUselessStrokeAndFill', active: true },
    { name: 'removeEmptyAttrs', active: true },
    { name: 'removeEmptyContainers', active: true },
    { name: 'collapseGroups', active: true },
    { name: 'removeHiddenElems', active: true },
    { name: 'removeEmptyText', active: true },
    { name: 'cleanupNumericValues', params: { floatPrecision: 0 } },
    { name: 'convertPathData', params: { 
      floatPrecision: 0, 
      utilizeAbsolute: true,
      noSpaceAfterFlags: true 
    }}
  ],
};

// Higher quantization for better compression
const QUANTIZATION_SCALE = 15;

// Expanded color dictionary with common SVG colors
const COLOR_DICT = {
  '000000': 1,   // black
  'FFFFFF': 2,   // white
  '808080': 3,   // gray
  'FF0000': 4,   // red
  '00FF00': 5,   // green
  '0000FF': 6,   // blue
  'FFFF00': 7,   // yellow
  '00FFFF': 8,   // cyan
  'FF00FF': 9,   // magenta
  'C0C0C0': 10,  // silver
  'FFA500': 11,  // orange
  '800000': 12,  // maroon
  '008000': 13,  // dark green
  '000080': 14,  // navy
  '800080': 15,  // purple
  '999999': 16,  // medium gray
  '333333': 17,  // dark gray
  'CCCCCC': 18,  // light gray
  'none': 0,     // transparent
};

// Command dictionary for path data compression
const CMD_DICT = {
  'M': 1,
  'm': 2,
  'L': 3,
  'l': 4,
  'H': 5,
  'h': 6,
  'V': 7,
  'v': 8,
  'C': 9,
  'c': 10,
  'S': 11,
  's': 12,
  'Q': 13,
  'q': 14,
  'T': 15,
  't': 16,
  'A': 17,
  'a': 18,
  'Z': 19,
  'z': 19  // Same code for both Z and z
};

// Encode integer with variable-length encoding
function encodeVarInt(num) {
  if (num === 0) return Buffer.from([0]);
  
  const bytes = [];
  while (num >= 128) {
    bytes.push((num & 0x7F) | 0x80);
    num >>>= 7;
  }
  bytes.push(num);
  return Buffer.from(bytes);
}

// Zigzag encoding for signed values (more efficient for small numbers)
function encodeSignedVarInt(num) {
  const zigzag = (num << 1) ^ (num >> 31);
  return encodeVarInt(zigzag);
}

// Encode color with dictionary lookup
function encodeColor(color) {
  if (!color || color === 'none') return Buffer.from([0]);
  
  let hex = color;
  if (color.startsWith('#')) {
    hex = color.slice(1).toUpperCase();
    if (hex.length === 3) {
      // Expand shorthand form (e.g. "FFF" to "FFFFFF")
      hex = hex.split('').map(c => c + c).join('');
    }
  } else if (color.startsWith('rgb')) {
    // Parse rgb() format
    const rgbMatch = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (rgbMatch) {
      const [_, r, g, b] = rgbMatch.map(Number);
      hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
    } else {
      hex = '000000'; // Default to black
    }
  } else if (COLOR_DICT[color.toUpperCase()]) {
    // Handle named colors that are in our dictionary
    hex = color.toUpperCase();
  } else {
    hex = '000000'; // Default to black
  }
  
  // Use dictionary value if available (more efficient)
  if (COLOR_DICT[hex]) {
    return Buffer.from([COLOR_DICT[hex]]);
  }
  
  // Otherwise encode as RGB bytes
  return Buffer.from([
    254, // Full color marker
    parseInt(hex.substring(0, 2), 16),
    parseInt(hex.substring(2, 4), 16),
    parseInt(hex.substring(4, 6), 16)
  ]);
}

// Tokenize and compress path data
function compressPathData(pathData) {
  // Normalize and clean the path data
  const normalized = pathData
    .replace(/\s+/g, ' ')    // Normalize whitespace
    .replace(/([a-zA-Z])/g, ' $1 ')  // Ensure space around commands
    .replace(/\s+/g, ' ')    // Clean up extra spaces
    .trim();
  
  const tokens = normalized.split(' ');
  const compressed = [];
  
  let currentX = 0, currentY = 0;
  let lastCommand = '';
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    
    // Check if token is a command
    if (/^[A-Za-z]$/.test(token)) {
      if (CMD_DICT[token]) {
        compressed.push(CMD_DICT[token]);
        lastCommand = token;
      }
      continue;
    }
    
    // Token is a number, quantize it
    const num = parseFloat(token);
    if (isNaN(num)) continue;
    
    // Quantize and apply delta encoding where appropriate
    let encodedNum;
    
    // For relative commands, we don't need delta encoding since they're already relative
    if (lastCommand === lastCommand.toLowerCase() && lastCommand !== 'z' && lastCommand !== 'Z') {
      encodedNum = Math.round(num * QUANTIZATION_SCALE);
    } 
    // For absolute commands, use delta encoding
    else if (lastCommand !== 'z' && lastCommand !== 'Z') {
      // Handle horizontal/vertical commands
      if (lastCommand === 'H') {
        const delta = num - currentX;
        encodedNum = Math.round(delta * QUANTIZATION_SCALE);
        currentX = num;
      } else if (lastCommand === 'V') {
        const delta = num - currentY;
        encodedNum = Math.round(delta * QUANTIZATION_SCALE);
        currentY = num;
      } 
      // Handle commands with coordinate pairs
      else {
        if (i % 2 === 0) {  // X coordinate
          const delta = num - currentX;
          encodedNum = Math.round(delta * QUANTIZATION_SCALE);
          currentX = num;
        } else {  // Y coordinate
          const delta = num - currentY;
          encodedNum = Math.round(delta * QUANTIZATION_SCALE);
          currentY = num;
        }
      }
    } else {
      encodedNum = Math.round(num * QUANTIZATION_SCALE);
    }
    
    // Add the encoded number
    compressed.push(encodedNum);
  }
  
  // Convert to binary format
  const buffers = compressed.map(value => {
    if (typeof value === 'number') {
      return encodeSignedVarInt(value);
    } else {
      return Buffer.from([value]);
    }
  });
  
  return Buffer.concat(buffers);
}

// Extract all paths from SVG
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
    const opacity = opacityMatch ? parseFloat(opacityMatch[1]) : 1;
    const strokeWidth = strokeWidthMatch ? parseFloat(strokeWidthMatch[1]) : 0;
    
    paths.push({ d, fill, stroke, opacity, strokeWidth });
  }
  
  return paths;
}

// Extract SVG viewBox
function extractViewBox(svgString) {
  const viewBoxMatch = svgString.match(/viewBox="([^"]*)"/);
  return viewBoxMatch ? viewBoxMatch[1] : '0 0 420 420';
}

// Extract and process viewBox for more efficient storage
function processViewBox(viewBox) {
  // Common case: viewBox starting at 0,0
  if (viewBox.startsWith('0 0 ')) {
    const parts = viewBox.split(' ');
    if (parts.length === 4) {
      const width = parseInt(parts[2]);
      const height = parseInt(parts[3]);
      
      // For square viewBoxes, store just one dimension
      if (width === height) {
        return Buffer.concat([
          Buffer.from([1]), // Format marker: square
          encodeVarInt(width)
        ]);
      }
      
      // For non-square starting at 0,0
      return Buffer.concat([
        Buffer.from([2]), // Format marker: rectangle at 0,0
        encodeVarInt(width),
        encodeVarInt(height)
      ]);
    }
  }
  
  // For general case, encode all 4 values
  const parts = viewBox.split(/\s+/).map(p => parseInt(p));
  if (parts.length === 4) {
    return Buffer.concat([
      Buffer.from([3]), // Format marker: full viewBox
      encodeSignedVarInt(parts[0]),
      encodeSignedVarInt(parts[1]),
      encodeVarInt(parts[2]),
      encodeVarInt(parts[3])
    ]);
  }
  
  // Fallback: store as string
  const viewBoxBuffer = Buffer.from(viewBox);
  return Buffer.concat([
    Buffer.from([0]), // Format marker: string
    encodeVarInt(viewBoxBuffer.length),
    viewBoxBuffer
  ]);
}

// Compress SVG to binary format with enhanced on-chain friendly compression
function compressSVG(svgString) {
  try {
    // Step 1: Optimize SVG with SVGO
    const optimized = optimize(svgString, svgoConfig).data;
    
    // Step 2: Extract data
    const paths = extractPaths(optimized);
    const viewBox = extractViewBox(optimized);
    
    // Step 3: Create binary format
    // Start with header (version 3 - enhanced on-chain compression)
    const header = Buffer.from([0x03, paths.length]);
    
    // Encode viewBox efficiently
    const viewBoxSection = processViewBox(viewBox);
    
    // Encode paths with efficient storage
    const pathBuffers = [];
    
    paths.forEach(({ d, fill, stroke, opacity, strokeWidth }) => {
      // Compress path data
      const compressedD = compressPathData(d);
      
      // Format flags for presence of non-default values
      const hasOpacity = opacity !== 1;
      const hasStrokeWidth = strokeWidth !== 0;
      const flags = (hasOpacity ? 1 : 0) | (hasStrokeWidth ? 2 : 0);
      
      // Build path segment
      const segments = [
        encodeColor(fill),
        encodeColor(stroke),
        Buffer.from([flags])
      ];
      
      // Add optional parameters only if needed
      if (hasOpacity) {
        segments.push(encodeVarInt(Math.round(opacity * 100)));
      }
      
      if (hasStrokeWidth) {
        segments.push(encodeVarInt(Math.round(strokeWidth * 10)));
      }
      
      // Add path data with its length
      segments.push(encodeVarInt(compressedD.length));
      segments.push(compressedD);
      
      pathBuffers.push(Buffer.concat(segments));
    });
    
    // Combine all sections
    const combinedBuffer = Buffer.concat([
      header,
      viewBoxSection,
      ...pathBuffers
    ]);
    
    // Convert to base64 for text storage
    return combinedBuffer.toString('base64');
  } catch (error) {
    console.error('Error compressing SVG:', error);
    throw error;
  }
}

// Process SVGs in the directory
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