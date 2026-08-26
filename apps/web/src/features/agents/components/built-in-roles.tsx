import { Copy, Eye } from 'lucide-react';

import { Button } from '../../../ui/primitives/button';
import type { BrowserRole } from '../agents-queries';

export function BuiltInRoles({
  roles,
  onDuplicate,
  onView,
}: {
  roles: BrowserRole[];
  onDuplicate: (role: BrowserRole) => void;
  onView: (role: BrowserRole) => void;
}) {
  return (
    <section className="grid gap-3 border-b border-border p-4">
      <h2 className="m-0 text-sm font-semibold">Built-in roles</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {roles.map((role) => (
          <div className="rounded-md border border-border p-3" key={role.id}>
            <p className="m-0 text-sm font-medium">{role.name}</p>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onView(role)}
              >
                <Eye size={15} aria-hidden="true" /> View prompt
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onDuplicate(role)}
              >
                <Copy size={15} aria-hidden="true" /> Make custom copy
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
