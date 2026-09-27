import Link from 'next/link';

export default function NotFound() {
  return (
    <section>
      <h1>Page not found</h1>
      <p className="muted">The page you are looking for does not exist or has been moved.</p>
      <p>
        <Link href="/">Go to the dashboard</Link>
      </p>
    </section>
  );
}
