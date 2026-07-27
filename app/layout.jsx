import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata = {
  title: "Getit Control Centre",
  description: "Live orders, support and driver allocation for Getit.",
  icons: {
    icon: "/getit-mark-192.png",
    apple: "/getit-mark-192.png",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
