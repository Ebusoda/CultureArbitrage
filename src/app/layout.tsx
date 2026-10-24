import type { Metadata } from "next";
import { Figtree, Geist_Mono } from "next/font/google";
import "./globals.css";

// Garden theme. Figtree is a warm, rounded sans: bold for headings, regular for everything else.
// It is a variable font, so every weight comes from one file.
const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

// Geist Mono sets the agent log and the figures. Its soft, round shapes sit well beside Figtree.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const description =
  "An autonomous agent that finds what your city is missing: it pairs neighbourhoods with their taste twins in other cities using Qloo taste data, then tries to prove each gap wrong.";

export const metadata: Metadata = {
  title: "Culture Arbitrage: find what your city is missing",
  description,
  openGraph: { title: "Culture Arbitrage", description },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // Browser extensions add attributes to <html>; don't warn about those.
      suppressHydrationWarning
      className={`${figtree.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col text-[14px] leading-normal md:text-[15px]">{children}</body>
    </html>
  );
}
