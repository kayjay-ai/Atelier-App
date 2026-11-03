import type { PropsWithChildren } from 'react'
import { ScrollViewStyleReset } from 'expo-router/html'

// Web-only HTML shell (static output). Adds the Quasar's Atelier icons so the
// browser tab and "Add to Home Screen" (iPad: apple-touch-icon, Android:
// manifest) show the gold Q on a dark tile, matching the native app icon.
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <title>Quasar's Atelier</title>
        <meta name="theme-color" content="#FAF8F5" />
        {/* ?v= busts Safari's icon cache when the artwork changes */}
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-title" content="Atelier" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  )
}
