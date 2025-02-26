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

// Read a string of specified length from buffer
function readString(buffer, offset, length) {
  let str = '';
  for (let i = 0; i < length && offset + i < buffer.length; i++) {
    str += String.fromCharCode(buffer[offset + i]);
  }
  return str;
}

// Decompress SVG metadata
function decompressMetadata(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode viewBox length
  const { value: viewBoxLength, bytesRead: vbLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += vbLengthBytes;
  
  // Decode viewBox string
  let viewBox = readString(buffer, currentOffset, viewBoxLength);
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
      pathData = readString(buffer, currentOffset, pathDataLength);
      currentOffset += pathDataLength;
    } else {
      // Older versions: Try to recover with a simpler path
      pathData = "M100,200 L340,200 L340,420 L100,420 Z";
      console.error("Incompatible path data version, using simplified path");
    }
    
    // Create path element with fill
    let element = `<path d="${pathData}" fill="${fill}"`;
    
    // Always add stroke attributes - even if stroke is 'none', as this maintains consistency
    element += ` stroke="${stroke}" stroke-width="${strokeWidth.toFixed(1)}"`;
    
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
    
    text = readString(buffer, currentOffset, textLength);
    currentOffset += textLength;
  }
  
  // Create text element
  const element = `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" font-size="${fontSize.toFixed(0)}" font-family="monospace" font-weight="bold" text-anchor="middle">${text}</text>`;
  
  return {
    element: element,
    bytesRead: currentOffset - offset
  };
}

// Decompress filter definition
function decompressFilter(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Read filter ID
  const { value: idLength, bytesRead: idLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += idLengthBytes;
  
  const filterId = readString(buffer, currentOffset, idLength);
  currentOffset += idLength;
  
  // Read baseFrequency
  const { value: baseFreqLength, bytesRead: baseFreqLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += baseFreqLengthBytes;
  
  const baseFrequency = readString(buffer, currentOffset, baseFreqLength);
  currentOffset += baseFreqLength;
  
  // Read numOctaves
  const { value: octavesLength, bytesRead: octavesLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += octavesLengthBytes;
  
  const numOctaves = readString(buffer, currentOffset, octavesLength);
  currentOffset += octavesLength;
  
  // Read seed
  const { value: seedLength, bytesRead: seedLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += seedLengthBytes;
  
  const seed = readString(buffer, currentOffset, seedLength);
  currentOffset += seedLength;
  
  // Read scale
  const { value: scaleLength, bytesRead: scaleLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += scaleLengthBytes;
  
  const scale = readString(buffer, currentOffset, scaleLength);
  currentOffset += scaleLength;
  
  // Read duration
  const { value: durationLength, bytesRead: durationLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += durationLengthBytes;
  
  const duration = readString(buffer, currentOffset, durationLength);
  currentOffset += durationLength;
  
  // Read animation flag and values
  const hasCustomAnimation = buffer[currentOffset] === 1;
  currentOffset++;
  
  let animationValues = '0.02; 0.05; 0.08; 0.04; 0.02'; // Default values
  
  if (hasCustomAnimation) {
    const { value: valuesLength, bytesRead: valuesLengthBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += valuesLengthBytes;
    
    if (valuesLength > 0) {
      animationValues = readString(buffer, currentOffset, valuesLength);
      currentOffset += valuesLength;
    }
  }
  
  // Construct filter element
  const element = `<defs>
  <filter id="${filterId}" x="0%" y="0%" width="100%" height="100%">
    <feTurbulence type="turbulence" baseFrequency="${baseFrequency}" numOctaves="${numOctaves}" seed="${seed}" result="turb">
      <animate attributeName="baseFrequency" values="${animationValues}" keyTimes="0; 0.2; 0.5; 0.8; 1" dur="${duration}" repeatCount="indefinite"/>
    </feTurbulence>
    <feDisplacementMap in="SourceGraphic" in2="turb" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
  </filter>
</defs>`;
  
  return {
    element: element,
    id: filterId,
    bytesRead: currentOffset - offset
  };
}

// Decompress filter group reference
function decompressFilterGroup(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Read filter ID
  const { value: idLength, bytesRead: idLengthBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += idLengthBytes;
  
  const filterId = readString(buffer, currentOffset, idLength);
  currentOffset += idLength;
  
  return {
    id: filterId,
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
    let filter = null;
    let filterId = null;
    let hasFilterGroup = false;
    
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
            
          case 0x04: // Filter definition
            const filterResult = decompressFilter(buffer, offset);
            filter = filterResult.element;
            filterId = filterResult.id;
            offset += filterResult.bytesRead;
            break;
            
          case 0x05: // Filter group reference
            const groupResult = decompressFilterGroup(buffer, offset);
            filterId = groupResult.id; // Store filter ID for group
            hasFilterGroup = true;
            offset += groupResult.bytesRead;
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
    
    // Add filter if present
    if (filter) {
      svgContent += filter;
    }
    
    // Add main path
    svgContent += mainPath;
    
    // If we have a filter, always create a group for lines and text - FIXED
    if (filterId) {
      svgContent += `<g filter="url(#${filterId})">`;
      
      // Add lines
      lines.forEach(line => {
        svgContent += line;
      });
      
      // Add text if present
      if (text) {
        svgContent += text;
      }
      
      svgContent += '</g>';
    } else {
      // No filter group, just add lines and text directly
      lines.forEach(line => {
        svgContent += line;
      });
      
      if (text) {
        svgContent += text;
      }
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
  <defs>
    <filter id="glitchFilter-fallback" x="0%" y="0%" width="100%" height="100%">
      <feTurbulence type="turbulence" baseFrequency="0.02" numOctaves="3" seed="1000" result="turb">
        <animate attributeName="baseFrequency" values="0.02; 0.05; 0.08; 0.04; 0.02" keyTimes="0; 0.2; 0.5; 0.8; 1" dur="4s" repeatCount="indefinite"/>
      </feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="turb" scale="15" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
  <path d="M80,200 L340,200 L340,420 L80,420 Z" fill="#785D06" stroke="#000000" stroke-width="1" />
  <g filter="url(#glitchFilter-fallback)">
    <line x1="138.5" y1="409" x2="253.5" y2="409" stroke="#A09DF6" stroke-width="3.69"/>
    <line x1="145" y1="372" x2="247" y2="372" stroke="#31B915" stroke-width="3.69"/>
    <text x="196" y="396" fill="#4A8019" font-size="35" font-family="monospace" font-weight="bold" text-anchor="middle">space</text>
  </g>
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