import type { Metadata, Viewport } from "next";
import { Golos_Text } from "next/font/google";
import "./globals.css";

const golos = Golos_Text({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-golos",
  display: "swap",
  // If Google Fonts is unreachable the CSS stack in globals.css falls back to system fonts.
  fallback: ["system-ui", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  title: { default: "Founder Cockpit", template: "%s · Founder Cockpit" },
  description: "Asqa Zou group — founders' cockpit",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F6F4" },
    { media: "(prefers-color-scheme: dark)", color: "#0F1411" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={golos.variable} suppressHydrationWarning>
      <head>
        {/* Prevent flash of wrong theme on load: read localStorage before first paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("fc-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-dvh text-[14px] leading-5">{children}</body>
    </html>
  );
}
