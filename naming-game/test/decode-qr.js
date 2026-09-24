// Decodes a PNG QR code: node test/decode-qr.js file.png
const fs = require('fs');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const png = PNG.sync.read(fs.readFileSync(process.argv[2]));
const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
process.stdout.write(code ? code.data : '');
