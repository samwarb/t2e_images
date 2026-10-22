import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "T2E Image Library",
  description: "Upload, organise and share product images by sector.",
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
