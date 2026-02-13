import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';

// Convert the logo to a proper 256x256 PNG first, then to ICO
const pngBuffer = await sharp('public/logo.png')
    .resize(256, 256)
    .png()
    .toBuffer();

// Save the clean PNG (for web use)
writeFileSync('public/logo-256.png', pngBuffer);

// Convert to ICO
const icoBuffer = await pngToIco(pngBuffer);
writeFileSync('public/favicon.ico', icoBuffer);

console.log('✅ favicon.ico created (256x256)');
console.log('✅ logo-256.png created (clean PNG)');
