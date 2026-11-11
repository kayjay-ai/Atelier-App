import type { PropsWithChildren } from 'react'
import { ScrollViewStyleReset } from 'expo-router/html'

// Web-only HTML shell (static output). Adds the Quasar's Atelier icons so the
// browser tab and "Add to Home Screen" (iPad: apple-touch-icon, Android:
// manifest) show the gold Q on a dark tile, matching the native app icon.
//
// It also loads the typefaces (lib/theme.ts): Montserrat 400/500/600 and
// Italiana, subset to Latin + ₹ in public/fonts (SIL OFL, licences alongside),
// as one family each so CSS font-weight picks the right file.

const FACES = [
  ['Montserrat', 400, 'montserrat-400'],
  ['Montserrat', 500, 'montserrat-500'],
  ['Montserrat', 600, 'montserrat-600'],
  ['Italiana', 400, 'italiana-400'],
] as const

const css = `
${FACES.map(([family, weight, file]) => `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:swap;src:url("/fonts/${file}.woff") format("woff");}`).join('\n')}
/* Montserrat has no bold; ask for 700 and get the semibold file, not a smeared copy. */
@font-face{font-family:"Montserrat";font-style:normal;font-weight:700;font-display:swap;src:url("/fonts/montserrat-600.woff") format("woff");}
html,body{background:#FAF8F5;}
body{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;font-feature-settings:"lnum" 1;}
::selection{background:#E9E0CF;color:#2A2725;}
/* Italiana's hairlines thin out at small sizes; firm them up (lib/ui displayProps). */
[data-display]{-webkit-text-stroke:0.25px currentColor;}
[data-display="md"]{-webkit-text-stroke:0.4px currentColor;}
[data-display="sm"]{-webkit-text-stroke:0.6px currentColor;}
/* Keyboard focus: a charcoal ring on anything you can tab to. Fields draw their own. */
[tabindex]:focus{outline:none;}
[tabindex]:focus-visible,a:focus-visible,button:focus-visible{outline:2px solid #423D3A;outline-offset:2px;}
input:focus-visible,textarea:focus-visible{outline:none;}
input::placeholder,textarea::placeholder{color:#9C958F;opacity:1;}
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important;scroll-behavior:auto !important;}
}
`

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
        <title>Quasar's Atelier</title>
        <meta name="description" content="See any piece on you before you buy it: virtual try-on, your size and an honest verdict." />
        <meta name="theme-color" content="#FAF8F5" />
        {/* ?v= busts Safari's icon cache when the artwork changes */}
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=2" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-title" content="Atelier" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="preload" href="/fonts/montserrat-400.woff" as="font" type="font/woff" crossOrigin="" />
        <link rel="preload" href="/fonts/montserrat-600.woff" as="font" type="font/woff" crossOrigin="" />
        <link rel="preload" href="/fonts/italiana-400.woff" as="font" type="font/woff" crossOrigin="" />
        <ScrollViewStyleReset />
        <style id="atelier-base" dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
