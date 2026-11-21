import 'fake-indexeddb/auto'

// Minimal Canvas/ImageData polyfill for jsdom unit tests when needed
if (typeof globalThis.ImageData === 'undefined') {
  class PolyfillImageData {
    data: Uint8ClampedArray
    width: number
    height: number
    colorSpace: PredefinedColorSpace = 'srgb'
    constructor(dataOrWidth: Uint8ClampedArray | number, widthOrHeight: number, height?: number) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth
        this.height = widthOrHeight
        this.data = new Uint8ClampedArray(this.width * this.height * 4)
      } else {
        this.data = dataOrWidth
        this.width = widthOrHeight
        this.height = height ?? Math.floor(dataOrWidth.length / 4 / widthOrHeight)
      }
    }
  }
  // @ts-expect-error polyfill for test environment
  globalThis.ImageData = PolyfillImageData
}

// Polyfill CSS.escape for React 19 <ViewTransition> in jsdom
if (typeof globalThis.CSS === 'undefined') {
  // @ts-expect-error polyfill for test environment
  globalThis.CSS = {
    escape: (ident: string) => String(ident).replace(/[^a-zA-Z0-9_-]/g, '\\$&'),
  }
} else if (typeof globalThis.CSS.escape !== 'function') {
  globalThis.CSS.escape = (ident: string) =>
    String(ident).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

