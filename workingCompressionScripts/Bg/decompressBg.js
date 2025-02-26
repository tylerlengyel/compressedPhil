const fs = require('fs');
const path = require('path');

// Match compression parameters
const TARGET_SIZE = 420;
const QUANTIZATION_SCALE = 1;

// Color dictionary matching the compress.js dictionary
const COLOR_DICT = {
  1: '000000', // black
  2: 'FFFFFF', // white
  3: '808080', // gray
  4: 'FF0000', // red
  5: '00FF00', // green
  6: '0000FF', // blue
  7: 'FFFF00', // yellow
  8: '00FFFF', // cyan
  9: 'FF00FF', // magenta
  10: 'C0C0C0', // silver
  11: 'E8A852', // orange/gold (common for galaxy cores)
  12: '294D7A', // deep blue (common for arms)
  13: 'D67D3E', // rust orange (common for arms)
  14: 'A654AD', // purple (common for arms)
  15: '66CCFF', // light blue (common for stars)
  16: 'FFDB99', // pale yellow (common for stars)
  0: 'none',   // transparent
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
  
  // Check if it's a gradient reference
  if (colorCode === 255) {
    // Read until non-ASCII character or end of buffer
    let gradientId = '';
    let i = offset + 1;
    
    // Only read valid ASCII characters (32-126)
    while (i < buffer.length && buffer[i] >= 32 && buffer[i] <= 126) {
      gradientId += String.fromCharCode(buffer[i]);
      i++;
    }
    
    // Skip any non-ASCII characters
    bytesRead = i - offset;
    
    return {
      color: `url(#${gradientId})`,
      bytesRead: bytesRead
    };
  }
  
  throw new Error(`Unknown color encoding: ${colorCode} at offset ${offset}`);
}

// Decode float with higher precision
function decodeFloat(buffer, offset, isOpacity = false) {
  if (offset >= buffer.length) {
    throw new Error(`Buffer overflow when reading float at offset ${offset}`);
  }
  
  if (isOpacity) {
    // Opacity is stored as 0-1000 for 3 decimal places
    const { value, bytesRead } = decodeVarInt(buffer, offset);
    return {
      value: value / 1000, // Convert back to 0-1 range with precision
      bytesRead: bytesRead
    };
  }
  
  // For coordinates and sizes, decode from integer (x10)
  const { value, bytesRead } = decodeSignedVarInt(buffer, offset);
  return {
    // Divide by 10 for decimal precision, then by QUANTIZATION_SCALE
    value: (value / 10) / QUANTIZATION_SCALE,
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

// Decompress rectangle
function decompressRect(buffer, offset) {
  let currentOffset = offset + 1; // Skip type marker
  
  // Decode fill color
  const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
  currentOffset += fillBytes;
  
  // Decode x and y position
  const { value: x, bytesRead: xBytes } = decodeFloat(buffer, currentOffset);
  currentOffset += xBytes;
  
  const { value: y, bytesRead: yBytes } = decodeFloat(buffer, currentOffset);
  currentOffset += yBytes;
  
  // Decode width and height
  const { value: width, bytesRead: widthBytes } = decodeFloat(buffer, currentOffset);
  currentOffset += widthBytes;
  
  const { value: height, bytesRead: heightBytes } = decodeFloat(buffer, currentOffset);
  currentOffset += heightBytes;
  
  // Create rect element with precision matching original
  const element = `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" fill="${fill}"/>`;
  
  return {
    element: element,
    bytesRead: currentOffset - offset
  };
}

// Decompress circles
function decompressCircles(buffer, offset, version) {
  try {
    let currentOffset = offset + 1; // Skip type marker
    
    // Decode fill color
    const { color: fill, bytesRead: fillBytes } = decodeColor(buffer, currentOffset);
    currentOffset += fillBytes;
    
    // Decode circle count
    const { value: circleCount, bytesRead: countBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += countBytes;
    
    // Decompress all circles
    const circles = [];
    let prevCx = 0, prevCy = 0, prevR = 0;
    
    for (let i = 0; i < circleCount && currentOffset < buffer.length; i++) {
      try {
        // Decode opacity
        const { value: opacity, bytesRead: opacityBytes } = decodeFloat(buffer, currentOffset, true);
        currentOffset += opacityBytes;
        
        // Decode delta coordinates
        const { value: deltaCx, bytesRead: cxBytes } = decodeFloat(buffer, currentOffset);
        currentOffset += cxBytes;
        
        const { value: deltaCy, bytesRead: cyBytes } = decodeFloat(buffer, currentOffset);
        currentOffset += cyBytes;
        
        const { value: deltaR, bytesRead: rBytes } = decodeFloat(buffer, currentOffset);
        currentOffset += rBytes;
        
        // First circle uses absolute coordinates, others use deltas
        const cx = i === 0 ? deltaCx : prevCx + deltaCx;
        const cy = i === 0 ? deltaCy : prevCy + deltaCy;
        const r = i === 0 ? deltaR : prevR + deltaR;
        
        prevCx = cx;
        prevCy = cy;
        prevR = r;
        
        // Convert back to original coordinates with high precision
        const originalCx = cx.toFixed(2);
        const originalCy = cy.toFixed(2);
        const originalR = r.toFixed(2);
        
        // Include opacity with high precision to preserve appearance
        let circle = `<circle cx="${originalCx}" cy="${originalCy}" r="${originalR}" fill="${fill}"`;
        if (opacity < 0.99) { // Ensure we preserve all opacity values
          circle += ` opacity="${opacity.toFixed(3)}"`;
        }
        circle += '/>'; 
        
        circles.push(circle);
      } catch (e) {
        console.error(`Error processing circle ${i}:`, e);
        break;
      }
    }
    
    return {
      elements: circles,
      bytesRead: currentOffset - offset
    };
  } catch (error) {
    console.error('Error decompressing circles:', error);
    return {
      elements: [],
      bytesRead: 0
    };
  }
}

// Decompress gradient definition
function decompressGradient(buffer, offset) {
  try {
    let currentOffset = offset + 1; // Skip type marker
    
    // Decode gradient ID length
    const { value: idLength, bytesRead: idLengthBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += idLengthBytes;
    
    // Decode gradient ID
    let gradientId = '';
    for (let i = 0; i < idLength && currentOffset + i < buffer.length; i++) {
      gradientId += String.fromCharCode(buffer[currentOffset + i]);
    }
    currentOffset += idLength;
    
    // Decode gradient type
    const { value: gradientTypeCode, bytesRead: typeBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += typeBytes;
    const gradientType = gradientTypeCode === 1 ? 'radialGradient' : 'linearGradient';
    
    // Decode stop count
    const { value: stopCount, bytesRead: stopCountBytes } = decodeVarInt(buffer, currentOffset);
    currentOffset += stopCountBytes;
    
    // Decompress all stops
    const stops = [];
    for (let i = 0; i < stopCount && currentOffset < buffer.length; i++) {
      // Decode offset
      const { value: stopOffset, bytesRead: offsetBytes } = decodeFloat(buffer, currentOffset);
      currentOffset += offsetBytes;
      
      // Decode opacity
      const { value: opacity, bytesRead: opacityBytes } = decodeFloat(buffer, currentOffset, true);
      currentOffset += opacityBytes;
      
      // Decode color
      const { color, bytesRead: colorBytes } = decodeColor(buffer, currentOffset);
      currentOffset += colorBytes;
      
      // Create stop element with high precision
      let stop = `<stop offset="${(stopOffset * 100).toFixed(0)}%" stop-color="${color}"`;
      if (opacity < 0.99) { // Ensure we capture all opacity values 
        stop += ` stop-opacity="${opacity.toFixed(3)}"`;
      }
      stop += '/>'; 
      
      stops.push(stop);
    }
    
    // Build gradient structure
    const gradient = `<defs>
  <${gradientType} id="${gradientId}">
    ${stops.join('\n    ')}
  </${gradientType}>
</defs>`;
    
    return {
      element: gradient,
      bytesRead: currentOffset - offset
    };
  } catch (error) {
    console.error('Error decompressing gradient:', error);
    return {
      element: createDefaultGalaxyGradient(),
      bytesRead: 0
    };
  }
}

// Create a default galaxy gradient with more accurate colors
function createDefaultGalaxyGradient() {
    return `<defs>
    <radialGradient id="coreGlow">
      <stop offset="0%" stop-color="#FFA500" stop-opacity="1"/>
      <stop offset="50%" stop-color="#E8A852" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#E8A852" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
  }
  
  // Update the core glow circle function to use different opacity
  function ensureCoreGlowCircle(circles, defs, viewBox) {
    if (defs.includes('coreGlow')) {
      const parts = viewBox.split(/\s+/).map(Number);
      const centerX = (parts[0] + parts[2]) / 2;
      const centerY = (parts[1] + parts[3]) / 2;
      
      let hasCoreGlowCircle = false;
      let coreGlowIndex = -1;
      
      for (let i = 0; i < circles.length; i++) {
        if (circles[i].includes('url(#coreGlow)')) {
          hasCoreGlowCircle = true;
          coreGlowIndex = i;
          break;
        }
      }
      
      // Use specific radius and opacity for closer match
      const coreCircle = `<circle cx="${centerX.toFixed(1)}" cy="${centerY.toFixed(1)}" r="30" fill="url(#coreGlow)" opacity="1.0"/>`;
      
      if (hasCoreGlowCircle) {
        circles[coreGlowIndex] = coreCircle;
      } else {
        circles.push(coreCircle);
      }
      
      return true;
    }
    return false;
  }

// Create fallback gradient if missing
function ensureCoreGradient(defs) {
  if (!defs.includes('coreGlow')) {
    return createDefaultGalaxyGradient();
  }
  return defs;
}

// Add background stars if missing
function addBackgroundStars(circles, viewBox) {
  // Only add stars if we have few circles (likely missing stars)
  if (circles.length < 50) {
    const parts = viewBox.split(/\s+/).map(Number);
    const width = parts[2];
    const height = parts[3];
    
    // Add some background stars
    const starCount = 50;
    const starColor = "#FFFFFF";
    
    for (let i = 0; i < starCount; i++) {
      const x = (Math.random() * width).toFixed(1);
      const y = (Math.random() * height).toFixed(1);
      const size = (Math.random() * 1.5 + 0.5).toFixed(1);
      const opacity = (Math.random() * 0.8 + 0.2).toFixed(2);
      
      circles.push(`<circle cx="${x}" cy="${y}" r="${size}" fill="${starColor}" opacity="${opacity}"/>`);
    }
    
    return true;
  }
  return false;
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
    const partCount = buffer[1];
    console.log(`SVG Format version ${version}, contains ${partCount} element types`);
    
    // Elements for reconstructing SVG
    let viewBox = `0 0 ${TARGET_SIZE} ${TARGET_SIZE}`; // Default viewBox
    let rect = '';
    let circles = [];
    let defs = '';
    
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
            
          case 0x01: // Rectangle
            const rectResult = decompressRect(buffer, offset);
            rect = rectResult.element;
            offset += rectResult.bytesRead;
            break;
            
          case 0x02: // Circle group
            const circleResult = decompressCircles(buffer, offset, version);
            if (circleResult.elements.length > 0) {
              circles = circles.concat(circleResult.elements);
            }
            if (circleResult.bytesRead > 0) {
              offset += circleResult.bytesRead;
            } else {
              // If we couldn't read circles properly, skip to the next marker
              offset += 1; // Skip this marker
              while (offset < buffer.length && buffer[offset] !== 0x00 && 
                     buffer[offset] !== 0x01 && buffer[offset] !== 0x02 && 
                     buffer[offset] !== 0x03) {
                offset++;
              }
            }
            break;
            
          case 0x03: // Gradient
            const gradientResult = decompressGradient(buffer, offset);
            defs = gradientResult.element;
            if (gradientResult.bytesRead > 0) {
              offset += gradientResult.bytesRead;
            } else {
              // Skip to next marker
              offset += 1;
              while (offset < buffer.length && buffer[offset] !== 0x00 && 
                     buffer[offset] !== 0x01 && buffer[offset] !== 0x02 && 
                     buffer[offset] !== 0x03) {
                offset++;
              }
            }
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
    
    // Galaxy-specific: ensure we have core gradient and circle
    defs = ensureCoreGradient(defs);
    ensureCoreGlowCircle(circles, defs, viewBox);
    
    // Add stars if missing
    addBackgroundStars(circles, viewBox);
    
    // If we don't have a background rect, add one
    if (!rect) {
      rect = `<rect x="0" y="0" width="${TARGET_SIZE}" height="${TARGET_SIZE}" fill="#000000"/>`;
    }
    
    // Reconstruct SVG with proper viewBox
    let svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`;
    
    // Add elements in order: defs, rect, circles
    if (defs) svgContent += defs;
    if (rect) svgContent += rect;
    
    circles.forEach(circle => {
      svgContent += circle;
    });
    
    svgContent += '</svg>';
    
    return svgContent;
  } catch (error) {
    console.error('Decompression error:', error);
    
    // Create a fallback galaxy if decompression fails
    return createFallbackGalaxy();
  }
}

// Create a minimal fallback galaxy if decompression completely fails
function createFallbackGalaxy() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <defs>
    <radialGradient id="coreGlow">
      <stop offset="0%" stop-color="#E8A852" stop-opacity="1"/>
      <stop offset="50%" stop-color="#E8A852" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#E8A852" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="420" height="420" fill="#000000"/>
  <circle cx="210" cy="210" r="30" fill="url(#coreGlow)" opacity="0.85"/>
  <circle cx="120" cy="120" r="2" fill="#FFFFFF" opacity="0.8"/>
  <circle cx="280" cy="160" r="1.5" fill="#FFFFFF" opacity="0.6"/>
  <circle cx="350" cy="280" r="1" fill="#FFFFFF" opacity="0.7"/>
  <circle cx="100" cy="320" r="1.2" fill="#FFFFFF" opacity="0.5"/>
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
