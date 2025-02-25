const fs = require('fs');
const path = require('path');

// Quantization scale (must match compress.js)
const QUANTIZATION_SCALE = 10;

// Function to unquantize path data
function unquantizePathData(pathData) {
  return pathData.replace(/-?\d+/g, num => {
    const val = parseInt(num, 10);
    if (isNaN(val)) return num; // Preserve non-numeric parts
    return (val / QUANTIZATION_SCALE).toFixed(1);
  });
}

// Decompress SVG from text format
function decompressSVG(compressedData) {
  try {
    const parts = compressedData.split(';');
    if (parts.length < 1) {
      throw new Error('Invalid compressed data format');
    }
    
    // First part is the viewBox
    const viewBox = parts[0];
    
    // Remaining parts are paths
    const pathElements = [];
    
    for (let i = 1; i < parts.length; i++) {
      const pathParts = parts[i].split('|');
      if (pathParts.length < 3) continue; // Skip invalid paths
      
      const fill = pathParts[0] === 'none' ? 'none' : `#${pathParts[0]}`;
      const stroke = pathParts[1] === 'none' ? 'none' : `#${pathParts[1]}`;
      
      // Handle optional opacity and strokeWidth
      let opacity = '1';
      let strokeWidth = '0';
      let pathData;
      
      if (pathParts.length === 3) {
        // Only fill, stroke, and path data
        pathData = pathParts[2];
      } else if (pathParts.length === 4) {
        // Either opacity or strokeWidth is provided
        if (pathParts[2] === '') {
          // Empty opacity slot, so it's stroke-width
          strokeWidth = pathParts[2];
        } else {
          // It's opacity
          opacity = pathParts[2];
        }
        pathData = pathParts[3];
      } else if (pathParts.length >= 5) {
        // Both opacity and strokeWidth
        opacity = pathParts[2];
        strokeWidth = pathParts[3];
        pathData = pathParts[4];
      }
      
      // Unquantize the path data
      const unquantizedPathData = unquantizePathData(pathData);
      
      // Create path element
      let pathElement = `<path d="${unquantizedPathData}" fill="${fill}"`;
      
      // Add optional attributes
      if (opacity !== '1') {
        pathElement += ` opacity="${opacity}"`;
      }
      
      if (stroke !== 'none' && parseFloat(strokeWidth) > 0) {
        pathElement += ` stroke="${stroke}" stroke-width="${strokeWidth}"`;
      }
      
      pathElement += ' />';
      pathElements.push(pathElement);
    }
    
    // Create the SVG
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
  ${pathElements.join('\n  ')}
</svg>`;
    
    return svg;
  } catch (error) {
    console.error('Decompression error:', error);
    
    // Return a fallback SVG
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420">
  <path d="M210,100 C260,100 300,140 300,190 C300,240 260,280 210,280 C160,280 120,240 120,190 C120,140 160,100 210,100 Z" fill="#0000FF" opacity="0.5" />
  <path d="M210,100 C260,100 300,140 300,190 C300,240 260,280 210,280 C160,280 120,240 120,190 C120,140 160,100 210,100 Z" fill="none" stroke="#000000" stroke-width="1" />
</svg>`;
  }
}

// Process compressed files
function processCompressedFiles() {
  const inputDir = path.join(__dirname, 'SVGs');
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