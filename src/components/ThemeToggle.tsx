'use client';

import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [dark, setDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored === 'dark' || (!stored && prefersDark);
    setDark(isDark);
    document.documentElement.classList.toggle('dark', isDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  if (!mounted) {
    return <div className={`w-11 h-11 ${className}`} />;
  }

  return (
    <button
      onClick={toggle}
      className={`w-11 h-11 flex items-center justify-center rounded-full text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-black/[0.05] dark:hover:bg-white/[0.08] active:scale-95 transition-all duration-200 ease-out ${className}`}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle theme"
    >
      <span key={dark ? 'light' : 'dark'} className="message-fade-in">
        {dark ? <Sun size={19} /> : <Moon size={19} />}
      </span>
    </button>
  );
}
