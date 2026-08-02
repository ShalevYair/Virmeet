import type { Metadata } from 'next';
import { Sidebar } from '@/components/Sidebar';
import { SeedBoot } from '@/components/SeedBoot';
import { seedUrl } from '@/lib/base-path';
import './globals.css';

// The live site's real origin+path (GitHub Pages serves this repo from the
// /Virmeet subpath — see next.config.ts's basePath). Hardcoded rather than
// derived, same as the README already hardcodes this URL: link-preview
// scrapers (WhatsApp, etc.) only ever fetch the real deployed page, so this
// only needs to be correct for that one, known deployment.
const SITE_URL = `https://shalevyair.github.io${process.env.NEXT_PUBLIC_BASE_PATH || ''}/`;

const TITLE = 'Virmeet';
const DESCRIPTION = 'כלי לסימולציית פגישה עם פרסונות ארגוניות — לפני שהיא קורית באמת.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  // Root-relative (via seedUrl/basePath), not metadataBase-resolved: Next
  // renders this <link> verbatim on every page, and a metadataBase-relative
  // value would resolve against *that page's* URL, breaking on anything but
  // the home page (verified against the static export output).
  icons: { icon: seedUrl('icon.png') },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: './',
    siteName: TITLE,
    images: [{ url: 'og-image.png', width: 1200, height: 630 }],
    locale: 'he_IL',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: ['og-image.png'],
  },
};

const FONT_STACK = "'Segoe UI', 'Arial Hebrew', 'Noto Sans Hebrew', system-ui, sans-serif";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <body style={{ fontFamily: FONT_STACK }}>
        <SeedBoot />
        <Sidebar />
        <main className="ms-56 min-h-screen px-6 py-8 md:px-10">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </body>
    </html>
  );
}
