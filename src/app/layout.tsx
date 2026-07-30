import type { Metadata } from 'next';
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
        <main>{children}</main>
      </body>
    </html>
  );
}
