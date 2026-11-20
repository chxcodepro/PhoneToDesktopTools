import type { P2DApi } from '../shared/types';

declare global {
  interface Window {
    p2d: P2DApi;
  }
}

export {};
