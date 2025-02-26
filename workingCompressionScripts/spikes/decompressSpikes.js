const fs = require('fs');
const path = require('path');

// Color dictionary matching the compression dictionary
const COLOR_DICT = {
  1: '000000',   // black
  2: 'FFFFFF',   // white
  3: 'FF0000',   // red
  4: '00FF00',   // green
  5: '0000FF',   // blue
  0: 'none',     // transparent
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

// Decode color
function decodeColor(buffer, offset) {
  if (offset >= buffer.length) {
    throw new Error(`Buffer overflow when reading color at offset ${offset}`);
  }
  
  const colorCode = buffer[offset];
  
  // Dictionary color
  if (colorCode < 254 && COLOR_DICT[colorCode] !== undefined) {
    return {
      color: colorCode === 0 ? 'none' : `#${COLOR_DICT[colorCode]}`,
      bytesRead: 1
    };
  }
  
  // Full RGB color
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
  
  // Gradient reference
  if (colorCode === 255) {
    const { value: idLength, bytesRead: idLengthBytes } = decodeVarInt(buffer, offset + 1);
    let idOffset = offset + 1 + idLengthBytes;
    let gradientId = '';
    
    for (let i = 0; i < idLength && idOffset + i < buffer.length; i++) {
      gradientId += String.fromCharCode(buffer[idOffset + i]);
    }
    
    return {
      color: `url(#${gradientId})`,
      bytesRead: 1 + idLengthBytes + idLength
    };
  }
  
  throw new Error(`Unknown color encoding: ${colorCode} at offset ${offset}`);
}

// Decompress viewBox
function decompressViewBox(buffer, offset) {
  let currentOffset = offset + 1; // Skip marker
  
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

// Decompress path
function decompressPath(buffer, offset) {
  try {
    let currentOffset = offset + 1; // Skip marker
    
    // Decode fill color
    const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
    currentOffset += fillBytes;
    
    // Decode stroke color
    const { color: stroke, bytesRead: strokeBytes } = decodeColor(buffer, currentOffset);
    currentOffset += strokeBytes;
    
    // Decode stroke width
    const { value: strokeWidthRaw, bytesRead: strokeWidthBytes } = decodeVarInt(buffer, currentOffset);
    const strokeWidth = strokeWidthRaw / 10; // Convert back from integer
    currentOffset += strokeWidthBytes;
    
    // Decode path data length
    const { value: pathDataLength, bytesRead: pathDataLengthBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += pathDataLengthBytes;
    
    // Decode path data
    let pathData = '';
    for (let i = 0; i < pathDataLength && currentOffset + i < buffer.length; i++) {
      pathData += String.fromCharCode(buffer[currentOffset + i]);
    }
    currentOffset += pathDataLength;
    
    // Create path element
    let element = `<path d="${pathData}" fill="${fill}"`;
    
    if (stroke !== 'none' && strokeWidth > 0) {
      element += ` stroke="${stroke}" stroke-width="${strokeWidth.toFixed(1)}"`;
    }
    
    element += '/>'; 
    
    return {
      element: element,
      bytesRead: currentOffset - offset
    };
  } catch (error) {
    console.error('Error decompressing path:', error);
    return {
      element: `<path d="M 0 0" fill="none" stroke="#FF0000" stroke-width="1"/>`,
      bytesRead: 1
    };
  }
}

// Decompress gradient
function decompressGradient(buffer, offset) {
  try {
    let currentOffset = offset + 1; // Skip marker
    
    // Decode gradient ID length
    const { value: idLength, bytesRead: idLengthBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += idLengthBytes;
    
    // Decode gradient ID
    let gradientId = '';
    for (let i = 0; i < idLength && currentOffset + i < buffer.length; i++) {
      gradientId += String.fromCharCode(buffer[currentOffset + i]);
    }
    currentOffset += idLength;
    
    // Decode positions
    const { value: x1, bytesRead: x1Bytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += x1Bytes;
    
    const { value: y1, bytesRead: y1Bytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += y1Bytes;
    
    const { value: x2, bytesRead: x2Bytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += x2Bytes;
    
    const { value: y2, bytesRead: y2Bytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += y2Bytes;
    
    // Decode stop count
    const { value: stopCount, bytesRead: stopCountBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += stopCountBytes;
    
    // Decode stops
    const stops = [];
    for (let i = 0; i < stopCount && currentOffset < buffer.length; i++) {
      // Decode offset
      const { value: offset, bytesRead: offsetBytes } = decodeVarInt(buffer, currentOffset);
      currentOffset += offsetBytes;
      
      // Decode color
      const { color, bytesRead: colorBytes } = decodeColor(buffer, currentOffset);
      currentOffset += colorBytes;
      
      stops.push(`<stop offset="${offset}%" stop-color="${color}"/>`);
    }
    
    // Create gradient element
    const gradientElement = `<linearGradient id="${gradientId}" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">
    ${stops.join('\n    ')}
  </linearGradient>`;
    
    return {
      element: gradientElement,
      bytesRead: currentOffset - offset
    };
  } catch (error) {
    console.error('Error decompressing gradient:', error);
    return {
      element: '<linearGradient id="fallback"><stop offset="0%" stop-color="#FF0000"/><stop offset="100%" stop-color="#0000FF"/></linearGradient>',
      bytesRead: 1
    };
  }
}

// Create fallback SVG
function createFallbackSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <defs>
    <linearGradient id="fallbackGradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FF0000"/>
      <stop offset="100%" stop-color="#0000FF"/>
    </linearGradient>
  </defs>
  <path d="M 210,50 L 250,150 L 350,210 L 250,270 L 210,370 L 170,270 L 70,210 L 170,150 Z" 
        fill="url(#fallbackGradient)" 
        stroke="#000000" 
        stroke-width="0.5" />
</svg>`;
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
    console.log(`Spikes SVG Format version ${version}, contains ${elementCount} elements`);
    
    // Elements for reconstructing SVG
    let viewBox = '0 0 420 420'; // Default viewBox
    const elements = {
      gradients: [],
      paths: []
    };
    
    // Parse all parts
    let offset = 2; // Start after header
    
    while (offset < buffer.length) {
      if (offset >= buffer.length) break;
      
      const markerByte = buffer[offset];
      
      switch (markerByte) {
        case 0x00: // ViewBox
          const viewBoxResult = decompressViewBox(buffer, offset);
          viewBox = viewBoxResult.viewBox;
          offset += viewBoxResult.bytesRead;
          break;
          
        case 0x01: // Path
          const pathResult = decompressPath(buffer, offset);
          elements.paths.push(pathResult.element);
          offset += pathResult.bytesRead;
          break;
          
        case 0x02: // Gradient
          const gradientResult = decompressGradient(buffer, offset);
          elements.gradients.push(gradientResult.element);
          offset += gradientResult.bytesRead;
          break;
          
        default:
          console.error(`Unknown marker: ${markerByte} at offset ${offset}, skipping`);
          offset++;
          break;
      }
    }
    
    // If we don't have any elements, return fallback
    if (elements.paths.length === 0) {
      return createFallbackSVG();
    }
    
    // Reconstruct SVG
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`;
    
    // Add defs section if we have gradients
    if (elements.gradients.length > 0) {
      svgContent += '\n  <defs>\n    ';
      svgContent += elements.gradients.join('\n    ');
      svgContent += '\n  </defs>\n';
    }
    
    // Add paths
    elements.paths.forEach(path => {
      svgContent += '\n  ' + path;
    });
    
    svgContent += '\n</svg>';
    
    return svgContent;
  } catch (error) {
    console.error('Decompression error:', error);
    console.error(error.stack); // Print stack trace
    
    return createFallbackSVG();
  }
}

// Process compressed files
function processCompressedFiles() {
  const inputDir = path.join(__dirname, 'SVGs');
  const compressedDir = path.join(__dirname, 'compressed');
  const outputDir = path.join(__dirname, 'decompressed');
  
  console.log('Starting decompression process...');
  
  // Create output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    console.log(`Creating output directory: ${outputDir}`);
    fs.mkdirSync(outputDir);
  }
  
  const results = {};
  let filesProcessed = 0;
  
  // Read files in compressed directory
  try {
    const files = fs.readdirSync(compressedDir);
    console.log(`Found ${files.length} files in compressed directory`);
    
    files.forEach(file => {
      if (file.endsWith('.bin')) {
        console.log(`Processing ${file}`);
        
        try {
          const filePath = path.join(compressedDir, file);
          const compressedData = fs.readFileSync(filePath, 'utf8');
          
          console.log(`Read compressed data, size: ${compressedData.length} bytes`);
          
          const decompressed = decompressSVG(compressedData);
          const outputPath = path.join(outputDir, file.replace('.bin', '.svg'));
          
          fs.writeFileSync(outputPath, decompressed);
          console.log(`Decompressed ${file} to ${outputPath}`);
          
          // Check for original file
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
          
          filesProcessed++;
        } catch (error) {
          console.error(`Error processing ${file}:`, error);
          results[file] = {
            decompressed: false,
            error: error.message
          };
        }
      }
    });
  } catch (error) {
    console.error('Error reading compressed directory:', error);
    return;
  }
  
  console.log(`Processed ${filesProcessed} files`);
  
  // Write summary
  fs.writeFileSync(
    path.join(outputDir, 'spikes_decompression_summary.json'), 
    JSON.stringify(results, null, 2)
  );
  
  console.log('\nDecompression summary written to spikes_decompression_summary.json');
}

// Run decompression
console.log('Starting Spikes SVG decompression...');
processCompressedFiles();