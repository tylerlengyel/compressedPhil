const fs = require('fs');
const path = require('path');

// Quantization scale (must match compression)
const QUANTIZATION_SCALE = 10;

function isValidHex(hex) {
  return /^[0-9A-F]{6}$/i.test(hex); // Check if it's a 6-digit hex (case-insensitive)
}

function decompressSVG(compressedString) {
  const elements = compressedString.split(';');
  let svg = '<svg viewBox="0 0 420 420">';
  svg += `<g transform="scale(${1 / QUANTIZATION_SCALE})">`;
  let defs = '';

  elements.forEach(element => {
    if (!element) return;
    const [type, ...rest] = element.split('|');
    console.log('Processing element:', type, rest); // Debug: Log each element and its rest
    if (type === 'r') {
      const [fill, dims] = rest;
      const [width, height] = dims.split(',').map(Number);
      svg += `<rect width="${width}" height="${height}" fill="${fill.startsWith('coreGlow') ? 'url(#coreGlow)' : '#' + fill.toLowerCase()}"/>`;
    } else if (type === 'f') {
      const [fill, coords] = rest;
      console.log('Processing fill group:', fill, 'with coords:', coords); // Debug: Log fill and coords
      const circleData = coords.split(',').map(Number);
      let currentCx = 0, currentCy = 0, currentR = 0;
      for (let i = 0; i < circleData.length; i += 4) {
        const opacity = circleData[i] / 10;
        const deltaCx = circleData[i + 1];
        const deltaCy = circleData[i + 2];
        const deltaR = circleData[i + 3];
        if (i === 0) {
          // First circle in group uses absolute coordinates
          currentCx = deltaCx;
          currentCy = deltaCy;
          currentR = deltaR;
        } else {
          // Subsequent circles use deltas from previous
          currentCx += deltaCx;
          currentCy += deltaCy;
          currentR += deltaR;
        }
        // Ensure fill is properly formatted as a lowercase hex color
        const fillValue = isValidHex(fill) ? '#' + fill.toLowerCase() : (fill.startsWith('coreGlow') ? 'url(#coreGlow)' : '#' + fill.toLowerCase());
        // Adjust opacity for yellow circles (fill="#94ad30") to make them visible if needed
        const effectiveOpacity = fillValue === '#94ad30' && opacity === 0 ? 0.1 : opacity; // Set to 0.1 if opacity is 0 for yellow
        console.log('Generating circle with fill:', fillValue, 'cx:', currentCx, 'cy:', currentCy, 'r:', currentR, 'opacity:', effectiveOpacity); // Debug: Log each circle
        svg += `<circle cx="${currentCx}" cy="${currentCy}" r="${currentR}" fill="${fillValue}" opacity="${effectiveOpacity}"/>`;
      }
    } else if (type === 'g') {
      const [id, stops] = rest;
      defs = '<defs><radialGradient id="' + id + '">';
      stops.split(',').forEach((part, index) => {
        if (index % 3 === 0) {
          const offset = part;
          const color = stops.split(',')[index + 1];
          const opacity = stops.split(',')[index + 2] / 10;
          defs += `<stop offset="${offset}%" stop-color="#${color.toLowerCase()}" stop-opacity="${opacity}"/>`;
        }
      });
      defs += '</radialGradient></defs>';
    }
  });

  if (defs) svg += defs;
  svg += '</g></svg>';
  return svg;
}

function processCompressed() {
  const inputDir = path.join(__dirname, 'compressed');
  const outputDir = path.join(__dirname, 'decompressed');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

  fs.readdirSync(inputDir).forEach(file => {
    if (file.endsWith('.txt')) {
      const compressedPath = path.join(inputDir, file);
      const compressedContent = fs.readFileSync(compressedPath, 'utf8');
      const decompressed = decompressSVG(compressedContent);
      const outputPath = path.join(outputDir, `${file.replace('.txt', '')}.svg`);
      fs.writeFileSync(outputPath, decompressed);
      console.log(`Decompressed ${file} to ${outputPath}`);
    }
  });
}

processCompressed();