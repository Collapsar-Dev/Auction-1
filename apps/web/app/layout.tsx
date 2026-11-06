import './globals.css';
import type { Metadata } from 'next';
import { AppProvider } from '@/lib/ctx';
import { Header, Footer } from '@/components/Shell';
import { Popups } from '@/components/Popups';

export const metadata: Metadata = { title: 'Аукцион тип 1 — дома и квартиры в Армении', description: 'Закрытый аукцион одной ставки' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hy">
      <head>
        {/* Вариант 8.2: Montserrat; без сети — системный шрифт */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700;800&display=swap" rel="stylesheet" />
        <meta name="theme-color" content="#F7F7F9" />
      </head>
      <body>
        <AppProvider>
          <Header />
          <Popups />
          <main>
            <div className="container">{children}</div>
          </main>
          <Footer />
        </AppProvider>
      </body>
    </html>
  );
}
