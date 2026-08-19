import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';

import './globals.css';

/**
 * Three faces, each with one job. See globals.css for the reasoning; briefly:
 *
 *   Archivo         column labels, set uppercase and tracked out the way a form labels its columns
 *   IBM Plex Sans   prose
 *   IBM Plex Mono   every duration, time and date, with tabular figures so columns align on the digit
 *
 * Self-hosted by next/font, which means no request to Google at run time — worth having when the
 * pages in question display window titles and images of people's screens.
 */
const archivo = Archivo({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-archivo',
  weight: ['500', '600', '700'],
});

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-plex-sans',
  weight: ['400', '500', '600'],
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-plex-mono',
  weight: ['400', '500'],
});

export const metadata: Metadata = {
  title: {
    default: 'WorkLens',
    template: '%s · WorkLens',
  },
  description: 'Timesheets and activity records for a single company deployment.',
  // Nothing here should ever be indexed: every page is behind authentication and shows one
  // organisation's employee data.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // The only place a colour is written as a literal rather than taken from a token. `themeColor`
  // becomes a <meta> tag read by the browser chrome, so it cannot reference a CSS custom property —
  // it must match --color-paper in globals.css by hand.
  // eslint-disable-next-line no-restricted-syntax
  themeColor: '#f7f8f5',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en-AU" className={`${archivo.variable} ${plexSans.variable} ${plexMono.variable}`}>
      <body className="min-h-dvh bg-paper text-ink antialiased">
        {/* First in the tab order. The register's tables are long, and a keyboard user should not
            have to traverse a navigation column to reach the row they came for. */}
        <a
          href="#register"
          className="label sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:border focus:border-ink focus:bg-slip focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
