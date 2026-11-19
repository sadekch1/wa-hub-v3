// يجمّع المحركين (Baileys وكل اعتماداته) في ملف واحد dist/host.js
const esbuild = require('esbuild');
esbuild.build({
    entryPoints: ['src/host.js'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: 'dist/host.js',
    external: ['sharp', 'jimp', 'link-preview-js', 'bufferutil', 'utf-8-validate',
               'audio-decode', 'qrcode-terminal', '@ffmpeg-installer/ffmpeg', 'electron'],
    logLevel: 'warning'
}).then(() => console.log('host bundled → dist/host.js'))
  .catch(() => process.exit(1));
