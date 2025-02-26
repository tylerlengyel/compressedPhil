const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration with galaxy-specific optimizations
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeComments', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'convertColors', active: false }, // Don't convert colors, preserve gradients
    { name: 'removeUselessStrokeAndFill', active: true },
    { name: 'cleanupNumericValues', params: { floatPrecision: 2 } }, // Keep 2 decimals
    { name: 'convertPathData', active: true },
    { name: 'removeEmptyAttrs', active: true },
    { name: 'collapseGroups', active: true }
  ],
};

// Compression parameters
const TARGET_SIZE = 420; // Match original size
const QUANTIZATION_SCALE = 1; // Less aggressive quantization to preserve quality

// Color dictionary optimized for galaxy SVGs
const COLOR_DICT = {
  '000000': 1,  // black (background)
  'FFFFFF': 2,  // white
  '808080': 3,  // gray
  'FF0000': 4,  // red
  '00FF00': 5,  // green
  '0000FF': 6,  // blue
  'FFFF00': 7,  // yellow
  '00FFFF': 8,  // cyan
  'FF00FF': 9,  // magenta
  'C0C0C0': 10, // silver
  'E8A852': 11, // orange/gold (common for galaxy cores)
  '294D7A': 12, // deep blue (common for arms)
  'D67D3E': 13, // rust orange (common for arms)
  'A654AD': 14, // purple (common for arms)
  '66CCFF': 15, // light blue (common for stars)
  'FFDB99': 16, // pale yellow (common for stars)
  'none': 0,    // transparent
};

// Encode variable-length integer
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

// Zigzag encoding for signed values
function encodeSignedVarInt(num) {
  const zigzag = (num << 1) ^ (num >> 31);
  return encodeVarInt(zigzag);
}

// Encode color efficiently
function encodeColor(color) {
  if (!color || color === 'none') return Buffer.from([0]);
  
  if (color.startsWith('url(#')) {
    // Handle gradient references
    const gradientId = color.match(/#([^"]*)/)[1];
    return Buffer.concat([
      Buffer.from([255]), // Gradient marker
      Buffer.from(gradientId)
    ]);
  } 
  
  let hex;
  if (color.startsWith('#')) {
    hex = color.slice(1).toUpperCase();
    if (hex.length === 3) {
      hex = hex.split('').map(c => c + c).join('');
    }
  } else if (color.startsWith('rgb')) {
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      const [_, r, g, b] = rgbMatch.map(Number);
      hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
    } else {
      hex = '000000';
    }
  } else if (color.toLowerCase() === 'black') {
    hex = '000000';
  } else {
    hex = '000000'; // Default to black
  }
  
  // Use dictionary value if available
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

// Encode float values with better precision
function encodeFloat(value, isOpacity = false) {
  if (isOpacity) {
    // Store opacity with 3 decimal precision (0-1000 range)
    return encodeVarInt(Math.round(value * 1000));
  }
  
  // For coordinates, quantize less aggressively to maintain quality
  const quantized = Math.round(value * QUANTIZATION_SCALE * 10) / 10; // Keep 1 decimal
  return encodeSignedVarInt(Math.round(quantized * 10)); // Store as integer (x10)
}

// Extract SVG metadata with minimal scaling
function extractSVGMetadata(svgString) {
  const viewBoxMatch = svgString.match(/viewBox="([^"]*)"/);
  
  const metadata = {
    viewBox: `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`, // Default
    scaleFactor: 1
  };
  
  if (viewBoxMatch) {
    const vbParts = viewBoxMatch[1].split(/\s+/).map(Number);
    // Keep original viewBox size for better quality
    metadata.viewBox = viewBoxMatch[1];
    metadata.scaleFactor = vbParts[2] / TARGET_SIZE;
  }
  
  return metadata;
}

// Compress rectangle with minimal scaling
function compressRect(rect, scaleFactor = 1) {
  const width = rect.match(/width="([^"]*)"/)[1];
  const height = rect.match(/height="([^"]*)"/)[1];
  const fillMatch = rect.match(/fill="([^"]*)"/);
  const fill = fillMatch ? fillMatch[1] : 'none';
  
  const xMatch = rect.match(/x="([^"]*)"/);
  const yMatch = rect.match(/y="([^"]*)"/);
  const x = xMatch ? parseFloat(xMatch[1]) : 0;
  const y = yMatch ? parseFloat(yMatch[1]) : 0;
  
  // Parse original dimensions with minimal scaling
  const origWidth = width === '100%' ? TARGET_SIZE : parseFloat(width);
  const origHeight = height === '100%' ? TARGET_SIZE : parseFloat(height);
  
  return Buffer.concat([
    Buffer.from([0x01]), // Rectangle marker
    encodeColor(fill),
    encodeFloat(x),
    encodeFloat(y),
    encodeFloat(origWidth),
    encodeFloat(origHeight)
  ]);
}

// Compress circles with preserving quality
function compressCircles(circles, scaleFactor = 1) {
  // Group by fill color
  const fillGroups = {};
  
  circles.forEach(circle => {
    const fillMatch = circle.match(/fill="([^"]*)"/);
    const fill = fillMatch ? fillMatch[1] : 'none';
    if (!fillGroups[fill]) fillGroups[fill] = [];
    fillGroups[fill].push(circle);
  });
  
  const result = [];
  
  for (const fill in fillGroups) {
    const group = fillGroups[fill];
    const coords = [];
    
    // Extract coordinates
    group.forEach(circle => {
      const cxMatch = circle.match(/cx="([^"]*)"/);
      const cyMatch = circle.match(/cy="([^"]*)"/);
      const rMatch = circle.match(/r="([^"]*)"/);
      const opacityMatch = circle.match(/opacity="([^"]*)"/);
      
      if (!cxMatch || !cyMatch || !rMatch) {
        return; // Skip invalid circles
      }
      
      coords.push({
        cx: parseFloat(cxMatch[1]),
        cy: parseFloat(cyMatch[1]),
        r: parseFloat(rMatch[1]),
        opacity: opacityMatch ? parseFloat(opacityMatch[1]) : 1.0
      });
    });
    
    // Skip empty groups
    if (coords.length === 0) continue;
    
    // For galaxy-like structures, sort by angle around center
    const centerX = TARGET_SIZE / 2;
    const centerY = TARGET_SIZE / 2;
    
    coords.sort((a, b) => {
      const angleA = Math.atan2(a.cy - centerY, a.cx - centerX);
      const angleB = Math.atan2(b.cy - centerY, b.cx - centerX);
      return angleA - angleB;
    });
    
    // Create header for this group
    const header = Buffer.concat([
      Buffer.from([0x02]), // Circle group marker
      encodeColor(fill),
      encodeVarInt(coords.length)
    ]);
    
    result.push(header);
    
    // Add all circles with delta encoding
    let prevCx = 0, prevCy = 0, prevR = 0;
    
    coords.forEach((coord, index) => {
      // Use delta encoding after first circle
      const deltaCx = index === 0 ? coord.cx : coord.cx - prevCx;
      const deltaCy = index === 0 ? coord.cy : coord.cy - prevCy;
      const deltaR = index === 0 ? coord.r : coord.r - prevR;
      
      // Encode circle data with higher precision for opacity
      const circleData = Buffer.concat([
        encodeFloat(coord.opacity, true),
        encodeFloat(deltaCx),
        encodeFloat(deltaCy),
        encodeFloat(deltaR)
      ]);
      
      result.push(circleData);
      
      prevCx = coord.cx;
      prevCy = coord.cy;
      prevR = coord.r;
    });
  }
  
  return Buffer.concat(result);
}

// Compress gradient definitions with full quality preservation
function compressGradient(gradient) {
  if (!gradient) return Buffer.from([]);
  
  // Extract gradient ID
  const idMatch = gradient.match(/id="([^"]*)"/);
  if (!idMatch) return Buffer.from([]);
  const id = idMatch[1];
  
  // Determine gradient type
  const isRadial = gradient.includes("<radialGradient");
  
  // Extract stops
  const stops = gradient.match(/<stop[^>]*>/g) || [];
  
  // Build gradient encoding
  const result = [
    Buffer.from([0x03]), // Gradient marker
    encodeVarInt(id.length),
    Buffer.from(id),
    Buffer.from([isRadial ? 1 : 0])
  ];
  
  // Encode stop count
  result.push(encodeVarInt(stops.length));
  
  // Encode each stop with full precision
  stops.forEach(stop => {
    const offsetMatch = stop.match(/offset="([^"]*%?)"/);
    const colorMatch = stop.match(/stop-color="([^"]*)"/);
    const opacityMatch = stop.match(/stop-opacity="([^"]*)"/);
    
    // Extract values with defaults
    const offset = offsetMatch ? 
      parseFloat(offsetMatch[1].replace('%', '')) / 100 : 0;
    const color = colorMatch ? colorMatch[1] : '#000000';
    const opacity = opacityMatch ? parseFloat(opacityMatch[1]) : 1.0;
    
    result.push(encodeFloat(offset));
    result.push(encodeFloat(opacity, true));
    result.push(encodeColor(color));
  });
  
  return Buffer.concat(result);
}

// Extract core gradient for special handling
function extractCoreGradient(svgString) {
  const defsMatch = svgString.match(/<defs[^>]*>(.*?)<\/defs>/s);
  if (!defsMatch) return null;
  
  const gradientMatch = defsMatch[1].match(/<(radial|linear)Gradient[^>]*id="coreGlow"[^>]*>(.*?)<\/(radial|linear)Gradient>/s);
  if (!gradientMatch) return null;
  
  return `<defs>${gradientMatch[0]}</defs>`;
}

// Compress SVG to binary format
function compressSVG(svgString) {
  try {
    // Optimize with SVGO
    const optimized = optimize(svgString, svgoConfig).data;
    
    // Extract core gradient for special handling
    const coreGradient = extractCoreGradient(optimized);
    
    // Extract SVG metadata
    const metadata = extractSVGMetadata(optimized);
    const scaleFactor = metadata.scaleFactor || 1;
    
    // Extract SVG elements
    const rectMatch = optimized.match(/<rect[^>]*>/);
    const circleMatches = optimized.match(/<circle[^>]*>/g) || [];
    
    // Prepare metadata buffer
    const viewBoxBuffer = Buffer.from(metadata.viewBox);
    const metadataBuffer = Buffer.concat([
      Buffer.from([0x00]), // Metadata marker
      encodeVarInt(viewBoxBuffer.length),
      viewBoxBuffer
    ]);
    
    const parts = [metadataBuffer];
    
    // Add each element type if present
    if (rectMatch) parts.push(compressRect(rectMatch[0], scaleFactor));
    if (circleMatches.length) parts.push(compressCircles(circleMatches, scaleFactor));
    if (coreGradient) parts.push(compressGradient(coreGradient));
    
    // Combine all parts
    let combinedBuffer;
    try {
      combinedBuffer = Buffer.concat(parts);
    } catch (error) {
      console.error('Error concatenating parts:', error);
      throw error;
    }
    
    // Version and header - using version 3 for enhanced compression
    const header = Buffer.from([
      0x03, // Version 3 marker
      parts.length // Number of different element types
    ]);
    
    const fullBuffer = Buffer.concat([header, combinedBuffer]);
    
    // For blockchain compatibility, use base64 encoding
    return fullBuffer.toString('base64');
  } catch (error) {
    console.error('Error compressing SVG:', error);
    throw error;
  }
}

// Process all SVGs in the directory
function processSVGs() {
  const inputDir = path.join(__dirname, 'SVGs');
  const outputDir = path.join(__dirname, 'compressed');
  
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  
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
