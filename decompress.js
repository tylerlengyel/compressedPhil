const fs = require('fs');
const path = require('path');

// Dictionary mappings - must match compression script
const COLOR_DICT = {
  1: '000000',   // black
  2: 'FFFFFF',   // white
  3: '808080',   // gray
  4: 'FF0000',   // red
  5: '00FF00',   // green
  6: '0000FF',   // blue
  7: 'FFFF00',   // yellow
  8: '00FFFF',   // cyan
  9: 'FF00FF',   // magenta
  10: 'C0C0C0',  // silver
  11: 'FFA500',  // orange
  12: '800000',  // maroon
  13: '008000',  // dark green
  14: '000080',  // navy
  15: '800080',  // purple
  16: '999999',  // medium gray
  17: '333333',  // dark gray
  18: 'CCCCCC',  // light gray
  0: 'none',     // transparent
};

// Command dictionary - inverse mapping from compression script
const CMD_DICT = {
  1: 'M',
  2: 'm', 
  3: 'L',
  4: 'l',
  5: 'H',
  6: 'h',
  7: 'V',
  8: 'v',
  9: 'C',
  10: 'c',
  11: 'S',
  12: 's',
  13: 'Q',
  14: 'q',
  15: 'T',
  16: 't',
  17: 'A',
  18: 'a',
  19: 'Z' // Both Z and z have the same code
};

// Quantization scale - must match compression
const QUANTIZATION_SCALE = 15;

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

// Decode color from the binary format
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

// Decode viewBox format
function decodeViewBox(buffer, offset) {
  if (offset >= buffer.length) {
    throw new Error(`Buffer overflow when reading viewBox format at offset ${offset}`);
  }
  
  const format = buffer[offset];
  let bytesRead = 1;
  let viewBox = '';
  
  switch (format) {
    case 0: // String format
      const { value: length, bytesRead: lengthBytes } = decodeVarInt(buffer, offset + bytesRead);
      bytesRead += lengthBytes;
      
      // Read the string
      viewBox = '';
      for (let i = 0; i < length && offset + bytesRead + i < buffer.length; i++) {
        viewBox += String.fromCharCode(buffer[offset + bytesRead + i]);
      }
      bytesRead += length;
      break;
      
    case 1: // Square viewBox at 0,0
      const { value: size, bytesRead: sizeBytes } = decodeVarInt(buffer, offset + bytesRead);
      bytesRead += sizeBytes;
      viewBox = `0 0 ${size} ${size}`;
      break;
      
    case 2: // Rectangle at 0,0
      const { value: width, bytesRead: widthBytes } = decodeVarInt(buffer, offset + bytesRead);
      bytesRead += widthBytes;
      
      const { value: height, bytesRead: heightBytes } = decodeVarInt(buffer, offset + bytesRead);
      bytesRead += heightBytes;
      
      viewBox = `0 0 ${width} ${height}`;
      break;
      
    case 3: // Full viewBox
      const { value: x, bytesRead: xBytes } = decodeSignedVarInt(buffer, offset + bytesRead);
      bytesRead += xBytes;
      
      const { value: y, bytesRead: yBytes } = decodeSignedVarInt(buffer, offset + bytesRead);
      bytesRead += yBytes;
      
      const { value: w, bytesRead: wBytes } = decodeVarInt(buffer, offset + bytesRead);
      bytesRead += wBytes;
      
      const { value: h, bytesRead: hBytes } = decodeVarInt(buffer, offset + bytesRead);
      bytesRead += hBytes;
      
      viewBox = `${x} ${y} ${w} ${h}`;
      break;
      
    default:
      throw new Error(`Unknown viewBox format: ${format}`);
  }
  
  return {
    viewBox,
    bytesRead
  };
}

// Decode path data from binary format with proper command handling
function decodePathData(buffer, offset, length) {
  if (offset + length > buffer.length) {
    throw new Error(`Buffer overflow when reading path data at offset ${offset}, length ${length}`);
  }
  
  let currentOffset = offset;
  const endOffset = offset + length;
  
  let pathData = '';
  let currentX = 0, currentY = 0;
  let currentCommand = '';
  
  // For coordinates tracking
  let isFirstCoordinate = true;
  let coordCount = 0;
  
  while (currentOffset < endOffset) {
    // Read a value
    const nextByte = buffer[currentOffset];
    
    // Check if it's a command
    if (nextByte >= 1 && nextByte <= 19 && CMD_DICT[nextByte]) {
      currentCommand = CMD_DICT[nextByte];
      pathData += currentCommand + ' ';
      currentOffset++;
      isFirstCoordinate = true;
      coordCount = 0;
      continue;
    }
    
    // It's a number - read using zigzag encoding
    const { value: encodedNum, bytesRead } = decodeSignedVarInt(buffer, currentOffset);
    currentOffset += bytesRead;
    
    // Dequantize the value
    const decodedNum = encodedNum / QUANTIZATION_SCALE;
    
    // Check command type for coordinate handling
    const isRelative = currentCommand === currentCommand.toLowerCase() && 
                       currentCommand !== 'z' && currentCommand !== 'Z';
    
    if (isRelative) {
      // For relative commands, use value directly
      pathData += decodedNum.toFixed(2) + ' ';
      
      // Track absolute position
      if (coordCount % 2 === 0) { // X coordinate
        currentX += decodedNum;
      } else { // Y coordinate
        currentY += decodedNum;
      }
    } else if (currentCommand === 'H') {
      // Horizontal line absolute - delta encoded
      const absX = currentX + decodedNum;
      pathData += absX.toFixed(2) + ' ';
      currentX = absX;
    } else if (currentCommand === 'V') {
      // Vertical line absolute - delta encoded
      const absY = currentY + decodedNum;
      pathData += absY.toFixed(2) + ' ';
      currentY = absY;
    } else if (currentCommand !== 'Z' && currentCommand !== 'z') {
      // Absolute command with alternating x,y values
      if (coordCount % 2 === 0) { // X coordinate
        const absX = isFirstCoordinate ? decodedNum : currentX + decodedNum;
        pathData += absX.toFixed(2) + ' ';
        currentX = absX;
      } else { // Y coordinate
        const absY = isFirstCoordinate ? decodedNum : currentY + decodedNum;
        pathData += absY.toFixed(2) + ' ';
        currentY = absY;
      }
    } else {
      // Z command doesn't have coordinates, but handle any values
      pathData += decodedNum.toFixed(2) + ' ';
    }
    
    coordCount++;
    if (coordCount === 2) {
      isFirstCoordinate = false;
    }
  }
  
  return pathData.trim();
}

// Decompress SVG from the binary format
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
    console.log(`SVG Format version ${version}, contains ${pathCount} paths`);
    
    // Start parsing at offset 2 (after header)
    let currentOffset = 2;
    
    // Parse viewBox
    const { viewBox, bytesRead: viewBoxBytes } = decodeViewBox(buffer, currentOffset);
    currentOffset += viewBoxBytes;
    
    // Parse paths
    const paths = [];
    
    for (let i = 0; i < pathCount && currentOffset < buffer.length; i++) {
      try {
        // Read colors
        const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
        currentOffset += fillBytes;
        
        const { color: stroke, bytesRead: strokeBytes } = decodeColor(buffer, currentOffset);
        currentOffset += strokeBytes;
        
        // Read flags
        const flags = buffer[currentOffset++];
        const hasOpacity = (flags & 1) > 0;
        const hasStrokeWidth = (flags & 2) > 0;
        
        // Read optional parameters
        let opacity = 1;
        let strokeWidth = 0;
        
        if (hasOpacity) {
          const { value: opacityValue, bytesRead: opacityBytes } = decodeVarInt(buffer, currentOffset);
          currentOffset += opacityBytes;
          opacity = opacityValue / 100; // Convert back to 0-1 range
        }
        
        if (hasStrokeWidth) {
          const { value: strokeWidthValue, bytesRead: strokeWidthBytes } = decodeVarInt(buffer, currentOffset);
          currentOffset += strokeWidthBytes;
          strokeWidth = strokeWidthValue / 10; // Convert back with 1 decimal precision
        }
        
        // Read path data length
        const { value: pathDataLength, bytesRead: lengthBytes } = decodeVarInt(buffer, currentOffset);
        currentOffset += lengthBytes;
        
        // Decode path data
        const pathData = decodePathData(buffer, currentOffset, pathDataLength);
        currentOffset += pathDataLength;
        
        // Create path element
        let pathElement = `<path d="${pathData}" fill="${fill}"`;
        
        if (stroke !== 'none') {
          pathElement += ` stroke="${stroke}"`;
          
          if (strokeWidth > 0) {
            pathElement += ` stroke-width="${strokeWidth.toFixed(1)}"`;
          }
        }
        
        if (opacity < 1) {
          pathElement += ` opacity="${opacity.toFixed(2)}"`;
        }
        
        pathElement += `/>`;
        paths.push(pathElement);
        
      } catch (error) {
        console.error(`Error decoding path ${i}:`, error);
        break;
      }
    }
    
    // Construct the final SVG
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
  ${paths.join('\n  ')}
</svg>`;
    
    return svgContent;
    
  } catch (error) {
    console.error('Decompression error:', error);
    
    // Return a minimal fallback SVG
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M10 10L90 90M10 90L90 10" stroke="#FF0000" stroke-width="5" fill="none"/>
  <circle cx="50" cy="50" r="40" stroke="#000000" fill="none"/>
</svg>`;
  }
}

// Process compressed files
function processCompressedFiles() {
  const compressedDir = path.join(__dirname, 'compressed');
  const outputDir = path.join(__dirname, 'decompressed');
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }
  
  const results = {};
  
  fs.readdirSync(compressedDir).forEach(file => {
    if (file.endsWith('.bin')) {
      try {
        const filePath = path.join(compressedDir, file);
        const compressedData = fs.readFileSync(filePath, 'utf8');
        
        console.log(`Processing ${file}, compressed size: ${compressedData.length} bytes`);
        
        const decompressed = decompressSVG(compressedData);
        const outputPath = path.join(outputDir, file.replace('.bin', '.svg'));
        
        fs.writeFileSync(outputPath, decompressed);
        console.log(`Decompressed ${file} to ${outputPath}`);
        
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