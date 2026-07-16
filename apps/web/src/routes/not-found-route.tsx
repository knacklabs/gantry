import { Compass } from 'lucide-react';
import { Link } from '@tanstack/react-router';

import { PageState } from '../ui/compositions/page-state';

export function NotFoundRoute() {
  return (
    <div>
      <h1 className="sr-only">View not found</h1>
      <PageState
        action={
          <Link
            className="inline-flex min-h-9 items-center justify-center rounded-md border border-ink bg-ink px-3 text-[13px] font-semibold text-ink-on no-underline hover:bg-ink-hover"
            to="/"
          >
            Back home
          </Link>
        }
        description="The requested view is not available."
        icon={<Compass size={22} aria-hidden="true" />}
        kind="empty"
        title="View not found"
      />
    </div>
  );
}
