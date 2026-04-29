import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Riyaaz Dashboard",
  description: "Music shop voice agent dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
