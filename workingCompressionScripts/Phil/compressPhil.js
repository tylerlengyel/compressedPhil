const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration for Phil SVGs
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeComments', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'convertColors', active: false }, // Don't convert colors to preserve RGB format
    { name: 'removeUselessStrokeAndFill', active: true },
    { name: 'cleanupNumericValues', params: { floatPrecision: 2 } }, // Keep 2 decimals
    { name: 'convertPathData', active: true },
    { name: 'removeEmptyAttrs', active: true },
    { name: 'collapseGroups', active: true }
  ],
};

// Compression parameters
const TARGET_SIZE = 420;
const QUANTIZATION_SCALE = 10; // More aggressive quantization for path data

// Color dictionary optimized for Phil SVGs
const COLOR_DICT = {
  '000000': 1,   // black
  'FFFFFF': 2,   // white
  '808080': 3,   // gray
  '0D00FF': 4,   // deep blue (common in Phil)
  '5858FF': 5,   // medium blue (common in Phil)
  '00B7FF': 6,   // light blue (common in Phil)
  '66C9FF': 7,   // pale blue (common in Phil)
  'FF0000': 8,   // red
  '00FF00': 9,   // green
  '0000FF': 10,  // blue
  'FFFF00': 11,  // yellow
  '00FFFF': 12,  // cyan
  'FF00FF': 13,  // magenta
  '080055': 14,  // dark blue stroke (common in Phil)
  'none': 0,     // transparent
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

// Convert RGB color string to hex
function rgbToHex(rgb) {
  if (!rgb) return 'none';
  
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

// Encode float values with precision control
function encodeFloat(value, isOpacity = false) {
  if (isOpacity) {
    // Store opacity with 2 decimal precision (0-100 range)
    return encodeVarInt(Math.round(value * 100));
  }
  
  // For coordinates and path data, quantize more aggressively
  const quantized = Math.round(value * QUANTIZATION_SCALE);
  return encodeSignedVarInt(quantized);
}

// Parse path data with quantization
function parsePath(d) {
  if (!d) return [];
  
  const commands = [];
  let currentCmd = null;
  let params = [];
  
  // Basic parsing of SVG path commands
  const regex = /([MLHVCSQTAZmlhvcsqtaz])|([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)/g;
  let match;
  
  while ((match = regex.exec(d)) !== null) {
    if (match[1]) { // Command
      if (currentCmd) {
        commands.push({ cmd: currentCmd, params: [...params] });
        params = [];
      }
      currentCmd = match[1];
    } else if (match[2]) { // Parameter
      params.push(parseFloat(match[2]));
    }
  }
  
  if (currentCmd) {
    commands.push({ cmd: currentCmd, params: [...params] });
  }
  
  return commands;
}

// Quantize and encode path commands
function encodePath(pathCommands) {
  const result = [];
  
  // Store command count
  result.push(encodeVarInt(pathCommands.length));
  
  for (const { cmd, params } of pathCommands) {
    // Encode command
    result.push(Buffer.from([cmd.charCodeAt(0)]));
    
    // Encode parameter count
    result.push(encodeVarInt(params.length));
    
    // Encode parameters (quantized)
    for (const param of params) {
      result.push(encodeFloat(param));
    }
  }
  
  return Buffer.concat(result);
}

// Compress path element
function compressPath(path) {
  // Extract attributes
  const fillMatch = path.match(/fill="([^"]*)"/);
  const strokeMatch = path.match(/stroke="([^"]*)"/);
  const strokeWidthMatch = path.match(/stroke-width="([^"]*)"/);
  const opacityMatch = path.match(/opacity="([^"]*)"/);
  const dMatch = path.match(/d="([^"]*)"/);
  
  if (!dMatch) return null; // Skip invalid paths
  
  const fill = fillMatch ? fillMatch[1] : 'none';
  const stroke = strokeMatch ? strokeMatch[1] : 'none';
  const strokeWidth = strokeWidthMatch ? parseFloat(strokeWidthMatch[1]) : 0;
  const opacity = opacityMatch ? parseFloat(opacityMatch[1]) : 1.0;
  
  // Parse path data
  const pathCommands = parsePath(dMatch[1]);
  
  return Buffer.concat([
    Buffer.from([0x01]), // Path marker
    encodeColor(fill),
    encodeColor(stroke),
    encodeFloat(strokeWidth),
    encodeFloat(opacity, true),
    encodePath(pathCommands)
  ]);
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

// Compress SVG to binary format
function compressSVG(svgString) {
  try {
    // Optimize with SVGO
    const optimized = optimize(svgString, svgoConfig).data;
    
    // Extract SVG metadata
    const metadata = extractSVGMetadata(optimized);
    
    // Extract all path elements
    const pathMatches = optimized.match(/<path[^>]*>/g) || [];
    
    // Prepare metadata buffer
    const viewBoxBuffer = Buffer.from(metadata.viewBox);
    const metadataBuffer = Buffer.concat([
      Buffer.from([0x00]), // Metadata marker
      encodeVarInt(viewBoxBuffer.length),
      viewBoxBuffer
    ]);
    
    const parts = [metadataBuffer];
    
    // Compress paths
    for (const pathElement of pathMatches) {
      const compressedPath = compressPath(pathElement);
      if (compressedPath) {
        parts.push(compressedPath);
      }
    }
    
    // Combine all parts
    let combinedBuffer;
    try {
      combinedBuffer = Buffer.concat(parts);
    } catch (error) {
      console.error('Error concatenating parts:', error);
      throw error;
    }
    
    // Version and header - using version 1 for Phil format
    const header = Buffer.from([
      0x01, // Version 1 marker for Phil format
      parts.length - 1 // Number of paths (excluding metadata)
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