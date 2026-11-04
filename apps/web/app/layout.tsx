import './globals.css';
import type { Metadata } from 'next';
import { AppProvider } from '@/lib/ctx';
import { Header, Footer } from '@/components/Shell';
import { Popups } from '@/components/Popups';

export const metadata: Metadata = { title: 'Аукцион тип 1 — дома и квартиры в Армении', description: 'Закрытый аукцион одной ставки' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hy">
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
