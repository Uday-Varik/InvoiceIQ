'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section>
      <h1>Something went wrong</h1>
      <p className="muted">An unexpected error occurred. This has been logged.</p>
      <div className="buttons">
        <button className="btn btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </section>
  );
}
