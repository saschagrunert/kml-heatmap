/**
 * Type definitions for dom-to-image library
 */

interface DomToImageOptions {
  quality?: number;
  bgcolor?: string;
  width?: number;
  height?: number;
  style?: Record<string, string>;
  filter?: (node: Node) => boolean;
}

interface DomToImage {
  toBlob(node: HTMLElement, options?: DomToImageOptions): Promise<Blob>;
  toPng(node: HTMLElement, options?: DomToImageOptions): Promise<string>;
  toJpeg(node: HTMLElement, options?: DomToImageOptions): Promise<string>;
  toSvg(node: HTMLElement, options?: DomToImageOptions): Promise<string>;
}

declare global {
  interface Window {
    domtoimage?: DomToImage;
  }
}

export {};
