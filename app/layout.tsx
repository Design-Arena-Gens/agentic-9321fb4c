'use client';

import './globals.css';
import { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar">
      <head>
        <title>أداة مونتاج الفيديو</title>
        <meta name="description" content="أداة ويب بسيطة لتحرير وتجميع مقاطع الفيديو." />
      </head>
      <body>{children}</body>
    </html>
  );
}
