import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Terminal — sign in',
  description: 'Private self-hosted workspace. Sign in with Google to continue to Terminal.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
