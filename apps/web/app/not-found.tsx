import Link from 'next/link';
import { Card } from '../components/ui/card';

export default function NotFound() {
  return (
    <Card className="mx-auto max-w-md space-y-3 p-8 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you are looking for does not exist or has been moved.</p>
      <Link href="/" className="inline-block text-sm font-medium text-primary hover:underline">
        Go to the dashboard
      </Link>
    </Card>
  );
}
