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
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      rowStart + 1
    )
  }

  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

// Official dotdot 32x32 pixel-art app icon palette (night sky, stars, crescent moon, black cat & "dotdot" logo)
const PAL = {
  P: { hex: '#7964A5', rgba: [121, 100, 165, 255] }, // Night sky purple
  D: { hex: '#31253C', rgba: [49, 37, 60, 255] },    // Dark hill & cat silhouette
  W: { hex: '#FDF1FF', rgba: [253, 241, 255, 255] }, // Crisp starlight & cat outline
  C: { hex: '#E8DEF1', rgba: [232, 222, 241, 255] }, // Crescent moon & clouds
  R: { hex: '#B47E8C', rgba: [180, 126, 140, 255] }, // Dusty rose "dotdot" lettering
}

const GRID_32 = [
  'PPPPWPPPPPPPWPPPPPCCCCCCPPPPPPPP',
  'PPPPPPPWPPPPPPPPPPCCCCCCPWPPPPPP',
  'PPPPPPWPWWPPPPPWPPPCCCCCWDWPPPPP',
  'PPPPPPPPWWWPPPWDWPPCCCCWDDWPPPPP',
  'PPPPPPPPPWWPWPWDDWPWWWWDDDWPPPPP',
  'PPPPPPPPPWWWPPWDDDWDDDDDDWPPPPPP',
  'PPPPPPWPPWWWPPCWDDDDDDDDDWPPPPPP',
  'PPPPPPPPPWWWPCPWDDDDDDDDDWCPPPPP',
  'WPPPWPPPWWWWCPCWDDDDDDDDDDWCPPPP',
  'PPPPPPPPWWWCPCPWDDDDDDDDDDWCPPPP',
  'WWPPPPWWCCCCCCCWDDDDDDDDDDWPCPPP',
  'WWWCCCCCCCCCCCCCWDDDDDDDDWCCCCPP',
  'PWCCCCCCCCCCCCCCWDDDDDDDDWCCCCPP',
  'PPPWWWWWCCCCCCCCCWWDDDDDWPPPPPPP',
  'PPWPPPWPPPWPPPPPPWDDDDDDDWPPPPPP',
  'PPPPPPPPPPPPPPPPWDDDDDDDDWPPPWPP',
  'PPPPWPPPPPPPPPPPWDDDDDDDDDWPWDWP',
  'PPPPPPPPPPPPPPPWDDDDDDDDDDWPPWDW',
  'PPPPPPPPPPPPPPWDDDDDDDDDDDDWPPWD',
  'PPPPPPPPPPDDDDWDDDDDDDDDDDDWPPWD',
  'PPPPPPPPDDDDDDWDDDDDDDDDDDDWPDWD',
  'PPPPPPDDDDDDDDDWDDDDDDDDDDDWWWDW',
  'DPPPDDDDDDDDDDDWDDDDDDDDDDWWDDWD',
  'DDDDDDDDDDDDDDDDWDDDDDDDDDDDWWDD',
  'DDDDDDDDDDDDDDDDDWWWWWWWWWWWDDDD',
  'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
  'DDDDDDRDDDDDDRDDDDDRDDDDDDRDDDDD',
  'DDDDDDRDDDDDRRRDDDDRDDDDDRRRDDDD',
  'DDDDDRRDDRDDDRDDDDRRDDRDDDRDDDDD',
  'DDDDRDRDRDRDDRDDDRDRDRDRDDRDDDDD',
  'DDDDDRDDDRDDDRDDDDRDDDRDDDRDDDDD',
  'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
]

// Official 32x8 "dotdot" pixel wordmark logo
const WORDMARK_32X8 = [
  '................................',
  '................................',
  '......R......R.....R......R.....',
  '......R.....RRR....R.....RRR....',
  '.....RR..R...R....RR..R...R.....',
  '....R.R.R.R..R...R.R.R.R..R.....',
  '.....R...R...R....R...R...R.....',
  '................................',
]

function buildRunLengthSvgRects(grid, colorResolver, skipChar = null) {
  const lines = []
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]
    let x = 0
    while (x < row.length) {
      const ch = row[x]
      let end = x + 1
      while (end < row.length && row[end] === ch) end++
      if (ch !== skipChar) {
        const hex = colorResolver(ch)
        lines.push(
          `  <rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex}"/>`
        )
      }
      x = end
    }
  }
  return lines.join('\n')
}

function generateFaviconSvg() {
  // Base rect covers dark hill color D, then horizontal run-length rects draw P, W, C, R cleanly
  const rects = buildRunLengthSvgRects(
    GRID_32,
    (ch) => (PAL[ch] || PAL.D).hex,
    'D'
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">\n  <rect width="32" height="32" fill="${PAL.D.hex}"/>\n${rects}\n</svg>\n`
}

function generateWordmarkSvg() {
  const rects = buildRunLengthSvgRects(
    WORDMARK_32X8,
    () => PAL.R.hex,
    '.'
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 8" shape-rendering="crispEdges">\n${rects}\n</svg>\n`
}

function renderIconToSize(targetSize, maskable = false) {
  const out = new Uint8Array(targetSize * targetSize * 4)

  if (!maskable && targetSize % 32 === 0) {
    // Exact integer nearest-neighbor scale (32->1x, 192->6x, 512->16x)
    const pixelScale = targetSize / 32
    for (let gy = 0; gy < 32; gy++) {
      for (let gx = 0; gx < 32; gx++) {
        const ch = GRID_32[gy][gx]
        const rgba = (PAL[ch] || PAL.D).rgba
        for (let py = 0; py < pixelScale; py++) {
          const y = gy * pixelScale + py
          for (let px = 0; px < pixelScale; px++) {
            const x = gx * pixelScale + px
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

  // For maskable / non-multiple sizes (e.g. 180x180 apple-touch-icon, 512x512 maskable):
  // Extend sky purple in the top half and dark hill in the bottom half so there is never an artificial border!
  const usable = maskable ? Math.floor(targetSize * 0.76) : targetSize
  const pixelScale = Math.max(1, Math.floor(usable / 32))
  const artSpan = pixelScale * 32
  const offset = Math.floor((targetSize - artSpan) / 2)
  const horizonY = offset + 22 * pixelScale

  for (let y = 0; y < targetSize; y++) {
    const bg = y < horizonY ? PAL.P.rgba : PAL.D.rgba
    for (let x = 0; x < targetSize; x++) {
      const idx = (y * targetSize + x) * 4
      out[idx] = bg[0]
      out[idx + 1] = bg[1]
      out[idx + 2] = bg[2]
      out[idx + 3] = 255
    }
  }

  for (let gy = 0; gy < 32; gy++) {
    for (let gx = 0; gx < 32; gx++) {
      const ch = GRID_32[gy][gx]
      const rgba = (PAL[ch] || PAL.D).rgba
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

const publicDir = path.resolve('public')
const outDir = path.resolve('public/icons')
fs.mkdirSync(outDir, { recursive: true })

fs.writeFileSync(path.join(publicDir, 'favicon.svg'), generateFaviconSvg())
fs.writeFileSync(path.join(publicDir, 'logo-wordmark.svg'), generateWordmarkSvg())
fs.writeFileSync(path.join(outDir, 'favicon-32.png'), renderIconToSize(32, false))
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), renderIconToSize(180, false))
fs.writeFileSync(path.join(outDir, 'icon-192.png'), renderIconToSize(192, false))
fs.writeFileSync(path.join(outDir, 'icon-512.png'), renderIconToSize(512, false))
fs.writeFileSync(path.join(outDir, 'icon-maskable-512.png'), renderIconToSize(512, true))

console.log('Generated crisp 32x32 cat-and-moon favicon.svg, logo-wordmark.svg, and PWA icons in public/icons/')
