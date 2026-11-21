import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 4, 'ascii')
  data.copy(out, 8)
  const crc = crc32(out.subarray(4, 8 + data.length))
  out.writeUInt32BE(crc, 8 + data.length)
  return out
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc(height * (1 + stride))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride)
    raw[rowStart] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, rowStart + 1)
  }

  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

// Retro low-saturation pixel-art studio 16x16 icon palette
const PAL = {
  B: [24, 21, 33, 255],    // #181521 deep plum-slate border
  D: [39, 35, 53, 255],    // #272335 retro body
  L: [244, 241, 234, 255], // #F4F1EA warm canvas parchment
  S: [215, 210, 198, 255], // #D7D2C6 canvas shadow
  P: [132, 118, 196, 255], // #8476C4 muted lavender
  T: [87, 155, 145, 255],  // #579B91 calm sage-teal
  R: [196, 115, 136, 255], // #C47388 dusty rose
  G: [224, 169, 109, 255], // #E0A96D warm amber
}

const GRID_16 = [
  'BBBBBBBBBBBBBBBB',
  'BDDDDDDDDDDDDDDB',
  'BDLLLLLLLLLLLLDB',
  'BDLPPPBTTTBLLLDB',
  'BDLPPPBTTTBLLLDB',
  'BDLPPPBTTTBLLLDB',
  'BDLBBBBBBBBLLLDB',
  'BDLRRRBGGGBLLLDB',
  'BDLRRRBGGGBLLLDB',
  'BDLRRRBGGGBLLPDB',
  'BDLLLLLLLLLLPPDB',
  'BDLLLLLLLLLPPPDB',
  'BDSSSSSSSSPPPPDB',
  'BDDDDDDDDDDDDDDB',
  'BDDDDDDDDDDDDDDB',
  'BBBBBBBBBBBBBBBB',
]

function renderIconToSize(targetSize, maskable = false) {
  const out = new Uint8Array(targetSize * targetSize * 4)
  // Fill background with #181521 so maskable safe zone & rounded OS masks look seamless
  for (let i = 0; i < targetSize * targetSize; i++) {
    out[i * 4] = 24
    out[i * 4 + 1] = 21
    out[i * 4 + 2] = 33
    out[i * 4 + 3] = 255
  }

  // For maskable, fit the 16x16 artwork inside the central ~75% safe zone with integer pixel blocks
  const usable = maskable ? Math.floor(targetSize * 0.75) : targetSize
  const pixelScale = Math.max(1, Math.floor(usable / 16))
  const artSpan = pixelScale * 16
  const offset = Math.floor((targetSize - artSpan) / 2)

  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      const ch = GRID_16[gy][gx]
      const rgba = PAL[ch] || PAL.D
      for (let py = 0; py < pixelScale; py++) {
        const y = offset + gy * pixelScale + py
        for (let px = 0; px < pixelScale; px++) {
          const x = offset + gx * pixelScale + px
          const idx = (y * targetSize + x) * 4
          out[idx] = rgba[0]
          out[idx + 1] = rgba[1]
          out[idx + 2] = rgba[2]
          out[idx + 3] = rgba[3]
        }
      }
    }
  }

  return encodePng(out, targetSize, targetSize)
}

const outDir = path.resolve('public/icons')
fs.mkdirSync(outDir, { recursive: true })

fs.writeFileSync(path.join(outDir, 'favicon-32.png'), renderIconToSize(32, false))
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), renderIconToSize(180, true))
fs.writeFileSync(path.join(outDir, 'icon-192.png'), renderIconToSize(192, false))
fs.writeFileSync(path.join(outDir, 'icon-512.png'), renderIconToSize(512, false))
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), renderIconToSize(512, true))

console.log('Generated crisp pixel-art PWA icons in public/icons/')
