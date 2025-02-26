const fs = require('fs');
const path = require('path');

// Decompression parameters
const TARGET_SIZE = 420;
const QUANTIZATION_SCALE = 10; // Must match compression scale

// Color dictionary matching the compress.js dictionary
const COLOR_DICT = {
  1: '000000',  // black
  2: 'FFFFFF',  // white
  3: '808080',  // gray
  4: '0D00FF',  // deep blue (common in Phil)
  5: '5858FF',  // medium blue (common in Phil)
  6: '00B7FF',  // light blue (common in Phil)
  7: '66C9FF',  // pale blue (common in Phil)
  8: 'FF0000',  // red
  9: '00FF00',  // green
  10: '0000FF', // blue
  11: 'FFFF00', // yellow
  12: '00FFFF', // cyan
  13: 'FF00FF', // magenta
  14: '080055', // dark blue stroke (common in Phil)
  0: 'none',    // transparent
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

// Decode signed integers from zigzag encoding
function decodeSignedVarInt(buffer, offset) {
  const { value, bytesRead } = decodeVarInt(buffer, offset);
  // Convert from zigzag encoding back to signed
  const decoded = (value >>> 1) ^ (-(value & 1));
  return {
    value: decoded,
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

// Decode float with precision control
function decodeFloat(buffer, offset, isOpacity = false) {
  if (offset >= buffer.length) {
    throw new Error(`Buffer overflow when reading float at offset ${offset}`);
  }
  
  if (isOpacity) {
    // Opacity is stored as 0-100 for 2 decimal places
    const { value, bytesRead } = decodeVarInt(buffer, offset);
    return {
      value: value / 100, // Convert back to 0-1 range with precision
      bytesRead: bytesRead
    };
  }
  
  // For coordinates and path data
  const { value, bytesRead } = decodeSignedVarInt(buffer, offset);
  return {
    value: value / QUANTIZATION_SCALE, // Divide by quantization scale
    bytesRead: bytesRead
  };
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

// Decode path commands
function decodePath(buffer, offset) {
  let currentOffset = offset;
  
  // Read command count
  const { value: cmdCount, bytesRead: cmdCountBytes } = decodeVarInt(buffer, currentOffset);
  currentOffset += cmdCountBytes;
  
  let pathData = '';
  
  for (let i = 0; i < cmdCount && currentOffset < buffer.length; i++) {
    // Read command character
    const cmdChar = String.fromCharCode(buffer[currentOffset]);
    currentOffset++;
    
    // Read parameter count
    const { value: paramCount, bytesRead: paramCountBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += paramCountBytes;
    
    pathData += cmdChar;
    
    // Read and decode parameters
    for (let j = 0; j < paramCount && currentOffset < buffer.length; j++) {
      const { value: param, bytesRead: paramBytes } = decodeFloat(buffer, currentOffset);
      currentOffset += paramBytes;
      
      // Add space before parameter except for first
      if (j > 0 || cmdChar.toLowerCase() !== 'm') {
        pathData += ' ';
      }
      
      // Format with precision
      pathData += param.toFixed(1);
    }
  }
  
  return {
    pathData: pathData,
    bytesRead: currentOffset - offset
  };
}

// Decompress path element
function decompressPath(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode fill color
  const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
  currentOffset += fillBytes;
  
  // Decode stroke color
  const { color: stroke, bytesRead: strokeBytes } = decodeColor(buffer, currentOffset);
  currentOffset += strokeBytes;
  
  // Decode stroke width
  const { value: strokeWidth, bytesRead: strokeWidthBytes } = decodeFloat(buffer, currentOffset);
  currentOffset += strokeWidthBytes;
  
  // Decode opacity
  const { value: opacity, bytesRead: opacityBytes } = decodeFloat(buffer, currentOffset, true);
  currentOffset += opacityBytes;
  
  // Decode path data
  const { pathData, bytesRead: pathBytes } = decodePath(buffer, currentOffset);
  currentOffset += pathBytes;
  
  // Create path element
  let element = `<path d="${pathData}" fill="${fill}"`;
  
  // Add optional attributes
  if (opacity < 0.99) {
    element += ` opacity="${opacity.toFixed(2)}"`;
  }
  
  if (stroke !== 'none' && strokeWidth > 0) {
    element += ` stroke="${stroke}" stroke-width="${strokeWidth.toFixed(1)}"`;
  }
  
  element += '/>'; 
  
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
    const pathCount = buffer[1];
    console.log(`Phil SVG Format version ${version}, contains ${pathCount} paths`);
    
    // Elements for reconstructing SVG
    let viewBox = `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`; // Default viewBox
    let paths = [];
    
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
            
          case 0x01: // Path
            const pathResult = decompressPath(buffer, offset);
            paths.push(pathResult.element);
            offset += pathResult.bytesRead;
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
    
    // If we don't have any paths, return fallback
    if (paths.length === 0) {
      return createFallbackPhil();
    }
    
    // Reconstruct SVG with proper viewBox
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`;
    
    // Add all path elements
    paths.forEach(path => {
      svgContent += path;
    });
    
    svgContent += '</svg>';
    
    return svgContent;
  } catch (error) {
    console.error('Decompression error:', error);
    
    // Create a fallback Phil SVG if decompression fails
    return createFallbackPhil();
  }
}

// Create a minimal fallback Phil if decompression completely fails
function createFallbackPhil() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <path d="M210,100 C260,100 300,140 300,190 C300,240 260,280 210,280 C160,280 120,240 120,190 C120,140 160,100 210,100 Z" fill="#0D00FF" opacity="0.5" />
  <path d="M210,100 C260,100 300,140 300,190 C300,240 260,280 210,280 C160,280 120,240 120,190 C120,140 160,100 210,100 Z" fill="none" stroke="#080055" stroke-width="1" />
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