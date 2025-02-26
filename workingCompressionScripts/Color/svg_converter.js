const fs = require('fs');
const path = require('path');

/**
 * Simple Conversion Script
 * 
 * This script takes SVG files and converts them to a simple binary format.
 * The format is:
 * - 2 bytes header: version (0x01) and format type (0x01)
 * - 4 bytes size: uint32 length of the SVG string
 * - Remaining bytes: UTF-8 encoded SVG string
 */

// Process all SVGs in the input directory
function convertSVGsToBinary() {
  const inputDir = path.join(__dirname, 'SVGs');
  const outputDir = path.join(__dirname, 'compressed');
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
    console.log(`Created output directory: ${outputDir}`);
  }
  
  // Get all SVG files
  const svgFiles = fs.readdirSync(inputDir)
    .filter(file => file.endsWith('.svg'));
    
  console.log(`Found ${svgFiles.length} SVG files to process`);
  
  if (svgFiles.length === 0) {
    console.log("No SVG files found in input directory");
    return;
  }
  
  const results = {};
  
  // Process each file
  svgFiles.forEach(file => {
    try {
      console.log(`\nProcessing ${file}...`);
      
      const filePath = path.join(inputDir, file);
      const svgContent = fs.readFileSync(filePath, 'utf8');
      
      console.log(`Read ${svgContent.length} bytes of SVG data`);
      
      // Encode the SVG content
      const binaryData = encodeSVG(svgContent);
      const outputPath = path.join(outputDir, file.replace('.svg', '.bin'));
      
      fs.writeFileSync(outputPath, binaryData);
      console.log(`Wrote binary data to ${outputPath} (${binaryData.length} bytes)`);
      
      results[file] = {
        original: svgContent.length,
        compressed: binaryData.length,
        ratio: `${((svgContent.length - binaryData.length) / svgContent.length * 100).toFixed(2)}%`
      };
    } catch (error) {
      console.error(`Error processing ${file}: ${error.message}`);
      results[file] = {
        error: error.message
      };
    }
  });
  
  // Write summary
  const summaryPath = path.join(outputDir, 'conversion_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote conversion summary to ${summaryPath}`);
}

/**
 * Encode an SVG string to a simple binary format
 * @param {string} svgContent - The SVG content
 * @returns {string} - Base64 encoded binary data
 */
function encodeSVG(svgContent) {
  // Convert SVG to UTF-8 bytes
  const svgBytes = Buffer.from(svgContent, 'utf8');
  const svgLength = svgBytes.length;
  
  // Create header
  const header = Buffer.alloc(6);
  header[0] = 0x01; // Version
  header[1] = 0x01; // Format type
  header.writeUInt32BE(svgLength, 2); // 4-byte length field
  
  // Combine header and SVG content
  const binaryData = Buffer.concat([header, svgBytes]);
  
  // Return as base64 for easier storage
  return binaryData.toString('base64');
}

/**
 * Decode a binary format back to SVG string
 * @param {string} binaryData - Base64 encoded binary data
 * @returns {string} - The original SVG content
 */
function decodeSVG(binaryData) {
  // Convert from base64 to binary
  const buffer = Buffer.from(binaryData, 'base64');
  
  // Check header
  if (buffer.length < 6) {
    throw new Error("Invalid binary data: too short");
  }
  
  if (buffer[0] !== 0x01 || buffer[1] !== 0x01) {
    throw new Error(`Invalid format: Expected version 1, type 1, got version ${buffer[0]}, type ${buffer[1]}`);
  }
  
  // Get SVG length
  const svgLength = buffer.readUInt32BE(2);
  
  // Extract SVG content
  if (buffer.length < 6 + svgLength) {
    throw new Error(`Invalid binary data: expected ${svgLength} bytes of SVG content, but only ${buffer.length - 6} available`);
  }
  
  return buffer.slice(6, 6 + svgLength).toString('utf8');
}

// Add decompression function
function convertBinariesToSVGs() {
  const compressedDir = path.join(__dirname, 'compressed');
  const outputDir = path.join(__dirname, 'decompressed');
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
    console.log(`Created output directory: ${outputDir}`);
  }
  
  // Get all .bin files
  const binFiles = fs.readdirSync(compressedDir)
    .filter(file => file.endsWith('.bin'));
    
  console.log(`Found ${binFiles.length} .bin files to process`);
  
  if (binFiles.length === 0) {
    console.log("No .bin files found in compressed directory");
    return;
  }
  
  const results = {};
  
  // Process each file
  binFiles.forEach(file => {
    try {
      console.log(`\nProcessing ${file}...`);
      
      const filePath = path.join(compressedDir, file);
      const binaryData = fs.readFileSync(filePath, 'utf8');
      
      console.log(`Read ${binaryData.length} bytes of binary data`);
      
      // Decode the binary data
      const svgContent = decodeSVG(binaryData);
      const outputPath = path.join(outputDir, file.replace('.bin', '.svg'));
      
      fs.writeFileSync(outputPath, svgContent);
      console.log(`Wrote SVG to ${outputPath} (${svgContent.length} bytes)`);
      
      results[file] = {
        decompressed: true,
        size: svgContent.length
      };
    } catch (error) {
      console.error(`Error processing ${file}: ${error.message}`);
      results[file] = {
        decompressed: false,
        error: error.message
      };
    }
  });
  
  // Write summary
  const summaryPath = path.join(outputDir, 'decompression_summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nWrote decompression summary to ${summaryPath}`);
}

// Create scripts for both compression and decompression
function createScripts() {
  // Create compress.js
  const compressScript = `const converter = require('./svg_converter');
console.log('Starting SVG to Binary conversion...');
converter.convertSVGsToBinary();
console.log('Conversion complete!');`;

  // Create decompress.js
  const decompressScript = `const converter = require('./svg_converter');
console.log('Starting Binary to SVG conversion...');
converter.convertBinariesToSVGs();
console.log('Conversion complete!');`;

  // Write scripts to files
  fs.writeFileSync('compress.js', compressScript);
  console.log('Created compress.js');
  
  fs.writeFileSync('decompress.js', decompressScript);
  console.log('Created decompress.js');
}

// Export functions for use in separate scripts
module.exports = {
  convertSVGsToBinary,
  convertBinariesToSVGs
};

// If this script is run directly, create the wrapper scripts
if (require.main === module) {
  console.log('Creating SVG converter scripts...');
  createScripts();
  console.log('Done! You can now run "node compress.js" or "node decompress.js"');
}