import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Renders a slug-y identifier (kebab-case, snake_case, or camelCase) as a
// human-readable label, e.g. "pdf-summarizer" / "pdf_summarizer" -> "Pdf
// Summarizer". Words already separated by spaces pass through unchanged
// aside from capitalization.
export function titleCaseLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
