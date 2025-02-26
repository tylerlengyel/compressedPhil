const fs = require('fs');
const path = require('path');
const { optimize } = require('svgo');

// SVGO configuration with minimal optimization to preserve path data
const svgoConfig = {
  plugins: [
    { name: 'removeDoctype', active: true },
    { name: 'removeComments', active: true },
    { name: 'cleanupAttrs', active: true },
    { name: 'convertColors', active: false }, // Don't convert colors
    { name: 'removeUselessStrokeAndFill', active: true },
    { name: 'cleanupNumericValues', params: { floatPrecision: 2 } }, // Keep more decimals
    { name: 'convertPathData', active: false }, // Don't modify path data
    { name: 'removeEmptyAttrs', active: true },
    { name: 'collapseGroups', active: true }
  ],
};

// Store common colors in a dictionary
const COLOR_DICT = {
  '000000': 1,   // black
  'FFFFFF': 2,   // white
  'FF0000': 3,   // red
  '00FF00': 4,   // green
  '0000FF': 5,   // blue
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

// Encode color efficiently
function encodeColor(color) {
  if (!color || color === 'none') return Buffer.from([0]);
  
  // Handle gradient references
  if (color.startsWith('url(#')) {
    const gradientId = color.match(/#([^"'\s)]*)/)[1];
    return Buffer.concat([
      Buffer.from([255]), // Gradient marker
      encodeVarInt(gradientId.length),
      Buffer.from(gradientId)
    ]);
  }
  
  // Normalize color format
  let hex = color;
  if (color.startsWith('#')) {
    hex = color.slice(1).toUpperCase();
  }
  
  // Use dictionary value if available
  if (COLOR_DICT[hex]) {
    return Buffer.from([COLOR_DICT[hex]]);
  }
  
  // Otherwise encode as RGB bytes
  try {
    return Buffer.from([
      254, // Full color marker
      parseInt(hex.substring(0, 2), 16),
      parseInt(hex.substring(2, 4), 16),
      parseInt(hex.substring(4, 6), 16)
    ]);
  } catch (error) {
    console.error('Error encoding color:', color, error);
    return Buffer.from([1]); // Default to black
  }
}

// Compress path
function compressPath(pathElement) {
  try {
    // Extract attributes
    const dMatch = pathElement.match(/d="([^"]*)"/);
    const fillMatch = pathElement.match(/fill="([^"]*)"/);
    const strokeMatch = pathElement.match(/stroke="([^"]*)"/);
    const strokeWidthMatch = pathElement.match(/stroke-width="([^"]*)"/);
    
    if (!dMatch) return null;
    
    const d = dMatch[1];
    const fill = fillMatch ? fillMatch[1] : 'none';
    const stroke = strokeMatch ? strokeMatch[1] : 'none';
    const strokeWidth = strokeWidthMatch ? parseFloat(strokeWidthMatch[1]) : 0;
    
    // Store path data directly as string
    const pathData = Buffer.from(d);
    
    return Buffer.concat([
      Buffer.from([0x01]), // Path marker
      encodeColor(fill),
      encodeColor(stroke),
      encodeVarInt(strokeWidth * 10), // Store stroke width * 10 for precision
      encodeVarInt(pathData.length),
      pathData
    ]);
  } catch (error) {
    console.error('Error compressing path:', error);
    return null;
  }
}

// Compress gradient
function compressGradient(gradientElement) {
  try {
    // Extract gradient ID
    const idMatch = gradientElement.match(/id="([^"]*)"/);
    if (!idMatch) return null;
    
    const id = idMatch[1];
    
    // Extract positions
    const x1Match = gradientElement.match(/x1="([^"]*)"/);
    const y1Match = gradientElement.match(/y1="([^"]*)"/);
    const x2Match = gradientElement.match(/x2="([^"]*)"/);
    const y2Match = gradientElement.match(/y2="([^"]*)"/);
    
    const x1 = x1Match ? x1Match[1].replace('%', '') : '0';
    const y1 = y1Match ? y1Match[1].replace('%', '') : '0';
    const x2 = x2Match ? x2Match[1].replace('%', '') : '100';
    const y2 = y2Match ? y2Match[1].replace('%', '') : '0';
    
    // Extract stops
    const stops = [];
    const stopMatches = gradientElement.match(/<stop[^>]*>/g) || [];
    
    for (const stopElement of stopMatches) {
      const offsetMatch = stopElement.match(/offset="([^"]*)"/);
      const colorMatch = stopElement.match(/stop-color="([^"]*)"/);
      
      if (offsetMatch && colorMatch) {
        const offset = offsetMatch[1].replace('%', '');
        const color = colorMatch[1];
        
        stops.push({
          offset,
          color
        });
      }
    }
    
    // Encode gradient data
    const result = [
      Buffer.from([0x02]), // Gradient marker
      encodeVarInt(id.length),
      Buffer.from(id),
      encodeVarInt(parseInt(x1) || 0),
      encodeVarInt(parseInt(y1) || 0),
      encodeVarInt(parseInt(x2) || 100),
      encodeVarInt(parseInt(y2) || 0),
      encodeVarInt(stops.length)
    ];
    
    // Encode each stop
    for (const stop of stops) {
      result.push(encodeVarInt(parseInt(stop.offset) || 0));
      result.push(encodeColor(stop.color));
    }
    
    return Buffer.concat(result);
  } catch (error) {
    console.error('Error compressing gradient:', error);
    return null;
  }
}

// Compress SVG to binary format
function compressSVG(svgString) {
  try {
    // Optimize with SVGO
    const optimized = optimize(svgString, svgoConfig).data;
    
    // Extract viewBox
    const viewBoxMatch = optimized.match(/viewBox="([^"]*)"/);
    const viewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 420 420';
    
    // Extract elements
    const pathMatches = optimized.match(/<path[^>]*\/>/g) || [];
    const gradientMatches = optimized.match(/<linearGradient[^>]*>[\s\S]*?<\/linearGradient>/g) || [];
    
    const elements = [];
    
    // Add viewBox
    const viewBoxBuffer = Buffer.from(viewBox);
    elements.push(Buffer.concat([
      Buffer.from([0x00]), // ViewBox marker
      encodeVarInt(viewBoxBuffer.length),
      viewBoxBuffer
    ]));
    
    // Add gradients
    for (const gradient of gradientMatches) {
      const compressedGradient = compressGradient(gradient);
      if (compressedGradient) {
        elements.push(compressedGradient);
      }
    }
    
    // Add paths
    for (const path of pathMatches) {
      const compressedPath = compressPath(path);
      if (compressedPath) {
        elements.push(compressedPath);
      }
    }
    
    // Combine elements
    const elementCount = elements.length - 1; // Don't count viewBox
    const header = Buffer.from([0x03, elementCount]); // Version 3, element count
    
    const fullBuffer = Buffer.concat([header, ...elements]);
    
    // Convert to base64
    return fullBuffer.toString('base64');
  } catch (error) {
    console.error('Error compressing SVG:', error);
    throw error;
  }
}

// Process SVGs in directory
function processSVGs() {
  const inputDir = path.join(__dirname, 'SVGs');
  const outputDir = path.join(__dirname, 'compressed');
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }
  
  const results = {};
  
  fs.readdirSync(inputDir).forEach(file => {
    if (file.endsWith('.svg') && file.toLowerCase().includes('spikes')) {
      try {
        const filePath = path.join(inputDir, file);
        const svgContent = fs.readFileSync(filePath, 'utf8');
        
        const compressed = compressSVG(svgContent);
        const outputPath = path.join(outputDir, `${file.replace('.svg', '.bin')}`);
        
        fs.writeFileSync(outputPath, compressed);
        
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
        console.error(`Error processing ${file}:`, error);
      }
    }
  });
  
  fs.writeFileSync(
    path.join(outputDir, 'spikes_compression_summary.json'),
    JSON.stringify(results, null, 2)
  );
  
  console.log('\nCompression summary written to spikes_compression_summary.json');
}

// Execute compression
processSVGs();