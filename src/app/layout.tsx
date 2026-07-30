import type { Metadata } from 'next';
import { Sidebar } from '@/components/Sidebar';
import { SeedBoot } from '@/components/SeedBoot';
import './globals.css';

export const metadata: Metadata = {
  title: 'Virmeet',
  description: 'כלי לסימולציית פגישה רב-משתתפים',
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
