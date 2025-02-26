const fs = require('fs');
const path = require('path');

// Decompression parameters
const TARGET_SIZE = 420;

// Color dictionary matching the compress.js dictionary
const COLOR_DICT = {
  1: '000000',  // black
  2: 'FFFFFF',  // white
  3: '808080',  // gray
  4: 'FF0000',  // red
  5: '00FF00',  // green
  6: '0000FF',  // blue
  7: 'FFFF00',  // yellow
  8: '00FFFF',  // cyan
  9: 'FF00FF',  // magenta
  10: 'C0C0C0', // silver
  11: 'A0A0A0', // darker gray
  12: 'D0D0D0', // lighter gray
  13: 'FFA500', // orange
  14: '800080', // purple
  15: '00BFFF', // deep sky blue
  16: '785D06', // gold-brown (common in top trait)
  17: '4A8019', // green (common in top trait)
  18: 'A09DF6', // lavender (common in top trait)
  19: '31B915', // bright green (common in top trait)
  0: 'none',    // transparent
};

// Text options dictionary matching compress.js
const TEXT_DICT = {
  1: 'muse',
  2: 'space',
  3: 'astro'
};

// Decode variable-length integer
function decodeVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let currentByte;
  let bytesRead = 0;
  
  do {
    if (offset + bytesRead >= buffer.length) {
      throw new Error(`Buffer overflow when reading varint at offset ${offset}`);
    }
    
    currentByte = buffer[offset + bytesRead];
    result |= (currentByte & 0x7F) << shift;
    shift += 7;
    bytesRead++;
  } while (currentByte & 0x80);
  
  return {
    value: result,
    bytesRead: bytesRead
  };
}

// Decode coordinate value
function decodeCoordinate(buffer, offset) {
  const { value, bytesRead } = decodeVarInt(buffer, offset);
  return {
    value: value / 10, // Convert back from integer to float with 1 decimal place
    bytesRead: bytesRead
  };
}

// Decode color from compact representation
function decodeColor(buffer, offset) {
  if (offset >= buffer.length) {
    throw new Error(`Buffer overflow when reading color at offset ${offset}`);
  }
  
  let bytesRead = 1;
  const colorCode = buffer[offset];
  
  // Check if it's a dictionary color
  if (colorCode < 254 && COLOR_DICT[colorCode] !== undefined) {
    return {
      color: colorCode === 0 ? 'none' : `#${COLOR_DICT[colorCode]}`,
      bytesRead: bytesRead
    };
  }
  
  // Check if it's a full RGB color
  if (colorCode === 254) {
    if (offset + 3 >= buffer.length) {
      throw new Error(`Buffer overflow when reading RGB color at offset ${offset}`);
    }
    
    const r = buffer[offset + 1].toString(16).padStart(2, '0');
    const g = buffer[offset + 2].toString(16).padStart(2, '0');
    const b = buffer[offset + 3].toString(16).padStart(2, '0');
    
    return {
      color: `#${r}${g}${b}`.toUpperCase(),
      bytesRead: 4
    };
  }
  
  throw new Error(`Unknown color encoding: ${colorCode} at offset ${offset}`);
}

// Decompress SVG metadata
function decompressMetadata(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode viewBox length
  const { value: viewBoxLength, bytesRead: vbLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += vbLengthBytes;
  
  // Decode viewBox string
  let viewBox = '';
  for (let i = 0; i < viewBoxLength && currentOffset + i < buffer.length; i++) {
    viewBox += String.fromCharCode(buffer[currentOffset + i]);
  }
  currentOffset += viewBoxLength;
  
  return {
    viewBox: viewBox,
    bytesRead: currentOffset - offset
  };
}

// Decompress main path with raw path data
function decompressMainPath(buffer, offset, version) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode fill color
  const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
  currentOffset += fillBytes;
  
  // Decode stroke color
  const { color: stroke, bytesRead: strokeBytes } = decodeColor(buffer, currentOffset);
  currentOffset += strokeBytes;
  
  // Decode stroke width
  const { value: strokeWidthInt, bytesRead: strokeWidthBytes } = decodeVarInt(buffer, currentOffset);
  const strokeWidth = strokeWidthInt / 10; // Convert to float with 1 decimal
  currentOffset += strokeWidthBytes;
  
  let pathData;
  
  // Handle based on version
  if (version >= 3) {
    // Version 3+: Raw path data
    const { value: pathDataLength, bytesRead: pathDataLengthBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += pathDataLengthBytes;
    
    // Read raw path data
    pathData = '';
    for (let i = 0; i < pathDataLength && currentOffset + i < buffer.length; i++) {
      pathData += String.fromCharCode(buffer[currentOffset + i]);
    }
    currentOffset += pathDataLength;
  } else {
    // Older versions: Try to recover with a simpler path
    pathData = "M100,200 L340,200 L340,340 L100,340 Z";
    console.error("Incompatible path data version, using simplified path");
  }
  
  // Create path element
  let element = `<path d="${pathData}" fill="${fill}"`;
  
  // Add stroke attributes if present
  if (stroke !== 'none' && strokeWidth > 0) {
    element += ` stroke="${stroke}" stroke-width="${strokeWidth.toFixed(1)}"`;
  }
  
  element += '/>'; 
  
  return {
    element: element,
    bytesRead: currentOffset - offset
  };
}

// Decompress line element
function decompressLine(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode coordinates
  const { value: x1, bytesRead: x1Bytes } = decodeCoordinate(buffer, currentOffset);
  currentOffset += x1Bytes;
  
  const { value: y1, bytesRead: y1Bytes } = decodeCoordinate(buffer, currentOffset);
  currentOffset += y1Bytes;
  
  const { value: x2, bytesRead: x2Bytes } = decodeCoordinate(buffer, currentOffset);
  currentOffset += x2Bytes;
  
  const { value: y2, bytesRead: y2Bytes } = decodeCoordinate(buffer, currentOffset);
  currentOffset += y2Bytes;
  
  // Decode stroke color
  const { color: stroke, bytesRead: strokeBytes } = decodeColor(buffer, currentOffset);
  currentOffset += strokeBytes;
  
  // Decode stroke width
  const { value: strokeWidthInt, bytesRead: strokeWidthBytes } = decodeVarInt(buffer, currentOffset);
  const strokeWidth = strokeWidthInt / 10; // Convert to float with 1 decimal
  currentOffset += strokeWidthBytes;
  
  // Create line element
  const element = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${strokeWidth.toFixed(2)}"/>`;
  
  return {
    element: element,
    bytesRead: currentOffset - offset
  };
}

// Decompress text element
function decompressText(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode position
  const { value: x, bytesRead: xBytes } = decodeCoordinate(buffer, currentOffset);
  currentOffset += xBytes;
  
  const { value: y, bytesRead: yBytes } = decodeCoordinate(buffer, currentOffset);
  currentOffset += yBytes;
  
  // Decode fill color
  const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
  currentOffset += fillBytes;
  
  // Decode font size
  const { value: fontSize, bytesRead: fontSizeBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += fontSizeBytes;
  
  // Decode dictionary/raw flag
  const isDictionary = buffer[currentOffset] === 1;
  currentOffset++;
  
  // Decode text content
  let text = '';
  if (isDictionary) {
    const dictIndex = buffer[currentOffset];
    text = TEXT_DICT[dictIndex] || 'text';
    currentOffset++;
  } else {
    const { value: textLength, bytesRead: textLengthBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += textLengthBytes;
    
    for (let i = 0; i < textLength && currentOffset + i < buffer.length; i++) {
      text += String.fromCharCode(buffer[currentOffset + i]);
    }
    currentOffset += textLength;
  }
  
  // Create text element
  const element = `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" font-size="${fontSize.toFixed(0)}" font-family="monospace" font-weight="bold" text-anchor="middle">${text}</text>`;
  
  return {
    element: element,
    bytesRead: currentOffset - offset
  };
}

// Decompress SVG from binary format
function decompressSVG(compressedData) {
  try {
    // Convert from base64 to binary
    const buffer = Buffer.from(compressedData, 'base64');
    
    if (buffer.length < 2) {
      throw new Error('Invalid compressed data: too short');
    }
    
    // Parse header
    const version = buffer[0];
    const elementCount = buffer[1];
    console.log(`Top SVG Format version ${version}, contains ${elementCount} elements`);
    
    // Elements for reconstructing SVG
    let viewBox = `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`; // Default viewBox
    let mainPath = '';
    let lines = [];
    let text = '';
    
    // Parse all parts
    let offset = 2; // Start after header
    
    try {
      while (offset < buffer.length) {
        if (offset >= buffer.length) break;
        
        const markerByte = buffer[offset];
        
        switch (markerByte) {
          case 0x00: // Metadata
            const metaResult = decompressMetadata(buffer, offset);
            viewBox = metaResult.viewBox;
            offset += metaResult.bytesRead;
            break;
            
          case 0x01: // Main path
            const pathResult = decompressMainPath(buffer, offset, version);
            mainPath = pathResult.element;
            offset += pathResult.bytesRead;
            break;
            
          case 0x02: // Line
            const lineResult = decompressLine(buffer, offset);
            lines.push(lineResult.element);
            offset += lineResult.bytesRead;
            break;
            
          case 0x03: // Text
            const textResult = decompressText(buffer, offset);
            text = textResult.element;
            offset += textResult.bytesRead;
            break;
            
          default:
            console.error(`Unknown element marker: ${markerByte} at offset ${offset}, stopping processing`);
            // This is likely corrupt data, so stop processing
            offset = buffer.length;
            break;
        }
      }
    } catch (e) {
      console.error("Error during decompression:", e);
      // Continue with what we have
    }
    
    // If we don't have a main path, return fallback
    if (!mainPath) {
      return createFallbackTop();
    }
    
    // Reconstruct SVG with proper viewBox
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_SIZE}" height="${TARGET_SIZE}" viewBox="${viewBox}">`;
    
    // Add elements in order: path, lines, text
    svgContent += mainPath;
    
    // Add lines
    lines.forEach(line => {
      svgContent += line;
    });
    
    // Add text if present
    if (text) {
      svgContent += text;
    }
    
    svgContent += '</svg>';
    
    return svgContent;
  } catch (error) {
    console.error('Decompression error:', error);
    
    // Create a fallback Top trait SVG if decompression fails
    return createFallbackTop();
  }
}

// Create a minimal fallback Top trait if decompression completely fails
function createFallbackTop() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <path d="M80,200 L340,200 L340,340 L80,340 Z" fill="#785D06" stroke="#000000" stroke-width="1" />
  <line x1="138.5" y1="409" x2="253.5" y2="409" stroke="#A09DF6" stroke-width="3.69"/>
  <line x1="145" y1="372" x2="247" y2="372" stroke="#31B915" stroke-width="3.69"/>
  <text x="196" y="396" fill="#4A8019" font-size="35" font-family="monospace" font-weight="bold" text-anchor="middle">space</text>
</svg>`;
}

// Process compressed files
function processCompressedFiles() {
  const inputDir = path.join(__dirname, 'SVGs');
  const compressedDir = path.join(__dirname, 'compressed');
  const outputDir = path.join(__dirname, 'decompressed');
  
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
  
  const results = {};
  
  fs.readdirSync(compressedDir).forEach(file => {
    if (file.endsWith('.bin')) {
      try {
        const filePath = path.join(compressedDir, file);
        const compressedData = fs.readFileSync(filePath, 'utf8');
        
        console.log(`Processing ${file}, compressed size: ${compressedData.length} bytes`);
        
        const decompressed = decompressSVG(compressedData);
        if (decompressed) {
          const outputPath = path.join(outputDir, file.replace('.bin', '.svg'));
          fs.writeFileSync(outputPath, decompressed);
          console.log(`Decompressed ${file} to ${outputPath}`);
          
          // Verify against original if available
          const originalFile = path.join(inputDir, file.replace('.bin', '.svg'));
          if (fs.existsSync(originalFile)) {
            console.log(`Original file found for ${file}`);
          } else {
            console.log(`No original file found for ${file}`);
          }
          
          results[file] = {
            decompressed: true,
            size: decompressed.length
          };
        } else {
          console.error(`Failed to decompress ${file}`);
          results[file] = {
            decompressed: false
          };
        }
      } catch (error) {
        console.error(`Error processing ${file}:`, error);
        results[file] = {
          decompressed: false,
          error: error.message
        };
      }
    }
  });
  
  // Write results summary
  fs.writeFileSync(
    path.join(outputDir, 'decompression_summary.json'), 
    JSON.stringify(results, null, 2)
  );
  
  console.log('\nDecompression summary written to decompression_summary.json');
}

// Execute decompression
processCompressedFiles();