import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import './i18n'
import { installDsGuiBridge } from './rcode/ds-gui-web'

installDsGuiBridge()

document.documentElement.dataset.platform = window.dsGui?.platform ?? 'unknown'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
