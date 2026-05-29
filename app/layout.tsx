import type { Metadata } from "next";
// Global newspaper/atelier stylesheet, extracted byte-for-byte from the bundle
// (only @font-face src paths rewritten to the self-hosted /fonts/*.woff2).
import "./styles.css";

export const metadata: Metadata = {
  title: "Etesia Research — Stellar Portfolio Builder",
  description: "Risk-parity allocation across a Stellar asset universe.",
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
