import type { Metadata } from 'next';
import { Outfit, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const outfit = Outfit({
  subsets: ['latin'],
  variable: '--font-outfit',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'RateShield — Distributed Rate Limiter Dashboard',
  description: 'Real-time telemetry, rate limit token inspection, and interactive traffic burst testing for RateShield.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${outfit.variable} ${jetbrainsMono.variable} font-sans antialiased bg-[#07090e] text-[#f8fafc]`}>
        <div className="bg-glow-primary" />
        <div className="bg-glow-cyan" />
        <div className="bg-grid-pattern" />
        <div className="relative z-10 min-h-screen flex flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
