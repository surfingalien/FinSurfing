import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Glassmorphism Portfolio",
  description: "AI Stock Portfolio Tracker",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
