import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Gantry Next.js Workflows',
  description: 'Runnable Gantry SDK and Direct LLM API workflows',
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
