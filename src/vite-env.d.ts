/// <reference types="vite/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react'
import type { DsGuiApi } from './shared/ds-gui-api'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        allowpopups?: string
        partition?: string
        src?: string
        webpreferences?: string
      }
    }
  }
}

declare global {
  interface Window {
    dsGui: DsGuiApi
  }
}

export {}
