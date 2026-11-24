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

// Polyfill PointerEvent in jsdom so pointerType ('mouse' | 'touch' | 'pen') and pointerId are preserved
if (typeof globalThis.PointerEvent === 'undefined') {
  class PolyfillPointerEvent extends MouseEvent {
    pointerId: number
    pointerType: string
    isPrimary: boolean
    constructor(
      type: string,
      params: PointerEventInit & { pointerId?: number; pointerType?: string } = {}
    ) {
      super(type, params)
      this.pointerId = params.pointerId ?? 1
      this.pointerType = params.pointerType ?? 'mouse'
      this.isPrimary = params.isPrimary ?? true
    }
  }
  // @ts-expect-error polyfill for jsdom
  globalThis.PointerEvent = PolyfillPointerEvent
}

// Minimal 2D Canvas & URL.createObjectURL mock for jsdom tests
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => {
    return {
      save: () => {},
      restore: () => {},
      scale: () => {},
      translate: () => {},
      setTransform: () => {},
      resetTransform: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      rect: () => {},
      clip: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fill: () => {},
      arc: () => {},
      setLineDash: () => {},
      putImageData: () => {},
      drawImage: () => {},
      strokeText: () => {},
      fillText: () => {},
      measureText: (txt: string) => ({ width: txt.length * 6 }),
      imageSmoothingEnabled: false,
    } as unknown as CanvasRenderingContext2D
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext
}

if (typeof URL !== 'undefined') {
  if (!URL.createObjectURL) {
    URL.createObjectURL = () => 'blob:mock-url'
  }
  if (!URL.revokeObjectURL) {
    URL.revokeObjectURL = () => {}
  }
}


