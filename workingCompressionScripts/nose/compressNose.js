const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration for Nose SVGs
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeComments', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'convertColors', active: false }, // Don't convert colors to preserve format
    { name: 'removeUselessStrokeAndFill', active: true },
    { name: 'cleanupNumericValues', params: { floatPrecision: 2 } }, // Keep 2 decimals
    { name: 'convertPathData', active: false }, // Don't modify path data to preserve details
    { name: 'removeEmptyAttrs', active: true },
    { name: 'collapseGroups', active: false }  // Don't collapse groups to preserve structure
  ],
};

// Compression parameters
const TARGET_SIZE = 420;
const QUANTIZATION_SCALE = 20; // More aggressive quantization for better compression

// Color dictionary optimized for nose traits
const COLOR_DICT = {
  '000000': 1,   // black
  'FFFFFF': 2,   // white
  '808080': 3,   // gray
  'FF0000': 4,   // neon red
  '00FF00': 5,   // neon green
  '0000FF': 6,   // neon blue
  'FFFF00': 7,   // neon yellow
  '00FFFF': 8,   // neon cyan
  'FF00FF': 9,   // neon magenta
  '7F00FF': 10,  // neon purple
  'FF7F00': 11,  // neon orange
  '7FFF00': 12,  // neon chartreuse
  '00FF7F': 13,  // neon spring green
  '007FFF': 14,  // neon azure
  'FF007F': 15,  // neon pink
  // Dark rustic colors
  '503020': 16,  // dark brown
  '642814': 17,  // rusty brown
  '461E14': 18,  // deep reddish-brown
  '3C3C32': 19,  // dark gray-brown
  '5A2D23': 20,  // muted rust
  '321E28': 21,  // dark plum
  '463214': 22,  // olive brown
  '283C1E': 23,  // forest green-brown
  '55232D': 24,  // burgundy rust
  '3C283C': 25,  // dark slate
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

// Parse path data with SVG command optimization
function parsePath(d) {
  if (!d) return [];
  
  const commands = [];
  let currentCmd = null;
  let params = [];
  let lastX = 0, lastY = 0;
  
  // Parse SVG path commands
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
  
  // Optimize commands with delta encoding for coordinates
  const optimizedCmds = [];
  for (const cmd of commands) {
    const { cmd: command, params } = cmd;
    
    // Apply delta encoding for relative commands (lowercase)
    if (command === 'm' || command === 'l') {
      // Handle move and line commands with delta encoding
      const optimizedParams = [];
      for (let i = 0; i < params.length; i += 2) {
        if (i === 0 || command === 'm') {
          optimizedParams.push(params[i]);
          optimizedParams.push(params[i+1]);
        } else {
          // Delta encode subsequent coordinates
          const deltaX = params[i] - lastX;
          const deltaY = params[i+1] - lastY;
          optimizedParams.push(deltaX);
          optimizedParams.push(deltaY);
        }
        lastX = params[i];
        lastY = params[i+1];
      }
      optimizedCmds.push({ cmd: command, params: optimizedParams });
    } else {
      // Pass through other commands unchanged
      optimizedCmds.push(cmd);
    }
  }
  
  return optimizedCmds;
}

// Encode path commands with optimized storage
function encodePathData(pathCommands) {
  // Store command count
  const result = [encodeVarInt(pathCommands.length)];
  
  for (const { cmd, params } of pathCommands) {
    // Encode command as a single byte
    result.push(Buffer.from([cmd.charCodeAt(0)]));
    
    // Encode parameter count
    result.push(encodeVarInt(params.length));
    
    // Encode parameters with higher quantization for better compression
    for (const param of params) {
      // Use more aggressive quantization (20 instead of 10)
      const quantized = Math.round(param * 20);
      result.push(encodeSignedVarInt(quantized));
    }
  }
  
  return Buffer.concat(result);
}

// Compress glow filter with minimal encoding
function compressGlowFilter(filterDef) {
  // Extract key filter parameters
  let stdDeviation = 4; // Default value
  const stdDevMatch = filterDef.match(/stdDeviation="([^"]*)"/);
  if (stdDevMatch) stdDeviation = parseFloat(stdDevMatch[1]);
  
  // Check if it's the default value (4.0)
  const isDefault = Math.abs(stdDeviation - 4.0) < 0.1;
  
  // If it's the default, just store a flag with no value
  if (isDefault) {
    return Buffer.from([0x02, 0x01]); // Filter marker + default flag
  }
  
  // Otherwise store the custom value
  return Buffer.concat([
    Buffer.from([0x02, 0x00]), // Filter marker + custom flag
    encodeVarInt(Math.round(stdDeviation * 10)) // Store stdDeviation with 1 decimal place
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

// Compress path with optimized encoding for common cases
function compressPath(path, type) {
  // Extract attributes
  const fillMatch = path.match(/fill="([^"]*)"/);
  const opacityMatch = path.match(/opacity="([^"]*)"/);
  const dMatch = path.match(/d="([^"]*)"/);
  
  if (!dMatch) return null; // Skip invalid paths
  
  const fill = fillMatch ? fillMatch[1] : 'none';
  const opacity = opacityMatch ? parseFloat(opacityMatch[1]) : 1.0;
  const pathData = parsePath(dMatch[1]);
  
  // Determine path type and compression flags
  const typeValue = type === 'shadow' ? 1 : 0;
  const hasFullOpacity = Math.abs(opacity - 1.0) < 0.01;
  
  // Combined flag byte: 
  // - bit 0: path type (0=base, 1=shadow)
  // - bit 1: opacity flag (0=has opacity, 1=full opacity/skip)
  const flagByte = (typeValue & 0x01) | ((hasFullOpacity ? 1 : 0) << 1);
  
  // Build the parts to concat
  const parts = [
    Buffer.from([0x01]), // Path marker
    Buffer.from([flagByte]), // Combined flags
    encodeColor(fill)
  ];
  
  // Only include opacity if not 1.0
  if (!hasFullOpacity) {
    parts.push(encodeFloat(opacity, true));
  }
  
  // Add path data
  parts.push(encodePathData(pathData));
  
  return Buffer.concat(parts);
}

// Compress SVG to binary format
function compressSVG(svgString) {
  try {
    console.log("Starting compression of SVG, length:", svgString.length);
    
    // Optimize with SVGO
    const optimized = optimize(svgString, svgoConfig).data;
    console.log("Optimized SVG length:", optimized.length);
    
    // Extract SVG metadata
    const metadata = extractSVGMetadata(optimized);
    console.log("Extracted metadata, viewBox:", metadata.viewBox);
    
    // Extract all path elements
    const pathMatches = optimized.match(/<path[^>]*>/g) || [];
    console.log("Found", pathMatches.length, "path elements");
    
    // Extract filter definition
    const filterMatch = optimized.match(/<filter[^>]*>[\s\S]*?<\/filter>/);
    const hasFilter = filterMatch !== null;
    console.log("Found filter:", hasFilter);
    
    // Prepare metadata buffer
    const viewBoxBuffer = Buffer.from(metadata.viewBox);
    const metadataBuffer = Buffer.concat([
      Buffer.from([0x00]), // Metadata marker
      encodeVarInt(viewBoxBuffer.length),
      viewBoxBuffer
    ]);
    
    const parts = [metadataBuffer];
    
    // Compress filter if present
    if (hasFilter) {
      const filterBuffer = compressGlowFilter(filterMatch[0]);
      parts.push(filterBuffer);
      console.log("Added filter to parts");
    }
    
    // Compress paths with type information
    for (let i = 0; i < pathMatches.length; i++) {
      const pathElement = pathMatches[i];
      
      // Determine path type (base or shadow)
      const isOpacity = pathElement.includes('opacity=') && pathElement.includes('0.7');
      const isWhite = pathElement.includes('#FFFFFF') || pathElement.includes('white');
      const type = (isOpacity && isWhite) ? 'shadow' : 'base';
      
      const compressedPath = compressPath(pathElement, type);
      if (compressedPath) {
        parts.push(compressedPath);
        console.log(`Added path ${i+1}/${pathMatches.length} (type: ${type})`);
      } else {
        console.log(`Skip invalid path ${i+1}/${pathMatches.length}`);
      }
    }
    
    // Combine all parts
    let combinedBuffer;
    try {
      combinedBuffer = Buffer.concat(parts);
      console.log("Successfully concatenated", parts.length, "parts");
    } catch (error) {
      console.error('Error concatenating parts:', error);
      throw error;
    }
    
    // Version and header - using version 5 for nose traits
    const header = Buffer.from([
      0x05, // Version 5 marker for nose format
      parts.length - 1 // Number of elements (excluding metadata)
    ]);
    
    const fullBuffer = Buffer.concat([header, combinedBuffer]);
    console.log("Final buffer size:", fullBuffer.length, "bytes");
    
    // For blockchain compatibility, use base64 encoding
    const base64Result = fullBuffer.toString('base64');
    console.log("Base64 encoded result length:", base64Result.length);
    
    return base64Result;
  } catch (error) {
    console.error('Error compressing SVG:', error);
    throw error;
  }
}

// Process all SVGs in the directory
function processSVGs() {
  // Get current directory
  const currentDir = process.cwd();
  console.log("Current working directory:", currentDir);
  
  // Set input and output directories
  const inputDir = path.join(currentDir, 'SVGs');
  const outputDir = path.join(currentDir, 'compressed');
  
  console.log("Input directory:", inputDir);
  console.log("Output directory:", outputDir);
  
  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    console.log("Creating output directory");
    fs.mkdirSync(outputDir);
  }
  
  // Check if input directory exists
  if (!fs.existsSync(inputDir)) {
    console.error("ERROR: SVGs directory does not exist!");
    return;
  }
  
  // List all files in the directory
  const allFiles = fs.readdirSync(inputDir);
  console.log("Found", allFiles.length, "files in SVGs directory:", allFiles);
  
  // Filter SVG files
  const svgFiles = allFiles.filter(file => file.endsWith('.svg'));
  console.log("Found", svgFiles.length, "SVG files:", svgFiles);
  
  if (svgFiles.length === 0) {
    console.error("No SVG files found in the directory!");
    return;
  }
  
  const results = {};
  
  // Process each SVG file
  for (const file of svgFiles) {
    console.log("\n========================================");
    console.log(`Processing ${file}`);
    
    try {
      const svgPath = path.join(inputDir, file);
      console.log("Reading from:", svgPath);
      
      // Check if file exists
      if (!fs.existsSync(svgPath)) {
        console.error(`File ${svgPath} does not exist!`);
        continue;
      }
      
      // Read SVG content
      const svgContent = fs.readFileSync(svgPath, 'utf8');
      console.log(`Read ${file}, size: ${svgContent.length} bytes`);
      
      // Compress the SVG
      const compressed = compressSVG(svgContent);
      const outputPath = path.join(outputDir, `${file.replace('.svg', '.bin')}`);
      console.log("Writing to:", outputPath);
      
      // Write compressed data
      fs.writeFileSync(outputPath, compressed);
      console.log(`Wrote compressed file: ${outputPath}`);
      
      // Log compression stats
      const originalSize = svgContent.length;
      const compressedSize = compressed.length;
      const ratio = ((originalSize - compressedSize) / originalSize * 100).toFixed(2);
      console.log(`Compression: ${originalSize} → ${compressedSize} bytes (${ratio}% reduction)`);
      
      results[file] = {
        original: originalSize,
        compressed: compressedSize,
        ratio: `${ratio}%`
      };
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
      results[file] = {
        error: error.message
      };
    }
  }
  
  // Write compression summary
  const summaryPath = path.join(outputDir, 'nose_compression_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nCompression summary written to ${summaryPath}`);
}

// Execute compression
processSVGs();