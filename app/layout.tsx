import type { Metadata } from "next";
// Global newspaper/atelier stylesheet, extracted byte-for-byte from the bundle
// (only @font-face src paths rewritten to the self-hosted /fonts/*.woff2).
import "./styles.css";

export const metadata: Metadata = {
  title: "Etesia Research — Stellar Portfolio Builder",
  description: "Risk-parity allocation across a Stellar asset universe.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: "/apple-icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
