'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Slow fade-and-brighten reveal on scroll, plus an optional scroll-focus
 * state: when `focus` is set, the block takes the accent while its heading
 * sits near the centre of the viewport, and settles back as it leaves.
 * Everything is visible immediately when the user prefers reduced motion.
 */
export function Reveal({
  children,
  className = '',
  focus = false,
  as = 'div',
}: {
  children: ReactNode;
  className?: string;
  focus?: boolean;
  as?: 'div' | 'li' | 'article';
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.classList.add('mx-visible');
      if (focus) el.classList.add('mx-focused');
      return;
    }
    const enter = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.classList.add('mx-visible');
            enter.disconnect();
          }
        }
      },
      { threshold: 0.12 },
    );
    enter.observe(el);

    let focusObserver: IntersectionObserver | undefined;
    if (focus) {
      focusObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            el.classList.toggle('mx-focused', entry.isIntersecting);
          }
        },
        { rootMargin: '-42% 0px -48% 0px' },
      );
      focusObserver.observe(el);
    }
    return () => {
      enter.disconnect();
      focusObserver?.disconnect();
    };
  }, [focus]);

  const setRef = (el: HTMLElement | null) => {
    ref.current = el;
  };
  const revealClass = `mx-reveal ${className}`;

  if (as === 'li') {
    return (
      <li ref={setRef} className={revealClass}>
        {children}
      </li>
    );
  }
  if (as === 'article') {
    return (
      <article ref={setRef} className={revealClass}>
        {children}
      </article>
    );
  }
  return (
    <div ref={setRef} className={revealClass}>
      {children}
    </div>
  );
}
