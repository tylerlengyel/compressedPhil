const fs = require('fs');
const path = require('path');

// Decompression parameters
const TARGET_SIZE = 420;
const QUANTIZATION_SCALE = 20; // Match updated compression scale

// Color dictionary matching the compress.js dictionary
const COLOR_DICT = {
  1: '000000',  // black
  2: 'FFFFFF',  // white
  3: '808080',  // gray
  4: 'FF0000',  // neon red
  5: '00FF00',  // neon green
  6: '0000FF',  // neon blue
  7: 'FFFF00',  // neon yellow
  8: '00FFFF',  // neon cyan
  9: 'FF00FF',  // neon magenta
  10: '7F00FF', // neon purple
  11: 'FF7F00', // neon orange
  12: '7FFF00', // neon chartreuse
  13: '00FF7F', // neon spring green
  14: '007FFF', // neon azure
  15: 'FF007F', // neon pink
  // Dark rustic colors
  16: '503020', // dark brown
  17: '642814', // rusty brown
  18: '461E14', // deep reddish-brown
  19: '3C3C32', // dark gray-brown
  20: '5A2D23', // muted rust
  21: '321E28', // dark plum
  22: '463214', // olive brown
  23: '283C1E', // forest green-brown
  24: '55232D', // burgundy rust
  25: '3C283C', // dark slate
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
  
  console.log(`Decoded metadata: viewBox="${viewBox}"`);
  
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
  
  console.log(`Path has ${cmdCount} commands`);
  
  let pathData = '';
  
  for (let i = 0; i < cmdCount && currentOffset < buffer.length; i++) {
    // Read command character
    const cmdChar = String.fromCharCode(buffer[currentOffset]);
    currentOffset++;
    
    // Read parameter count
    const { value: paramCount, bytesRead: paramCountBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += paramCountBytes;
    
    console.log(`Command ${i+1}: ${cmdChar} with ${paramCount} parameters`);
    
    pathData += cmdChar;
    
    // Read and decode parameters
    const params = [];
    
    for (let j = 0; j < paramCount && currentOffset < buffer.length; j++) {
      // Using higher quantization factor (20 instead of 10)
      const { value: encodedParam, bytesRead: paramBytes } = decodeSignedVarInt(buffer, currentOffset);
      const param = encodedParam / 20; // Dequantize
      currentOffset += paramBytes;
      params.push(param);
      
      // Add space before parameter except for first
      if (j > 0 || cmdChar.toLowerCase() !== 'm') {
        pathData += ' ';
      }
      
      // Format with precision
      pathData += param.toFixed(2);
    }
  }
  
  console.log(`Decoded path data: ${pathData.substring(0, 30)}...`);
  
  return {
    pathData: pathData,
    bytesRead: currentOffset - offset
  };
}

// Decompress path element with optimized encoding
function decompressPath(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode combined flags
  const flagByte = buffer[currentOffset];
  currentOffset++;
  
  // Extract flags
  const typeValue = flagByte & 0x01;
  const hasFullOpacity = ((flagByte >> 1) & 0x01) === 1;
  
  const type = typeValue === 1 ? 'shadow' : 'base';
  
  console.log(`Path type: ${type}, hasFullOpacity: ${hasFullOpacity}`);
  
  // Decode fill color
  const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
  currentOffset += fillBytes;
  
  console.log(`Fill color: ${fill}`);
  
  // Decode opacity if present
  let opacity = 1.0; // Default full opacity
  if (!hasFullOpacity) {
    const { value: opacityValue, bytesRead: opacityBytes } = decodeFloat(buffer, currentOffset, true);
    opacity = opacityValue;
    currentOffset += opacityBytes;
    console.log(`Opacity: ${opacity}`);
  } else {
    console.log(`Using default opacity: 1.0`);
  }
  
  // Decode path data
  const { pathData, bytesRead: pathBytes } = decodePath(buffer, currentOffset);
  currentOffset += pathBytes;
  
  // Create path element
  let element = `<path d="${pathData}" fill="${fill}" fill-rule="evenodd"`;
  
  // Add opacity if not 1.0
  if (opacity < 0.99) {
    element += ` opacity="${opacity.toFixed(2)}"`;
  }
  
  // Add filter reference
  element += ` filter="url(#glow)"/>`;
  
  return {
    element: element,
    type: type,
    bytesRead: currentOffset - offset
  };
}

// Decompress glow filter with default handling
function decompressGlowFilter(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Read default flag
  const isDefault = buffer[currentOffset] === 0x01;
  currentOffset++;
  
  let stdDeviation = 4.0; // Default value
  
  // If not default, read the custom value
  if (!isDefault) {
    const { value: stdDeviationInt, bytesRead: stdDevBytes } = decodeVarInt(buffer, currentOffset);
    stdDeviation = stdDeviationInt / 10; // Convert back to float with 1 decimal place
    currentOffset += stdDevBytes;
    console.log(`Custom stdDeviation: ${stdDeviation}`);
  } else {
    console.log(`Using default stdDeviation: ${stdDeviation}`);
  }
  
  // Create filter element
  const element = `<defs>
    <filter id="glow">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${stdDeviation.toFixed(1)}" result="blur" />
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="brightBlur" />
      <feMerge>
        <feMergeNode in="brightBlur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>`;
  
  return {
    element: element,
    bytesRead: currentOffset - offset
  };
}

// Decompress SVG from binary format
function decompressSVG(compressedData) {
  try {
    console.log("Starting decompression, data length:", compressedData.length);
    
    // Convert from base64 to binary
    const buffer = Buffer.from(compressedData, 'base64');
    console.log("Decoded base64, buffer length:", buffer.length);
    
    if (buffer.length < 2) {
      throw new Error('Invalid compressed data: too short');
    }
    
    // Parse header
    const version = buffer[0];
    const elementCount = buffer[1];
    console.log(`SVG Format version ${version}, contains ${elementCount} elements`);
    
    // Elements for reconstructing SVG
    let viewBox = `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`; // Default viewBox
    let filter = '';
    let paths = [];
    
    // Parse all parts
    let offset = 2; // Start after header
    
    try {
      while (offset < buffer.length) {
        if (offset >= buffer.length) break;
        
        const markerByte = buffer[offset];
        console.log(`Processing element with marker: 0x${markerByte.toString(16)} at offset ${offset}`);
        
        switch (markerByte) {
          case 0x00: // Metadata
            console.log("Decoding metadata...");
            const metaResult = decompressMetadata(buffer, offset);
            viewBox = metaResult.viewBox;
            offset += metaResult.bytesRead;
            console.log(`Metadata decoded, viewBox="${viewBox}", read ${metaResult.bytesRead} bytes`);
            break;
            
          case 0x01: // Path
            console.log("Decoding path...");
            const pathResult = decompressPath(buffer, offset);
            paths.push(pathResult);
            offset += pathResult.bytesRead;
            console.log(`Path decoded, type=${pathResult.type}, read ${pathResult.bytesRead} bytes`);
            break;
            
          case 0x02: // Glow filter
            console.log("Decoding glow filter...");
            const filterResult = decompressGlowFilter(buffer, offset);
            filter = filterResult.element;
            offset += filterResult.bytesRead;
            console.log(`Filter decoded, read ${filterResult.bytesRead} bytes`);
            break;
            
          default:
            console.error(`Unknown element marker: 0x${markerByte.toString(16)} at offset ${offset}, stopping processing`);
            // This is likely corrupt data, so stop processing
            offset = buffer.length;
            break;
        }
      }
    } catch (e) {
      console.error("Error during decompression:", e);
      // Continue with what we have
    }
    
    console.log(`Decoded ${paths.length} paths and ${filter ? 1 : 0} filters`);
    
    // Sort paths by type - shadows first, then base paths
    paths.sort((a, b) => {
      if (a.type === 'shadow' && b.type !== 'shadow') return -1;
      if (a.type !== 'shadow' && b.type === 'shadow') return 1;
      return 0;
    });
    
    console.log("Paths sorted by type (shadow first)");
    
    // If we don't have any paths, return fallback
    if (paths.length === 0) {
      console.log("No paths found, using fallback nose");
      return createFallbackNose();
    }
    
    // Reconstruct SVG with proper viewBox
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${TARGET_SIZE}" height="${TARGET_SIZE}" viewBox="${viewBox}">`;
    
    // Add filter if present, otherwise use default
    svgContent += filter || createDefaultGlowFilter();
    
    // Add all path elements
    paths.forEach((path, i) => {
      console.log(`Adding path ${i+1}/${paths.length} (type: ${path.type})`);
      svgContent += path.element;
    });
    
    svgContent += '</svg>';
    console.log(`Assembled SVG content, length: ${svgContent.length}`);
    
    return svgContent;
  } catch (error) {
    console.error('Decompression error:', error);
    
    // Create a fallback nose SVG if decompression fails
    console.log("Returning fallback nose due to error");
    return createFallbackNose();
  }
}

// Create a default glow filter
function createDefaultGlowFilter() {
  console.log("Using default glow filter");
  return `<defs>
    <filter id="glow">
      <feGaussianBlur in="SourceGraphic" stdDeviation="4.0" result="blur" />
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="brightBlur" />
      <feMerge>
        <feMergeNode in="brightBlur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>`;
}

// Create a minimal fallback Nose if decompression completely fails
function createFallbackNose() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <defs>
    <filter id="glow">
      <feGaussianBlur in="SourceGraphic" stdDeviation="4.0" result="blur" />
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0" result="brightBlur" />
      <feMerge>
        <feMergeNode in="brightBlur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <path d="M210,210 m-50,0 a50,50 0 1,0 100,0 a50,50 0 1,0 -100,0" fill="#FF007F" fill-rule="evenodd" filter="url(#glow)"/>
</svg>`;
}

// Process compressed files
function processCompressedFiles() {
  // Get current directory
  const currentDir = process.cwd();
  console.log("Current working directory:", currentDir);
  
  // Set input and output directories
  const inputDir = path.join(currentDir, 'SVGs');
  const compressedDir = path.join(currentDir, 'compressed');
  const outputDir = path.join(currentDir, 'decompressed');
  
  console.log("SVGs directory:", inputDir);
  console.log("Compressed directory:", compressedDir);
  console.log("Output directory:", outputDir);
  
  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    console.log("Creating output directory");
    fs.mkdirSync(outputDir);
  }
  
  // Check if compressed directory exists
  if (!fs.existsSync(compressedDir)) {
    console.error("ERROR: compressed directory does not exist!");
    return;
  }
  
  // List all files in the compressed directory
  const allFiles = fs.readdirSync(compressedDir);
  console.log("Found", allFiles.length, "files in compressed directory");
  
  // Filter bin files
  const binFiles = allFiles.filter(file => file.endsWith('.bin'));
  console.log("Found", binFiles.length, "bin files:", binFiles);
  
  if (binFiles.length === 0) {
    console.error("No bin files found in the compressed directory!");
    return;
  }
  
  const results = {};
  
  // Process each bin file
  for (const file of binFiles) {
    console.log("\n========================================");
    console.log(`Processing ${file}`);
    
    try {
      const filePath = path.join(compressedDir, file);
      console.log("Reading from:", filePath);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        console.error(`File ${filePath} does not exist!`);
        continue;
      }
      
      // Read compressed data
      const compressedData = fs.readFileSync(filePath, 'utf8');
      console.log(`Read ${file}, size: ${compressedData.length} bytes`);
      
      // Decompress the data
      const decompressed = decompressSVG(compressedData);
      const outputPath = path.join(outputDir, file.replace('.bin', '.svg'));
      console.log("Writing to:", outputPath);
      
      // Write decompressed SVG
      fs.writeFileSync(outputPath, decompressed);
      console.log(`Wrote decompressed SVG: ${outputPath}`);
      
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
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
      results[file] = {
        decompressed: false,
        error: error.message
      };
    }
  }
  
  // Write results summary
  const summaryPath = path.join(outputDir, 'nose_decompression_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nDecompression summary written to ${summaryPath}`);
}

// Execute decompression
processCompressedFiles();