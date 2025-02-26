const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration with minimal path modifications
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeComments', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'convertColors', active: false }, // Don't convert colors to preserve RGB format
    { name: 'removeUselessStrokeAndFill', active: true },
    // Don't modify path data at all
    { name: 'convertPathData', active: false },
    { name: 'cleanupNumericValues', active: false },
    { name: 'removeEmptyAttrs', active: true },
    { name: 'collapseGroups', active: true }
  ],
};

// Compression parameters
const TARGET_SIZE = 420;

// Color dictionary optimized for Top trait
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
  'A0A0A0': 11,  // darker gray
  'D0D0D0': 12,  // lighter gray
  'FFA500': 13,  // orange
  '800080': 14,  // purple
  '00BFFF': 15,  // deep sky blue
  '785D06': 16,  // gold-brown (common in top trait)
  '4A8019': 17,  // green (common in top trait)
  'A09DF6': 18,  // lavender (common in top trait)
  '31B915': 19,  // bright green (common in top trait)
  'none': 0,     // transparent
};

// Text options dictionary for text content
const TEXT_DICT = {
  'muse': 1,
  'space': 2,
  'astro': 3
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

// Convert RGB color string to hex
function rgbToHex(rgb) {
  if (!rgb || rgb === 'none') return 'none';
  
  // Handle rgb() format
  const match = rgb.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (match) {
    const r = parseInt(match[1]);
    const g = parseInt(match[2]);
    const b = parseInt(match[3]);
    return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
  }
  
  // Handle hex format
  if (rgb.startsWith('#')) {
    return rgb.slice(1).toUpperCase();
  }
  
  // Handle named colors
  if (rgb === 'black') return '000000';
  if (rgb === 'white') return 'FFFFFF';
  
  return '000000'; // Default to black
}

// Encode color efficiently
function encodeColor(color) {
  if (!color || color === 'none') return Buffer.from([0]);
  
  let hex;
  if (color.startsWith('rgb')) {
    hex = rgbToHex(color);
  } else if (color.startsWith('#')) {
    hex = color.slice(1).toUpperCase();
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

// Encode floating-point coordinate
function encodeCoordinate(value) {
  // Store as integer value * 10 to maintain one decimal place
  const intValue = Math.round(parseFloat(value) * 10);
  return encodeVarInt(intValue);
}

// Extract SVG metadata
function extractSVGMetadata(svgString) {
  const viewBoxMatch = svgString.match(/viewBox="([^"]*)"/);
  
  const metadata = {
    viewBox: `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`, // Default
    width: TARGET_SIZE,
    height: TARGET_SIZE
  };
  
  if (viewBoxMatch) {
    metadata.viewBox = viewBoxMatch[1];
    const parts = viewBoxMatch[1].split(/\s+/).map(parseFloat);
    if (parts.length === 4) {
      metadata.width = parts[2];
      metadata.height = parts[3];
    }
  }
  
  return metadata;
}

// Compress main path with direct path data encoding
function compressMainPath(pathElement) {
  // Extract attributes
  const fillMatch = pathElement.match(/fill="([^"]*)"/);
  const strokeMatch = pathElement.match(/stroke="([^"]*)"/);
  const strokeWidthMatch = pathElement.match(/stroke-width="([^"]*)"/);
  const dMatch = pathElement.match(/d="([^"]*)"/);
  
  if (!dMatch) return null; // Skip invalid paths
  
  const fill = fillMatch ? fillMatch[1] : 'none';
  const stroke = strokeMatch ? strokeMatch[1] : 'none';
  const strokeWidth = strokeWidthMatch ? parseFloat(strokeWidthMatch[1]) : 0;
  
  // Store path data as a direct string
  const pathData = dMatch[1];
  const pathDataBuffer = Buffer.from(pathData);
  
  return Buffer.concat([
    Buffer.from([0x01]), // Main path marker
    encodeColor(fill),
    encodeColor(stroke),
    encodeVarInt(Math.round(strokeWidth * 10)), // Store stroke width with 1 decimal place
    encodeVarInt(pathDataBuffer.length), // Store length of path data
    pathDataBuffer // Store raw path data
  ]);
}

// Compress line element (horizontal lines)
function compressLine(lineElement) {
  // Extract attributes
  const x1Match = lineElement.match(/x1="([^"]*)"/);
  const y1Match = lineElement.match(/y1="([^"]*)"/);
  const x2Match = lineElement.match(/x2="([^"]*)"/);
  const y2Match = lineElement.match(/y2="([^"]*)"/);
  const strokeMatch = lineElement.match(/stroke="([^"]*)"/);
  const strokeWidthMatch = lineElement.match(/stroke-width="([^"]*)"/);
  
  if (!x1Match || !y1Match || !x2Match || !y2Match) return null;
  
  const x1 = parseFloat(x1Match[1]);
  const y1 = parseFloat(y1Match[1]);
  const x2 = parseFloat(x2Match[1]);
  const y2 = parseFloat(y2Match[1]);
  const stroke = strokeMatch ? strokeMatch[1] : 'black';
  const strokeWidth = strokeWidthMatch ? parseFloat(strokeWidthMatch[1]) : 1;
  
  return Buffer.concat([
    Buffer.from([0x02]), // Line marker
    encodeCoordinate(x1),
    encodeCoordinate(y1),
    encodeCoordinate(x2),
    encodeCoordinate(y2),
    encodeColor(stroke),
    encodeVarInt(Math.round(strokeWidth * 10)) // Store stroke width with 1 decimal place
  ]);
}

// Compress text element
function compressText(textElement) {
  // Extract attributes
  const xMatch = textElement.match(/x="([^"]*)"/);
  const yMatch = textElement.match(/y="([^"]*)"/);
  const fillMatch = textElement.match(/fill="([^"]*)"/);
  const fontSizeMatch = textElement.match(/font-size="([^"]*)"/);
  
  // Extract text content
  const textMatch = textElement.match(/>([^<]*)</);
  
  if (!xMatch || !yMatch || !textMatch) return null;
  
  const x = parseFloat(xMatch[1]);
  const y = parseFloat(yMatch[1]);
  const fill = fillMatch ? fillMatch[1] : 'black';
  const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : 12;
  const text = textMatch[1].trim();
  
  // Encode text content (using dictionary if available)
  let textBuffer;
  if (TEXT_DICT[text]) {
    textBuffer = Buffer.from([TEXT_DICT[text]]);
  } else {
    // Fall back to encoding full text
    const textBytes = Buffer.from(text);
    textBuffer = Buffer.concat([
      encodeVarInt(textBytes.length),
      textBytes
    ]);
  }
  
  return Buffer.concat([
    Buffer.from([0x03]), // Text marker
    encodeCoordinate(x),
    encodeCoordinate(y),
    encodeColor(fill),
    encodeVarInt(fontSize),
    Buffer.from([TEXT_DICT[text] ? 1 : 0]), // 1 for dictionary, 0 for raw
    textBuffer
  ]);
}

// Compress SVG to binary format
function compressSVG(svgString) {
  try {
    // Optimize with SVGO (minimal changes)
    const optimized = optimize(svgString, svgoConfig).data;
    
    // Extract SVG metadata
    const metadata = extractSVGMetadata(optimized);
    
    // Extract specific elements
    const pathMatch = optimized.match(/<path[^>]*d="[^"]*"[^>]*>/);
    const lineMatches = optimized.match(/<line[^>]*>/g) || [];
    const textMatch = optimized.match(/<text[^>]*>[^<]*<\/text>/);
    
    // Prepare metadata buffer
    const viewBoxBuffer = Buffer.from(metadata.viewBox);
    const metadataBuffer = Buffer.concat([
      Buffer.from([0x00]), // Metadata marker
      encodeVarInt(viewBoxBuffer.length),
      viewBoxBuffer
    ]);
    
    const parts = [metadataBuffer];
    
    // Add main path
    if (pathMatch) {
      const pathBuffer = compressMainPath(pathMatch[0]);
      if (pathBuffer) parts.push(pathBuffer);
    }
    
    // Add lines
    for (const lineElement of lineMatches) {
      const lineBuffer = compressLine(lineElement);
      if (lineBuffer) parts.push(lineBuffer);
    }
    
    // Add text
    if (textMatch) {
      const textBuffer = compressText(textMatch[0]);
      if (textBuffer) parts.push(textBuffer);
    }
    
    // Combine all parts
    let combinedBuffer;
    try {
      combinedBuffer = Buffer.concat(parts);
    } catch (error) {
      console.error('Error concatenating parts:', error);
      throw error;
    }
    
    // Version and header - using version 3 for raw path data approach
    const header = Buffer.from([
      0x03, // Version 3 marker for raw path data approach
      parts.length - 1 // Number of elements (excluding metadata)
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