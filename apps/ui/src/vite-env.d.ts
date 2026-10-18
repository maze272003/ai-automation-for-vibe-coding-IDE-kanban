/// <reference types="vite/client" />
import type { AikWindowApi } from '@aik/contracts';

declare global {
  interface Window {
    api: AikWindowApi;
  }
}
export {};
