import type { Metadata } from 'next'
import { Inter } from 'next/font/google'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Nivoscan App',
  description: 'Munkalap és riport kezelő rendszer',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="hu">
      <head>
        {/* Mobil vonalkódolvasó könyvtár */}
        <script 
          src="https://unpkg.com/html5-qrcode" 
          type="text/javascript" 
          defer
        ></script>
        
        {/* PDF generáló könyvtárak (jspdf és autotable) */}
        <script 
          src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js" 
          defer
        ></script>
        <script 
          src="https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js" 
          defer
        ></script>
        
        {/* Excel generáló könyvtár (SheetJS) */}
        <script 
          src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js" 
          defer
        ></script>
      </head>
      <body className={inter.className}>{children}</body>
    </html>
  )
}
